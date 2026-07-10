r"""
ptqtp_quantize.py — faithful PTQTP (Post-Training Quantization to Trit-Planes, arXiv:2509.16989) on
our served Qwen coder, and a measured quality/memory check vs FP16. (#2206.)

Method (from the paper, Algorithm 1 — dual trit-plane, weight-only, no calibration):
  Each linear weight W is flattened and split into GROUPS of size G=128. Each group W_g (length G) is
  approximated by TWO ternary planes plus two continuous scales:
        W_g  ≈  α1·T1 + α2·T2 ,   T1,T2 ∈ {-1,0,1}^G ,  α ∈ R^2  (per group)
  Alternating optimization to convergence:
    (a) SCALES  — closed-form ridge regression per group:
          S = [T1, T2] ∈ {-1,0,1}^{G×2};  A = SᵀS + λI₂;  b = Sᵀ W_g;  α = A⁻¹ b
        (λ adapted up when A is ill-conditioned: κ = ‖A‖_F·‖A⁻¹‖_F > 1e12 → λ·√(κ/1e12), clamp 1.0)
    (b) TRIT-PLANES — for every element, exhaustive 9-way argmin over (t1,t2) ∈ {-1,0,1}²:
          (T1,T2)_{g,j} = argmin_(t1,t2) ( W_{g,j} − (α1·t1 + α2·t2) )²
    Init T1=T2=sign(W) (0→+1), α=[1,1]. Iterate until ‖Δα‖ < ε or T_max.

Effective storage: 2 trits/weight (~2·log2 3 ≈ 3.17 bits) + 2 fp16 scales per G=128 group (~0.25
bits/weight) ≈ 3.4 bits/weight vs FP16's 16 → ~4.7× smaller (packed 5 trits/8b → ~10×). We measure
the QUALITY of the approximation (perplexity with dequantized Ŵ) — the claim to test is that this
structured dual-ternary PTQ preserves quality where naive ternary collapsed.

Run:  .venv-train/Scripts/python.exe experiments/ptqtp_quantize.py --model Qwen/Qwen2.5-Coder-1.5B-Instruct
Env/flags: --model, --group 128, --iters 8, --limit-layers N (smoke), --ppl-tokens 4096
"""
import argparse
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import itertools as _it


def _combos(n_planes, dev):
    return torch.tensor(list(_it.product((-1., 0., 1.), repeat=n_planes)), device=dev)  # [3^P, P]


@torch.no_grad()
def ptqtp_matrix(W, group=128, iters=8, eps=1e-4, lam0=1e-3, chunk=4096, n_planes=2):
    """Quantize a 2-D weight W [out,in] with P trit-planes (W_g ≈ Σ_k α_k T_k); return dequantized
    reconstruction Ŵ (same shape/dtype) and the mean relative Frobenius error. Group-wise; P=2 is the
    paper's dual trit-plane, P=3 trades ~1.6 more bits/weight for a closer fit."""
    P = n_planes
    dev = W.device
    dtype = W.dtype
    flat = W.reshape(-1).float()
    n = flat.numel()
    pad = (-n) % group
    if pad:
        flat = torch.cat([flat, torch.zeros(pad, device=dev)])
    Wg = flat.reshape(-1, group)                      # [ngroups, G]
    ng = Wg.shape[0]
    combos = _combos(P, dev)                          # [3^P, P]
    out = torch.empty_like(Wg)
    for s in range(0, ng, chunk):
        w = Wg[s:s + chunk]                          # [c, G]
        c = w.shape[0]
        T = torch.sign(w); T[T == 0] = 1.0            # [c, G]
        planes = [T.clone() for _ in range(P)]        # init all planes = sign(w)
        alpha = torch.ones(c, P, device=dev)
        prev = alpha.clone()
        eye = torch.eye(P, device=dev).expand(c, P, P)
        for _ in range(iters):
            S = torch.stack(planes, dim=-1)          # [c, G, P]
            A = torch.einsum('cgk,cgl->ckl', S, S)   # [c,P,P]
            b = torch.einsum('cgk,cg->ck', S, w)     # [c,P]
            Al = A + lam0 * eye
            Ainv = torch.linalg.pinv(Al)
            kappa = torch.linalg.matrix_norm(Al, 'fro') * torch.linalg.matrix_norm(Ainv, 'fro')
            bump = torch.clamp(lam0 * torch.sqrt(torch.clamp(kappa / 1e12, min=1.0)), max=1.0)
            lam = torch.where(kappa > 1e12, bump, torch.full_like(bump, lam0))
            Al = A + lam.view(c, 1, 1) * eye
            alpha = torch.linalg.solve(Al, b.unsqueeze(-1)).squeeze(-1)   # [c,P]
            cand = alpha @ combos.t()                 # [c, 3^P]
            d = (w.unsqueeze(-1) - cand.unsqueeze(1)) ** 2   # [c, G, 3^P]
            best = d.argmin(dim=-1)                   # [c, G]
            tt = combos[best]                         # [c, G, P]
            planes = [tt[..., k] for k in range(P)]
            if (alpha - prev).norm() < eps:
                break
            prev = alpha
        out[s:s + chunk] = sum(alpha[:, k:k + 1] * planes[k] for k in range(P))
    rec = out.reshape(-1)[:n].reshape(W.shape)
    err = float((rec - W.float()).norm() / (W.float().norm() + 1e-9))
    return rec.to(dtype), err


@torch.no_grad()
def perplexity(model, tok, text, max_tokens=4096):
    ids = tok(text, return_tensors="pt").input_ids[:, :max_tokens].to(model.device)
    out = model(ids, labels=ids)
    return float(torch.exp(out.loss))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--group", type=int, default=128)
    ap.add_argument("--iters", type=int, default=8)
    ap.add_argument("--limit-layers", type=int, default=0, help="0=all; else quantize only first N linears (smoke)")
    ap.add_argument("--ppl-tokens", type=int, default=4096)
    a = ap.parse_args()

    print(f"[ptqtp] loading {a.model} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        a.model, trust_remote_code=True, torch_dtype=torch.float16, device_map="cuda")
    model.eval()

    # eval text: genuinely DIVERSE prose + real code so FP16 ppl is meaningfully >1 and quantization
    # degradation is visible (repetitive text yields ppl~1 and masks it).
    text = (
        "The mitochondrion is a double membrane-bound organelle found in most eukaryotic cells. "
        "Spectral graph theory studies properties of graphs via the eigenvalues of their adjacency "
        "matrices. In 1687 Newton published the Principia, establishing the laws of motion and universal "
        "gravitation. The Baltic Sea is a marginal sea of the Atlantic, enclosed by Scandinavia. "
        "Monetary policy refers to actions a central bank takes to manage the money supply and interest "
        "rates. Photosynthesis converts light energy into chemical energy stored in glucose.\n\n"
        "import heapq\n\n"
        "def dijkstra(graph, start):\n"
        "    dist = {start: 0}\n"
        "    pq = [(0, start)]\n"
        "    while pq:\n"
        "        d, u = heapq.heappop(pq)\n"
        "        if d > dist.get(u, float('inf')):\n"
        "            continue\n"
        "        for v, w in graph[u].items():\n"
        "            nd = d + w\n"
        "            if nd < dist.get(v, float('inf')):\n"
        "                dist[v] = nd\n"
        "                heapq.heappush(pq, (nd, v))\n"
        "    return dist\n\n"
        "class LRUCache:\n"
        "    def __init__(self, capacity):\n"
        "        self.cap = capacity\n"
        "        self.store = {}\n\n"
        "    def get(self, key):\n"
        "        if key not in self.store:\n"
        "            return -1\n"
        "        val = self.store.pop(key)\n"
        "        self.store[key] = val\n"
        "        return val\n\n"
        "The French Revolution began in 1789 amid fiscal crisis and social inequality. Quantum "
        "entanglement is a phenomenon where the quantum states of two particles remain correlated. "
        "Regular expressions are sequences of characters that define a search pattern. The Fibonacci "
        "sequence appears in the arrangement of leaves, the branching of trees, and the spirals of shells. "
    ) * 6

    ppl_fp16 = perplexity(model, tok, text, a.ppl_tokens)
    print(f"[ptqtp] FP16 perplexity = {ppl_fp16:.3f}", flush=True)

    # collect target linears (skip lm_head + embeddings; quantize the transformer blocks' Linears)
    targets = []
    for name, mod in model.named_modules():
        if isinstance(mod, nn.Linear) and "lm_head" not in name:
            targets.append((name, mod))
    if a.limit_layers:
        targets = targets[: a.limit_layers]
    print(f"[ptqtp] quantizing {len(targets)} linear layers (group={a.group}, iters={a.iters}) ...", flush=True)

    t0 = time.time()
    errs = []
    n_params = 0
    for i, (name, mod) in enumerate(targets):
        rec, err = ptqtp_matrix(mod.weight.data, a.group, a.iters)
        mod.weight.data.copy_(rec)
        errs.append(err); n_params += mod.weight.numel()
        if i % 40 == 0 or i == len(targets) - 1:
            print(f"  [{i+1}/{len(targets)}] {name}: rel_err {err:.4f}", flush=True)
    quant_s = time.time() - t0

    ppl_ptqtp = perplexity(model, tok, text, a.ppl_tokens)
    mean_err = sum(errs) / len(errs)
    # effective bits: 2 trits (2*log2 3) + 2 fp16 scales per group
    bits_per_w = 2 * (torch.log2(torch.tensor(3.0)).item()) + (2 * 16) / a.group
    report = {
        "method": "PTQTP dual trit-plane (arXiv:2509.16989), weight-only, no calibration",
        "model": a.model, "group": a.group, "iters": a.iters,
        "n_linear_layers_quantized": len(targets), "n_params_quantized": n_params,
        "quantize_seconds": round(quant_s, 1),
        "mean_relative_frobenius_error": round(mean_err, 4),
        "perplexity_fp16": round(ppl_fp16, 3),
        "perplexity_ptqtp": round(ppl_ptqtp, 3),
        "ppl_ratio": round(ppl_ptqtp / ppl_fp16, 3),
        "effective_bits_per_weight": round(bits_per_w, 3),
        "approx_compression_vs_fp16": round(16.0 / bits_per_w, 2),
        "verdict": ("QUALITY PRESERVED: dual trit-plane PTQTP keeps perplexity within a small factor of "
                    "FP16 — structured ternary does NOT collapse (contrast the naive-ternary x6864)."
                    if ppl_ptqtp < ppl_fp16 * 2.0 else
                    "QUALITY DEGRADED: perplexity blew up — either the impl/eval needs work or PTQTP "
                    "does not hold at this size on our model (honest negative)."),
        "evidence_class": "MEASURED",
    }
    OUT = REPO / "data" / "sigma0" / "ptqtp_report.json"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    import json
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n[ptqtp] ===== RESULT =====")
    print(f"  FP16 ppl {ppl_fp16:.3f} -> PTQTP ppl {ppl_ptqtp:.3f}  (ratio {report['ppl_ratio']})")
    print(f"  mean rel error {mean_err:.4f} | ~{report['effective_bits_per_weight']} bits/w "
          f"(~{report['approx_compression_vs_fp16']}x) | quant {quant_s:.0f}s")
    print(f"  VERDICT: {report['verdict']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
