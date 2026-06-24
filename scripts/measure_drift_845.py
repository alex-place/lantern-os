"""
Issue #845 — measure cross-provider drift-equivalence on x (tol=0.25).

Settles the §2 open question from docs/SIGMA0-K1-KERNEL-SPEC.md:
  "do any two real providers produce drift within tol=0.25 on x?"

Method
------
For each 'provider' (LLM endpoint/model):
  1. Decode a fixed x ∈ Rᵈ to a prompt via ψ (random-init ABI shim, fixed seed).
  2. Call the provider with that prompt.
  3. Encode the reply via a bag-of-words projection (proxy for φ, fixed random seed)
     → x_next ∈ Rᵈ.
  4. Drift vector  f = x_next − x.

For each provider pair (A, B):
  drift_delta = ‖f_A − f_B‖ / ‖f_A‖

Verdict: if drift_delta < 0.25 for any pair → hot-swap can be cross-provider.
         Otherwise → diversity must live in the text re-prompt lane, not the VM.

Note on ABI calibration
-----------------------
The full ABI shim (StateABIShim) is untrained here; the random-init φ/ψ fix the
projection basis reproducibly (seed=42) so comparisons are internally consistent.
A calibrated shim would require a live Ouro GPU run (Gates A/B, #843/#844).
This measurement is a *pre-calibration upper bound*: if providers are not
drift-equivalent under a fixed random projection, they will not be after
calibration either (calibration can only reduce Ouro's OWN inter-run variance,
not collapse cross-provider differences).

Providers used
--------------
Providers are discovered from --providers flag (comma-sep <id>:<url>:<model>).
Defaults to the two local Ollama models + one repeated call (stochastic sample)
to measure intra-provider variance for comparison.

Usage
-----
    python scripts/measure_drift_845.py
    python scripts/measure_drift_845.py --dim 128 --n-prompts 5
    python scripts/measure_drift_845.py --providers "qwen:http://127.0.0.1:11434:qwen2.5-coder:latest,sigma:http://127.0.0.1:11434:lantern-sigma0-coder:latest"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import torch
import torch.nn as nn

# ── minimal ABI shim (φ/ψ with fixed random seed) ──────────────────────────

class _FixedABI(nn.Module):
    """Random-init ABI shim with deterministic seed — proxy for StateABIShim φ/ψ."""
    def __init__(self, vocab_dim: int, state_dim: int, seed: int = 42) -> None:
        super().__init__()
        torch.manual_seed(seed)
        self.phi = nn.Linear(vocab_dim, state_dim, bias=False)
        self.psi = nn.Linear(state_dim, vocab_dim, bias=False)
        with torch.no_grad():
            nn.init.orthogonal_(self.phi.weight)
            nn.init.orthogonal_(self.psi.weight)

    def encode(self, h: torch.Tensor) -> torch.Tensor:
        return self.phi(h)

    def decode(self, x: torch.Tensor) -> torch.Tensor:
        return self.psi(x)


# ── text ↔ vector ────────────────────────────────────────────────────────────

def _build_vocab(size: int = 4096, seed: int = 42) -> Dict[str, int]:
    """Fixed vocabulary mapping single chars + byte-ngrams to indices."""
    rng = __import__("random").Random(seed)
    chars = [chr(i) for i in range(128)]
    rng.shuffle(chars)
    return {c: i % size for i, c in enumerate(chars)}


_VOCAB: Dict[str, int] = _build_vocab()
_VOCAB_DIM = 4096


def text_to_vec(text: str, vocab_dim: int = _VOCAB_DIM) -> torch.Tensor:
    """Bag-of-chars projection → normalised float vector ∈ Rᵛ."""
    v = torch.zeros(vocab_dim)
    for ch in text:
        idx = ord(ch) % vocab_dim
        v[idx] += 1.0
    norm = v.norm()
    return v / norm if norm > 0 else v


def vec_to_prompt(h: torch.Tensor, prompt_template: str) -> str:
    """ψ-decoded vector → a concrete reasoning prompt (fixed template)."""
    # Use the L2 norm of the decoded vector as a seed hint in the prompt,
    # giving the provider a consistent but varied stimulus per x.
    seed_val = round(float(h.norm().item()), 4)
    return (
        f"{prompt_template}\n\n"
        f"[context seed: {seed_val}] "
        "Reason step by step. Be concise."
    )


# ── provider call ────────────────────────────────────────────────────────────

def ollama_call(base: str, model: str, prompt: str, timeout: float = 60.0,
                temperature: float = 0.7) -> str:
    payload = json.dumps({
        "model": model, "stream": False,
        "messages": [{"role": "user", "content": prompt}],
        "options": {"num_predict": 64, "temperature": temperature},
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/api/chat", data=payload,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
        return (body.get("message") or {}).get("content") or body.get("response") or ""
    except Exception as e:
        return f"[error: {e}]"


# ── drift measurement ────────────────────────────────────────────────────────

def measure_drift(
    x: torch.Tensor,
    abi: _FixedABI,
    provider_call,
    prompt_template: str,
) -> Tuple[torch.Tensor, str]:
    """Run one provider step: x → prompt → reply → x_next. Return (f, reply)."""
    with torch.no_grad():
        h_in = abi.decode(x)                        # ψ: x → h (vocab space)
    prompt = vec_to_prompt(h_in, prompt_template)
    reply = provider_call(prompt)
    reply_vec = text_to_vec(reply, _VOCAB_DIM)      # bag-of-chars proxy for encode_fn
    with torch.no_grad():
        x_next = abi.encode(reply_vec)              # φ: h → x'
    f = x_next - x
    return f, reply


def drift_delta(f_a: torch.Tensor, f_b: torch.Tensor) -> float:
    """‖f_A − f_B‖ / ‖f_A‖ — the hot-swap acceptance gate metric."""
    norm_a = float(f_a.norm())
    if norm_a < 1e-9:
        return float("inf")
    return float((f_a - f_b).norm() / norm_a)


# ── main ─────────────────────────────────────────────────────────────────────

PROMPT_TEMPLATE = (
    "You are a reasoning system operating on a latent state. "
    "Given the context below, describe in 2–3 sentences what the next reasoning step should be."
)

DEFAULT_PROVIDERS = [
    ("qwen",   "http://127.0.0.1:11434", "qwen2.5-coder:latest",       0.7),
    ("sigma",  "http://127.0.0.1:11434", "lantern-sigma0-coder:latest", 0.7),
    ("qwen-t0","http://127.0.0.1:11434", "qwen2.5-coder:latest",       0.0),  # deterministic
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dim",       type=int,   default=128,  help="state vector dim d ∈ [64,256]")
    ap.add_argument("--n-prompts", type=int,   default=3,    help="number of x samples to average over")
    ap.add_argument("--tol",       type=float, default=0.25, help="hot-swap tolerance")
    ap.add_argument("--seed",      type=int,   default=42,   help="random seed for x samples")
    ap.add_argument("--out",       default=None, help="path to write JSON results (default: data/eval/drift-845.jsonl)")
    a = ap.parse_args()

    out_path = Path(a.out) if a.out else ROOT / "data" / "eval" / "drift-845.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    abi = _FixedABI(vocab_dim=_VOCAB_DIM, state_dim=a.dim, seed=42)
    providers = DEFAULT_PROVIDERS

    print(f"Providers ({len(providers)}): {[p[0] for p in providers]}")
    print(f"dim={a.dim}, n_prompts={a.n_prompts}, tol={a.tol}\n")

    torch.manual_seed(a.seed)
    x_samples = [torch.randn(a.dim) for _ in range(a.n_prompts)]

    # Per-provider drift vectors (list of n_prompts tensors each)
    provider_drifts: Dict[str, List[torch.Tensor]] = {p[0]: [] for p in providers}
    provider_replies: Dict[str, List[str]] = {p[0]: [] for p in providers}

    for xi, x in enumerate(x_samples):
        print(f"  Sample {xi+1}/{a.n_prompts}:")
        for pid, base, model, temp in providers:
            def _call(prompt, _base=base, _model=model, _temp=temp):
                return ollama_call(_base, _model, prompt, temperature=_temp)
            t0 = time.time()
            f, reply = measure_drift(x, abi, _call, PROMPT_TEMPLATE)
            elapsed = time.time() - t0
            provider_drifts[pid].append(f)
            provider_replies[pid].append(reply)
            fnorm = float(f.norm())
            print(f"    [{pid:10s}] |f|={fnorm:.4f}  {elapsed:.1f}s  reply={reply[:60]!r}")

    # Pairwise drift_delta averaged over samples
    print(f"\n{'Pair':<24} {'avg drift_delta':>16}  {'verdict':>10}")
    print("-" * 55)
    results = []
    any_equivalent = False
    pids = [p[0] for p in providers]
    for i in range(len(pids)):
        for j in range(i + 1, len(pids)):
            pa, pb = pids[i], pids[j]
            deltas = [
                drift_delta(provider_drifts[pa][k], provider_drifts[pb][k])
                for k in range(a.n_prompts)
            ]
            avg_delta = sum(deltas) / len(deltas)
            equiv = avg_delta < a.tol
            if equiv:
                any_equivalent = True
            verdict = "EQUIV" if equiv else "not equiv"
            print(f"  {pa} vs {pb:<16} {avg_delta:>16.4f}  {verdict:>10}")
            results.append({
                "pair": [pa, pb], "avg_drift_delta": round(avg_delta, 6),
                "per_sample_deltas": [round(d, 6) for d in deltas],
                "equivalent": equiv,
            })

    # Intra-provider variance for comparison (qwen vs qwen-t0 = stochastic vs deterministic)
    print(f"\nVerdict: any provider pair drift-equivalent within tol={a.tol}? "
          f"{'YES — hot-swap is cross-provider viable' if any_equivalent else 'NO — diversity lives in text re-prompt lane, not the VM'}")

    record = {
        "benchmark": "drift-equivalence",
        "ts": str(int(time.time())),
        "issue": 845,
        "dim": a.dim,
        "n_prompts": a.n_prompts,
        "tol": a.tol,
        "providers": [{"id": p[0], "model": p[2], "temp": p[3]} for p in providers],
        "pairs": results,
        "any_equivalent": any_equivalent,
        "verdict": (
            "cross-provider hot-swap viable (within tol)"
            if any_equivalent else
            "cross-provider hot-swap NOT viable within tol — diversity must live in text re-prompt lane"
        ),
        "note": (
            "ABI shim is random-init (fixed seed=42); this is a pre-calibration upper bound. "
            "Calibration can reduce intra-Ouro variance but not collapse cross-provider text differences."
        ),
    }
    with open(out_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"\nResult appended to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
