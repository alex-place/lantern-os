"""
E1/E2 diagnostic: WHY did convergence-exit never fire?

E1 found mean_depth == n_ut (4/4) on every corpus at eps=0.05, so the "compute-depth
dilation buys bit dilation" mechanism produced a null signal (converge-bits == full-bits,
corr(depth, bits) ~ 0 / undefined). This characterizes the actual latent contraction
regime: per-step ||Δh||/||h|| distribution, and an eps sweep of mean_depth + corr(depth,
full-depth bits). If depth never varies for any plausible eps, the depth->bits coupling
the Lapse Tesseract assumes does not exist in this checkpoint.

    PYTHONPATH=src .venv-train/Scripts/python experiments/lapse_e1_contraction_diag.py
"""
from __future__ import annotations
import json, math, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ.setdefault("HF_HOME", "D:/hf-cache")
import torch

REPO = Path(__file__).resolve().parent.parent
LN2 = math.log(2)
EPS_SWEEP = [0.02, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30, 0.50]


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = max(0, min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1)))))
    return round(xs[k], 4)


def diag(m, data: bytes, ctx=1024):
    bb = m._backbone()
    dev = bb.device if hasattr(bb, "device") else torch.device("cuda")
    lm_head = m.model.lm_head if hasattr(m.model, "lm_head") else bb.lm_head
    n_ut = m.max_steps
    enc = m.tok(data.decode("latin-1"), return_tensors="pt").input_ids[0].tolist()
    bos = m.tok.bos_token_id if m.tok.bos_token_id is not None else m.tok.eos_token_id
    step = ctx - 1

    rel_by_step = [[] for _ in range(n_ut - 1)]   # contraction at transition t->t+1
    # per-token: full-depth bits + the depth each eps would assign
    tok_bits = []
    tok_rel = []     # list of per-token [rel_1, rel_2, rel_3]
    with torch.no_grad():
        for s in range(0, len(enc), step):
            chunk = enc[s:s + step]
            if not chunk:
                break
            inp = torch.tensor([[bos] + chunk], device=dev)
            seq = inp.shape[1]
            _o, hs_list, _g = bb.model(input_ids=inp, use_cache=False)
            H = torch.stack([h[0].float() for h in hs_list])      # (n_ut, seq, hidden)
            diffs = (H[1:] - H[:-1]).norm(dim=-1)                  # (n_ut-1, seq)
            denom = H[:-1].norm(dim=-1).clamp(min=1e-9)
            rel = (diffs / denom)                                  # (n_ut-1, seq)
            logits_f = lm_head(hs_list[-1])[0].float()
            tgt = inp[0, 1:]
            lse = torch.logsumexp(logits_f[:-1], dim=-1)
            true = logits_f[:-1].gather(1, tgt.unsqueeze(1)).squeeze(1)
            bits = ((lse - true) / LN2).cpu().tolist()
            rel_pred = rel[:, :-1].cpu()                           # transitions for predicting positions
            for j in range(rel_pred.shape[1]):
                rj = rel_pred[:, j].tolist()
                tok_rel.append(rj)
                tok_bits.append(bits[j])
                for t in range(n_ut - 1):
                    rel_by_step[t].append(rj[t])

    def depth_for(relvec, eps):
        for t, r in enumerate(relvec):
            if r < eps:
                return t + 2
        return n_ut

    def pearson(xs, ys):
        n = len(xs)
        if n < 2:
            return None
        mx, my = sum(xs) / n, sum(ys) / n
        cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        vx = sum((x - mx) ** 2 for x in xs)
        vy = sum((y - my) ** 2 for y in ys)
        return round(cov / math.sqrt(vx * vy), 4) if vx > 0 and vy > 0 else None

    sweep = {}
    for eps in EPS_SWEEP:
        depths = [depth_for(r, eps) for r in tok_rel]
        md = sum(depths) / len(depths)
        # bits if we used the convergence-exit depth's p* would differ; here we test whether
        # the depth assignment CORRELATES with surprise (full-depth bits). >0 => harder=deeper.
        corr = pearson(depths, tok_bits)
        frac_early = sum(1 for d in depths if d < n_ut) / len(depths)
        sweep[str(eps)] = {"mean_depth": round(md, 3), "frac_early_exit": round(frac_early, 3),
                           "corr_depth_vs_bits": corr}

    return {
        "n_predicted": len(tok_bits),
        "contraction_per_step": {
            f"t{t+1}->t{t+2}": {"mean": round(sum(v) / len(v), 4), "p10": pct(v, 10),
                                "median": pct(v, 50), "p90": pct(v, 90), "min": round(min(v), 4)}
            for t, v in enumerate(rel_by_step)
        },
        "eps_sweep": sweep,
    }


def main():
    from sigma0.loop_lm import Sigma0LoopLM
    print("loading Ouro-1.4B ...", flush=True)
    m = Sigma0LoopLM.load("ByteDance/Ouro-1.4B")
    corpora = []
    cube = REPO / "data/cubes/alex.private/deltas/deltas.jsonl"
    if cube.exists():
        corpora.append(("cube-delta", cube.read_bytes()[:1 << 20]))
    readme = REPO / "README.md"
    if readme.exists():
        corpora.append(("README.md", readme.read_bytes()[:1 << 20]))
    report = {"model": "ByteDance/Ouro-1.4B", "n_ut": m.max_steps, "eps_default": 0.05, "corpora": {}}
    for name, data in corpora:
        print(f"\n### {name}", flush=True)
        d = diag(m, data)
        report["corpora"][name] = d
        cs = d["contraction_per_step"]
        print("  per-step contraction ||Δh||/||h|| (mean):",
              {k: v["mean"] for k, v in cs.items()}, flush=True)
        print("  min contraction ever:", min(v["min"] for v in cs.values()), flush=True)
        print("  eps sweep (mean_depth / frac_early / corr depth~bits):", flush=True)
        for eps, s in d["eps_sweep"].items():
            print(f"    eps={eps}: depth={s['mean_depth']}/{m.max_steps} "
                  f"early={s['frac_early_exit']} corr={s['corr_depth_vs_bits']}", flush=True)
    out = REPO / "data/lapse_e1_contraction_diag.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nreport -> {out}")


if __name__ == "__main__":
    raise SystemExit(main())
