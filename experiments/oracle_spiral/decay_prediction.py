"""
decay_prediction.py — the analysis core of #2833.

The falsifiable claim of the self-triggered Oracle/Spiral amendment (#2830): does the
loop's measured decay rate `λ̂ = r_t/r_{t-1}` (optionally with `ρ(J)`) PREDICT the step
where the ADR-0012 Converge door fires (and where groundedness fails)?

This module is pure (numpy only, no torch/model) so the prediction logic is unit-tested
on synthetic geometric-decay trajectories with a KNOWN exit step, independent of the GPU
run. The run harness (measure_decay_predicts_door.py) feeds it the REAL per-step residual
trajectories from loop_lm.generate(mode="converge").

Prediction model (event-triggered control, arXiv:1707.02531/1609.07534):
  a contracting latent loop obeys r_t ≈ r_0 · λ^t. From the decay rate λ̂ estimated over
  the first `observe_k` steps, the Converge door (first t with r_t < ε) is predicted at

      n_converge = observe_k + ceil( ln(ε / r_obs) / ln(λ̂) )         (λ̂ < 1)

  If λ̂ ≥ 1 the loop is NOT contracting → predict NO convergence (a barrier/escalate case),
  which is exactly the self-triggered "escalate before spending the depth" signal.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from statistics import mean


# ── core prediction ──────────────────────────────────────────────────────────
def predict_n_converge(r_obs: float, lambda_hat: float, eps: float) -> float | None:
    """Steps AFTER the observation point until r crosses ε, assuming r decays as λ̂^n.
    None ⇒ predicted never to converge (λ̂ ≥ 1, non-contracting → barrier/escalate)."""
    if r_obs is None or r_obs <= eps:
        return 0.0                          # already converged at the observation point
    if lambda_hat is None or lambda_hat <= 0.0 or lambda_hat >= 1.0:
        return None                         # not contracting → no convergence predicted
    return math.ceil(math.log(eps / r_obs) / math.log(lambda_hat))


def estimate_lambda(deltas: list[float], observe_k: int) -> float | None:
    """Geometric-mean decay rate over the first `observe_k` residual ratios r_t/r_{t-1}.
    Robust to a single noisy step; None if there isn't enough signal."""
    ratios = []
    for t in range(1, min(observe_k, len(deltas))):
        prev, cur = deltas[t - 1], deltas[t]
        if prev and prev > 0 and cur is not None and cur > 0:
            ratios.append(cur / prev)
    if not ratios:
        return None
    # geometric mean (decay is multiplicative)
    return math.exp(mean(math.log(r) for r in ratios))


def predict_exit_step(deltas: list[float], eps: float, observe_k: int) -> float | None:
    """Predict the 1-indexed step at which the Converge door fires, using ONLY the first
    `observe_k` residuals. None ⇒ predicted non-convergence (barrier / escalate)."""
    if not deltas:
        return None
    idx = min(observe_k, len(deltas)) - 1          # 0-indexed observation point
    r_obs = deltas[idx]
    lam = estimate_lambda(deltas, observe_k)
    n = predict_n_converge(r_obs, lam, eps)
    if n is None:
        return None
    # deltas[k] is the residual entering step k+1; return a 1-indexed step depth.
    return (idx + 1) + n


def actual_exit_step(deltas: list[float], eps: float) -> float | None:
    """The realized Converge door: 1-indexed first step whose residual < ε.
    None ⇒ never contracted within the trajectory (a max-depth / barrier ride) —
    mirrors loop_lm.converge_step's fixed_point vs max_depth outcomes."""
    for t, r in enumerate(deltas):
        if r is not None and r < eps:
            return t + 1
    return None


# ── per-run evaluation ───────────────────────────────────────────────────────
@dataclass
class RunPrediction:
    prompt_id: str
    predicted_step: float | None       # None ⇒ predicted barrier (no converge)
    actual_step: float | None          # None ⇒ actual max-depth / barrier
    lambda_hat: float | None
    rho_j: float | None                # ρ(J) at the observation point, if measured
    grounded: bool | None              # groundedness verdict of the run, if measured
    error_steps: float | None          # |predicted − actual| when both are finite
    barrier_agree: bool                # predicted-barrier ⇔ actual-max-depth


def evaluate_run(prompt_id, deltas, eps, observe_k, rho_j=None, grounded=None) -> RunPrediction:
    pred = predict_exit_step(deltas, eps, observe_k)
    act = actual_exit_step(deltas, eps)
    err = (abs(pred - act) if (pred is not None and act is not None) else None)
    barrier_agree = (pred is None) == (act is None)
    return RunPrediction(prompt_id, pred, act, estimate_lambda(deltas, observe_k),
                         rho_j, grounded, err, barrier_agree)


# ── aggregate + decision ─────────────────────────────────────────────────────
def _pearson(xs, ys):
    if len(xs) < 2:
        return None
    mx, my = mean(xs), mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return (num / (dx * dy)) if dx > 0 and dy > 0 else None


def summarize(runs: list[RunPrediction]) -> dict:
    both_finite = [(r.predicted_step, r.actual_step) for r in runs
                   if r.predicted_step is not None and r.actual_step is not None]
    errs = [r.error_steps for r in runs if r.error_steps is not None]
    corr = _pearson([p for p, _ in both_finite], [a for _, a in both_finite]) if both_finite else None
    # groundedness: do predicted-barrier runs fail groundedness more than converging ones?
    g_known = [r for r in runs if r.grounded is not None]
    barrier_fail = [r for r in g_known if r.predicted_step is None]
    converge_ok = [r for r in g_known if r.predicted_step is not None]
    def _fail_rate(rs):
        return (sum(1 for r in rs if r.grounded is False) / len(rs)) if rs else None
    return {
        "n_runs": len(runs),
        "n_both_finite": len(both_finite),
        "mae_steps": (mean(errs) if errs else None),
        "within_1_step": (sum(1 for e in errs if e <= 1) / len(errs)) if errs else None,
        "pearson_pred_vs_actual": corr,
        "barrier_agreement": (sum(1 for r in runs if r.barrier_agree) / len(runs)) if runs else None,
        "groundedness_fail_rate_barrier": _fail_rate(barrier_fail),
        "groundedness_fail_rate_converge": _fail_rate(converge_ok),
    }


def decide(summary: dict, mae_max=1.5, within1_min=0.6, corr_min=0.5, barrier_min=0.7) -> dict:
    """The #2833 decision rule. Predictive → the self-triggered PRICE schedule is EARNED
    (next: measure verifier-spend vs fixed cadence). Not predictive → the amendment
    degrades to fixed-cadence routing and says so. Either way it's a MEASURED answer."""
    reasons, ok = [], True
    def check(name, val, cmp, thresh):
        nonlocal ok
        if val is None:
            reasons.append(f"{name}: unmeasured"); return
        passed = cmp(val, thresh)
        ok = ok and passed
        reasons.append(f"{name}={val:.3f} {'✓' if passed else '✗'} (want {'≤' if cmp is _le else '≥'}{thresh})")
    check("mae_steps", summary.get("mae_steps"), _le, mae_max)
    check("within_1_step", summary.get("within_1_step"), _ge, within1_min)
    check("pearson", summary.get("pearson_pred_vs_actual"), _ge, corr_min)
    check("barrier_agreement", summary.get("barrier_agreement"), _ge, barrier_min)
    verdict = "predictive" if ok else "not_predictive"
    consequence = ("self-triggered PRICE schedule EARNED — next: verifier-spend + "
                   "escalation-rate vs fixed-cadence baseline"
                   if ok else
                   "λ̂ does NOT predict the door — amendment degrades to fixed-cadence "
                   "routing; drop the self-triggered schedule (either result is a win)")
    return {"verdict": verdict, "consequence": consequence, "checks": reasons}


def _le(a, b): return a <= b
def _ge(a, b): return a >= b


def prediction_table(runs: list[RunPrediction]) -> str:
    """Human-readable prediction table (predicted vs actual), not a vibe."""
    rows = ["prompt              λ̂      ρ(J)   pred  actual  err  barrier✓  grounded"]
    for r in runs:
        rows.append(
            f"{r.prompt_id[:18]:<18}  "
            f"{('%.3f' % r.lambda_hat) if r.lambda_hat is not None else '  -  '}  "
            f"{('%.2f' % r.rho_j) if r.rho_j is not None else ' - '}  "
            f"{('%4.0f' % r.predicted_step) if r.predicted_step is not None else 'barr'}  "
            f"{('%4.0f' % r.actual_step) if r.actual_step is not None else 'maxd'}  "
            f"{('%3.0f' % r.error_steps) if r.error_steps is not None else ' - '}  "
            f"{'yes' if r.barrier_agree else 'NO ':>7}  "
            f"{'' if r.grounded is None else ('grounded' if r.grounded else 'FAILED')}")
    return "\n".join(rows)


def rows_as_dicts(runs: list[RunPrediction]) -> list[dict]:
    return [asdict(r) for r in runs]
