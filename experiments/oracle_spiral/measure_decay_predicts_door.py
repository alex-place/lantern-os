"""
measure_decay_predicts_door.py — the #2833 experiment run harness.

Falsifiable claim (self-triggered Oracle/Spiral amendment, #2830): does the loop's
measured decay rate λ̂ = r_t/r_{t-1} (+ ρ(J)) PREDICT the step where the ADR-0012 door
fires (and where stability/groundedness fails)?

Method (observe-only, "measure before building" — #2029): for each prompt, run the real
Ouro native recurrent loop ONE unit deep (loop_lm._truncated_forward at q=1.0 → the FULL
per-UT-step trajectory), and log per step:
  - r_t = ‖h_t − h_{t-1}‖ / ‖h_{t-1}‖  and  λ̂ = r_t/r_{t-1}
  - ρ(J), ‖J‖₂ from the empirical loop Jacobian (cio_sde.jsrr_certificate — the STARS
    discrete criterion loop_lm already uses)
  - the realized doors: the trained Q-exit step (qexit_step) and the convergence step
    (converge_step), + the stability-accepted verdict (ρ(A)<1) as the collapse/groundedness proxy
Then predict the converge door from the EARLY decay rate (decay_prediction.py) and compare
predicted-vs-actual as a table, plus λ̂→Q-exit and λ̂/ρ(J)→stability-fail correlations.

Run (GPU serving env):
  HF_HOME=D:/hf-cache .venv-train/Scripts/python experiments/oracle_spiral/measure_decay_predicts_door.py \
      --prompts experiments/oracle_spiral/prompts.txt --q 0.5 --eps 0.05 --observe 3 \
      --out data/oracle/decay-predicts-door.jsonl
"""
from __future__ import annotations
import argparse, json, os, sys, time

os.environ.setdefault("HF_HOME", "D:/hf-cache")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows console + λ/ρ
HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", ".."))          # repo root for src/
sys.path.insert(0, os.path.join(HERE, "..", "..", "src"))

from decay_prediction import (  # noqa: E402
    evaluate_run, summarize, decide, prediction_table, rows_as_dicts, estimate_lambda,
)


def _rho_norm_from_hidden(hidden_per_step):
    """Empirical loop Jacobian ρ(J), ‖J‖₂ from consecutive exit-depth hidden vectors —
    the SAME estimator loop_lm.generate uses (A ≈ mean outer product of normalized
    transitions), fed to the STARS JSRR certificate. Returns (rho, norm, stable)."""
    try:
        import torch
        from cio_sde.collapse import jsrr_certificate
        H = torch.stack([h for h in hidden_per_step])         # (T, d)
        if H.shape[0] < 3:
            return None, None, None
        dH = H[1:] - H[:-1]
        norms = H[:-1].norm(dim=-1, keepdim=True).clamp(min=1e-9)
        A = ((dH / norms).unsqueeze(-1) * H[:-1].unsqueeze(-2)).mean(0)  # (d, d)
        j = jsrr_certificate(A)
        return float(j.spectral_radius), float(j.spectral_norm), bool(j.stable)
    except Exception as e:
        return None, None, None


def _deltas(hidden_per_step):
    out = []
    for t in range(1, len(hidden_per_step)):
        prev = hidden_per_step[t - 1]
        denom = float(prev.norm()) or 1e-9
        out.append(float((hidden_per_step[t] - prev).norm()) / denom)
    return out


def run(prompts, model_id, q, eps, observe_k, out_path):
    import torch
    from sigma0.loop_lm import Sigma0LoopLM
    print(f"loading {model_id} on {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu'} ...", flush=True)
    m = Sigma0LoopLM.load(model_id)
    tok = m.tok
    bb = m._backbone()
    dev = bb.device if hasattr(bb, "device") else ("cuda" if torch.cuda.is_available() else "cpu")

    runs, raw = [], []
    for i, prompt in enumerate(prompts):
        t0 = time.time()
        formatted = f"### Instruction:\n{prompt}\n\n### Response:\n"
        ids = tok(formatted, return_tensors="pt").input_ids.to(dev)
        # q=1.0 → the trained gate never early-exits, so we see the FULL trajectory and
        # can locate BOTH doors (trained Q-exit at the real q, and the converge fixed point).
        with torch.no_grad():
            hs_list, g_list = m._truncated_forward(ids, q=1.0)
        hidden_per_step = [h[0, -1].detach().float().cpu() for h in hs_list]
        gate_logits = [float(g[0, -1, 0]) for g in g_list]
        deltas = _deltas(hidden_per_step)

        qstep, cdf, qreason = Sigma0LoopLM.qexit_step(gate_logits, q, len(gate_logits))  # trained door
        cstep, crel, creason, _ = Sigma0LoopLM.converge_step(hidden_per_step, eps, len(hidden_per_step))
        rho, jnorm, stable = _rho_norm_from_hidden(hidden_per_step)
        rho_early, _, _ = _rho_norm_from_hidden(hidden_per_step[: observe_k + 1])

        # The measured "door step" for the predictive test = the CONVERGE door (the ADR-0012
        # Converge fixed point). grounded proxy = the JSRR stability verdict (ρ(A)<1).
        rp = evaluate_run(f"p{i:02d}", deltas, eps, observe_k, rho_j=rho_early, grounded=stable)
        runs.append(rp)
        raw.append({
            "prompt_id": f"p{i:02d}", "prompt": prompt[:80], "n_steps": len(hidden_per_step),
            "deltas": [round(d, 5) for d in deltas], "lambda_hat": estimate_lambda(deltas, observe_k),
            "rho_J": rho, "rho_J_early": rho_early, "norm_J": jnorm, "stable": stable,
            "qexit_step": qstep, "qexit_reason": qreason, "converge_step": cstep, "converge_reason": creason,
            "sec": round(time.time() - t0, 2),
        })
        print(f"  [{i+1}/{len(prompts)}] steps={len(hidden_per_step)} λ̂={rp.lambda_hat} "
              f"ρ(J)={rho} qexit={qstep}({qreason}) converge={cstep}({creason}) stable={stable} "
              f"pred={rp.predicted_step} ({time.time()-t0:.1f}s)", flush=True)

    summary = summarize(runs)
    # cross-signal: does λ̂ predict the trained Q-exit step? does ρ(J)/λ̂ predict stability-fail?
    from decay_prediction import _pearson
    qpairs = [(r["lambda_hat"], r["qexit_step"]) for r in raw if r["lambda_hat"] is not None and r["qexit_step"]]
    summary["pearson_lambda_vs_qexit"] = _pearson([a for a, _ in qpairs], [b for _, b in qpairs]) if len(qpairs) > 1 else None
    verdict = decide(summary)

    print("\n" + "=" * 78)
    print("PREDICTION TABLE — predicted vs actual (Converge door), not a vibe")
    print("=" * 78)
    print(prediction_table(runs))
    print("\nSUMMARY:", json.dumps(summary, indent=2))
    print("\nDECISION:", json.dumps(verdict, indent=2, ensure_ascii=False))

    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"kind": "meta", "model": model_id, "q": q, "eps": eps,
                                "observe_k": observe_k, "summary": summary, "decision": verdict}) + "\n")
            for r in raw:
                f.write(json.dumps(r) + "\n")
        with open(out_path.replace(".jsonl", "-predictions.jsonl"), "w", encoding="utf-8") as f:
            for d in rows_as_dicts(runs):
                f.write(json.dumps(d) + "\n")
        print(f"\nwrote {out_path}")
    return summary, verdict


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompts", default=os.path.join(HERE, "prompts.txt"))
    ap.add_argument("--model", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--q", type=float, default=0.5)
    ap.add_argument("--eps", type=float, default=0.05)
    ap.add_argument("--observe", type=int, default=3)
    ap.add_argument("--out", default="data/oracle/decay-predicts-door.jsonl")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    with open(a.prompts, encoding="utf-8") as f:
        prompts = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    if a.limit:
        prompts = prompts[: a.limit]
    print(f"{len(prompts)} prompts | q={a.q} eps={a.eps} observe={a.observe}")
    run(prompts, a.model, a.q, a.eps, a.observe, a.out)
