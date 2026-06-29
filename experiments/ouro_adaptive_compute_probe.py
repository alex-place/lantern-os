"""
Salvage probe: is there a PRACTICAL, EFFICIENT inference upgrade in the Ouro looped LM?

E1 killed compute-depth-as-compression. This tests the OTHER claim of a looped/UT model:
adaptive compute — skip recurrent steps on easy tokens using the model's TRAINED exit gate
(not the latent-contraction signal that already failed). Two practical readouts:

  1. ADAPTIVE COMPUTE (lossy): at Q-exit threshold q, mean recurrent depth used (compute) vs
     argmax-agreement with full depth R4 (greedy-output fidelity) + mean KL(full || qexit).
     A high agreement at low mean-depth = a real quality-preserving speedup.

  2. SELF-SPECULATIVE (lossless): treat a shallow pass as a DRAFT and full depth R4 as the
     VERIFY. Acceptance = fraction of tokens whose argmax at the gate's exit depth already
     equals the R4 argmax. Accepted tokens cost their shallow depth; rejected tokens fall back
     to R4. Output is BIT-IDENTICAL to full-depth greedy → lossless speedup = saved depth.

Reported per corpus (prose + code) over a Pareto of q. PYTHONPATH=src.
"""
from __future__ import annotations
import json, math, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ.setdefault("HF_HOME", "D:/hf-cache")
import torch

REPO = Path(__file__).resolve().parent.parent
LN2 = math.log(2)
QS = [0.2, 0.4, 0.6, 0.8, 0.95, 1.0]


def probe(m, data: bytes, ctx=1024):
    bb = m._backbone()
    dev = bb.device if hasattr(bb, "device") else torch.device("cuda")
    lm_head = m.model.lm_head if hasattr(m.model, "lm_head") else bb.lm_head
    n_ut = m.max_steps
    enc = m.tok(data.decode("latin-1"), return_tensors="pt").input_ids[0].tolist()
    bos = m.tok.bos_token_id if m.tok.bos_token_id is not None else m.tok.eos_token_id
    step = ctx - 1

    # accumulators per q
    agg = {q: {"depth_sum": 0.0, "argmax_match": 0, "kl_sum": 0.0, "n": 0} for q in QS}

    with torch.no_grad():
        for s in range(0, len(enc), step):
            chunk = enc[s:s + step]
            if not chunk:
                break
            inp = torch.tensor([[bos] + chunk], device=dev)
            seq = inp.shape[1]
            _o, hs_list, gate_list = bb.model(input_ids=inp, use_cache=False)
            P = seq - 1  # predictor positions 0..seq-2

            # logits + argmax + logprobs at every depth, for the predictor positions
            logits_by_depth = []   # (n_ut) of (P, vocab)
            argmax_by_depth = []   # (n_ut) of (P,)
            for k in range(n_ut):
                lk = lm_head(hs_list[k])[0, :-1].float()      # (P, vocab)
                logits_by_depth.append(lk)
                argmax_by_depth.append(lk.argmax(-1))
            full_logits = logits_by_depth[-1]                 # R4 = best
            full_argmax = argmax_by_depth[-1]
            full_logp = full_logits - torch.logsumexp(full_logits, -1, keepdim=True)

            # gate exit logits per predictor position: (P, n_ut)
            gates = torch.stack([gate_list[k][0, :-1, 0].float() for k in range(n_ut)], dim=1)
            lam = torch.sigmoid(gates)                        # (P, n_ut) instantaneous exit prob

            for q in QS:
                # cumulative Q-exit per position (paper §3), vectorized
                survival = torch.ones(P, device=dev)
                cdf = torch.zeros(P, device=dev)
                depth = torch.full((P,), n_ut, dtype=torch.long, device=dev)
                done = torch.zeros(P, dtype=torch.bool, device=dev)
                for t in range(n_ut):
                    last = (t == n_ut - 1)
                    p = survival if last else lam[:, t] * survival
                    cdf = cdf + p
                    survival = survival * (1.0 - lam[:, t])
                    fire = (~done) & (cdf >= q)
                    depth[fire] = t + 1
                    done = done | fire
                # gather argmax + logprob at each position's exit depth
                d0 = (depth - 1).clamp(0, n_ut - 1)
                am_sel = torch.stack([argmax_by_depth[k] for k in range(n_ut)], 0)[d0, torch.arange(P, device=dev)]
                match = (am_sel == full_argmax)
                # KL(full || qexit) per position
                sel_logits = torch.stack(logits_by_depth, 0)[d0, torch.arange(P, device=dev)]  # (P, vocab)
                sel_logp = sel_logits - torch.logsumexp(sel_logits, -1, keepdim=True)
                kl = (full_logp.exp() * (full_logp - sel_logp)).sum(-1)  # (P,)
                a = agg[q]
                a["depth_sum"] += float(depth.float().sum())
                a["argmax_match"] += int(match.sum())
                a["kl_sum"] += float(kl.sum())
                a["n"] += P

    out = {}
    for q in QS:
        a = agg[q]
        n = a["n"]
        md = a["depth_sum"] / n
        out[str(q)] = {
            "mean_depth": round(md, 3),
            "recurrent_compute_used": round(md / n_ut, 3),     # 1.0 = full
            "compute_saved": round(1 - md / n_ut, 3),
            "greedy_argmax_agreement": round(a["argmax_match"] / n, 4),   # lossy fidelity
            "selfspec_acceptance": round(a["argmax_match"] / n, 4),       # == lossless accept rate
            "mean_kl_full_vs_qexit": round(a["kl_sum"] / n, 4),
        }
    return {"n_predicted": agg[QS[0]]["n"], "n_ut": n_ut, "pareto": out}


def selfspec_speedup(pareto, n_ut):
    """Lossless self-speculative: accepted tokens cost their exit depth, rejected cost full n_ut
    (draft) + we already have R4 from the same pass, so reject adds nothing beyond the draft.
    Effective recurrent passes per token ~ acceptance*mean_depth + (1-acceptance)*n_ut.
    Report the best lossless speedup across q."""
    best = None
    for q, r in pareto.items():
        acc = r["selfspec_acceptance"]
        eff = acc * r["mean_depth"] + (1 - acc) * n_ut
        speed = n_ut / eff
        if best is None or speed > best["lossless_speedup"]:
            best = {"q": q, "acceptance": acc, "mean_depth_accepted": r["mean_depth"],
                    "lossless_speedup": round(speed, 3)}
    return best


def main():
    from sigma0.loop_lm import Sigma0LoopLM
    print("loading Ouro-1.4B ...", flush=True)
    m = Sigma0LoopLM.load("ByteDance/Ouro-1.4B")
    corpora = []
    readme = REPO / "README.md"
    if readme.exists():
        corpora.append(("README.md (prose)", readme.read_bytes()[:200_000]))
    code = REPO / "src/csf/csf_pack.py"
    if code.exists():
        corpora.append(("csf_pack.py (code)", code.read_bytes()[:200_000]))
    report = {"model": "ByteDance/Ouro-1.4B", "n_ut": m.max_steps, "corpora": {}}
    for name, data in corpora:
        print(f"\n### {name}  raw={len(data):,} B", flush=True)
        r = probe(m, data)
        r["selfspec_best"] = selfspec_speedup(r["pareto"], m.max_steps)
        report["corpora"][name] = r
        print(f"  {'q':>5} {'depth':>6} {'compute':>8} {'agree':>7} {'KL':>7}", flush=True)
        for q, pr in r["pareto"].items():
            print(f"  {q:>5} {pr['mean_depth']:>6} {pr['recurrent_compute_used']:>8} "
                  f"{pr['greedy_argmax_agreement']:>7} {pr['mean_kl_full_vs_qexit']:>7}", flush=True)
        sb = r["selfspec_best"]
        print(f"  LOSSLESS self-spec best: {sb['lossless_speedup']}x at q={sb['q']} "
              f"(accept {sb['acceptance']}, mean accepted depth {sb['mean_depth_accepted']})", flush=True)
    out = REPO / "data/ouro_adaptive_compute_probe.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nreport -> {out}")


if __name__ == "__main__":
    raise SystemExit(main())
