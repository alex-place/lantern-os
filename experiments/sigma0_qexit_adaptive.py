r"""
sigma0_qexit_adaptive.py — is Ouro's Q-exit genuinely ADAPTIVE? (the core value prop)

Ouro's selling point over a fixed-depth model is *adaptive recurrent-compute*: the trained
early-exit gate should spend MORE recurrent steps on HARDER inputs and fewer on easy ones. That
per-input adaptivity — not just the global depth<->quality knob bench_ouro_loop.py already
measures — is the claim. This tests it directly.

Mechanism (from modeling_ouro.py:769-782, replicated exactly): for each UT step i the gate emits
a logit; lambda_i = sigmoid(gate_i) is the "exit now" hazard; the exit PDF is
  p_i = lambda_i * remaining,   remaining *= (1 - lambda_i),   last step takes all remaining.
The model's own preferred depth for a token is the EXPECTED exit depth  E[d] = sum_i (i+1) * p_i.

We capture `gate_list` (hook output[2]) at the last token for prompts across a difficulty
gradient, compute E[d], and correlate it with an OBJECTIVE difficulty proxy — the next-token
entropy at the prompt's last position (higher entropy = model less certain = harder) — so the
result doesn't rest on hand-labeled tiers alone.

Verdict: if E[d] rises with difficulty (positive entropy correlation, hard-tier mean > easy-tier
mean), the Q-exit is adaptive. If E[d] is ~flat, the "adaptive" claim is weak on this model —
also an honest finding. Measured at the TRAINED depth (4); the gate is undefined past it.

Run:  D:/lantern-venv-train/Scripts/python.exe experiments/sigma0_qexit_adaptive.py
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
OUT = REPO / "data" / "sigma0" / "qexit_adaptive_report.json"

PROMPTS = {
    "easy": [
        "The sky is", "2 + 2 =", "The opposite of up is", "Cats say",
        "One plus one equals", "The first letter of the alphabet is",
        "Roses are red, violets are", "The sun rises in the",
    ],
    "medium": [
        "The capital of Australia is", "The chemical symbol for gold is",
        "World War Two ended in the year", "The largest planet in the solar system is",
        "The square root of one hundred forty-four is", "The author of Romeo and Juliet is",
        "The freezing point of water in Celsius is", "The number of continents on Earth is",
    ],
    "hard": [
        "What is 17 multiplied by 23? The answer is",
        "If all bloops are razzies and all razzies are lazzies, then all bloops are",
        "The 12th prime number is", "The derivative of x cubed times sine x is",
        "A farmer has 17 sheep and all but 9 die; the number remaining is",
        "The integral of 1 over x with respect to x is",
        "The 9th Fibonacci number (starting 1,1) is",
        "Water boils at what temperature in Fahrenheit at sea level? The answer is",
    ],
}


def main() -> None:
    print(f"[qexit] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    n_steps = int(getattr(model.config, "total_ut_steps", 4) or 4)  # trained operating point

    captured = {}

    def hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 3 and isinstance(out[2], list):
            captured["gates"] = out[2]

    handle = model.model.register_forward_hook(hook)

    rows = []
    for tier, prompts in PROMPTS.items():
        for p in prompts:
            ids = tok(p, return_tensors="pt").to(model.device)
            captured.clear()
            with torch.no_grad():
                out = model(**ids)
            gates = captured.get("gates")
            # exit PDF at last token, replicating modeling_ouro.py exactly
            lam = [float(torch.sigmoid(gates[i].squeeze(-1)[0, -1])) for i in range(n_steps)]
            remaining, pdf = 1.0, []
            for i, l in enumerate(lam):
                p_i = (l * remaining) if i < n_steps - 1 else remaining
                remaining *= (1.0 - l)
                pdf.append(p_i)
            exp_depth = float(sum((i + 1) * pi for i, pi in enumerate(pdf)))
            # difficulty proxy: next-token entropy at the last prompt position
            probs = torch.softmax(out.logits[0, -1].float(), dim=-1)
            entropy = float(-(probs * torch.log(probs + 1e-12)).sum())
            rows.append({"tier": tier, "prompt": p, "expected_exit_depth": round(exp_depth, 3),
                         "next_token_entropy": round(entropy, 3), "exit_pdf": [round(x, 3) for x in pdf]})

    handle.remove()

    depth = np.array([r["expected_exit_depth"] for r in rows])
    ent = np.array([r["next_token_entropy"] for r in rows])
    tiers = np.array([r["tier"] for r in rows])
    corr = float(np.corrcoef(depth, ent)[0, 1])
    tier_mean = {t: round(float(depth[tiers == t].mean()), 3) for t in ("easy", "medium", "hard")}
    depth_range = round(float(depth.max() - depth.min()), 3)

    adaptive = (corr > 0.2) and (tier_mean["hard"] > tier_mean["easy"] + 0.1)
    report = {
        "task": "Is Ouro's trained Q-exit gate adaptive — more recurrent depth on harder inputs?",
        "model": MID,
        "trained_depth": n_steps,
        "n_prompts": len(rows),
        "expected_exit_depth_by_tier": tier_mean,
        "expected_exit_depth_range": depth_range,
        "expected_exit_depth_overall_mean": round(float(depth.mean()), 3),
        "corr(exit_depth, next_token_entropy)": round(corr, 3),
        "verdict_adaptive": bool(adaptive),
        "verdict_note": ("E[depth] rises with difficulty (entropy corr > 0.2 and hard-tier > easy-tier) "
                         "=> Q-exit is ADAPTIVE" if adaptive else
                         "E[depth] ~flat across difficulty => the adaptive-compute claim is WEAK on this "
                         "model at the trained depth; it behaves closer to fixed-depth"),
        "evidence_class": "MEASURED (data/sigma0/qexit_adaptive_report.json)",
        "caveats": ("measured at trained depth 4 (gate undefined past it, so E[depth] range is bounded "
                    "[1,4] and coarse), fp16, Ouro-1.4B-Thinking, 24 prompts, difficulty proxy = "
                    "next-token entropy. Complements bench_ouro_loop.py (which measures global "
                    "speed/quality, not per-input adaptivity)."),
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[qexit] trained depth={n_steps}  prompts={len(rows)}")
    print(f"[qexit] E[exit depth] by tier: {tier_mean}  (range {depth_range}, of max {n_steps})")
    print(f"[qexit] corr(exit_depth, next-token entropy) = {corr:.3f}")
    print(f"[qexit] => {'ADAPTIVE' if adaptive else 'NOT meaningfully adaptive (near fixed-depth)'}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
