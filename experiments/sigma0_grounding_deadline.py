"""
sigma0_grounding_deadline.py — machine-check of the Grounding Deadline design note
(SIGMA0-COLLAPSE-CERTIFICATE.md §3.1).

Claim checked (V-metric, by construction): inside a certified basin {V<=c} with
V(F(x)) <= gamma·V(x), an anchor with budget ||a|| <= B can escape only if
B > B*(n) = (sqrt(c) - gamma^{n/2}·sqrt(V0)) / sqrt(lmax(P)), so any B < B*_inf =
sqrt(c/lmax(P)) has a finite, computable deadline n*(B). Verification is NOT against our
own bound: at each depth we exactly maximize V(x_n + a) over the budget ball (trust-region
subproblem via secular equation) and compare escape yes/no against the predicted deadline.

Three checks:
  1. NORMAL basin (cond(P)~2): the deadline BITES — predicted n*(B) matches measured
     last-escape depth (bound conservative in the right direction).
  2. NON-NORMAL sliver (cond(P)~6e5): ceiling B*_inf is tiny, so any realistic anchor
     escapes at every depth — deadline exists but has no practical bite.
  3. OURO projection: measured rho=0.88 (experiments/sigma0_loop_jacobian.py) composed
     with the inequality -> commitment half-life ~5.4 steps; plus Ouro's measured strong
     non-normality puts it in the sliver regime, RETRO-dicting the anchoring null
     (experiments/ouro_canary_vs_logprob.py). Projection + retrodiction — labeled as such,
     not a new measurement.

Evidence class: PROVEN (checks 1-2, machine-checked here, CPU-only) / PROJECTION (check 3).
Honest limits: additive-anchor model of grounding; the qualitative "early beats late" is
independently published (arXiv:2604.23235); prospective test needs a well-conditioned loop
(e.g. STARS-trained) where the deadline should bite.

Run:  python experiments/sigma0_grounding_deadline.py     (numpy + scipy, seconds, CPU)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.linalg import solve_discrete_lyapunov

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "grounding_deadline_report.json"
RHO_OURO = 0.88  # measured: experiments/sigma0_loop_jacobian.py (2026-07-04)


def max_V_on_ball(x, P, B):
    """Exact max_{||a||=B} (x+a)^T P (x+a) — trust-region subproblem via secular equation."""
    lam, U = np.linalg.eigh(P)
    z = U.T @ x
    lo, hi = lam[-1] + 1e-12, lam[-1] + 1e6
    for _ in range(200):
        mu = 0.5 * (lo + hi)
        a = lam * z / (mu - lam)
        if np.linalg.norm(a) > B:
            lo = mu
        else:
            hi = mu
    a = lam * z / (mu - lam)
    n = np.linalg.norm(a)
    if n > 1e-12:
        a = a / n * B
    w = z + a
    return float(w @ (lam * w))


def run_case(A, label, c=4.0, budgets=(0.4, 0.6, 0.9), steps=15, seed=0):
    P = solve_discrete_lyapunov(A.T, np.eye(A.shape[0]))
    lmax = float(np.max(np.linalg.eigvalsh(P)))
    gamma = 1.0 - 1.0 / lmax
    condP = float(np.linalg.cond(P))
    rng = np.random.default_rng(seed)
    x0 = rng.standard_normal(A.shape[0])
    x0 = x0 / np.sqrt(x0 @ P @ x0) * np.sqrt(0.9 * c)   # start at V = 0.9c
    V0 = float(x0 @ P @ x0)
    Binf = float(np.sqrt(c / lmax))

    rows, all_ok = [], True
    for B in budgets:
        if B >= Binf:
            nstar = None    # budget above the ceiling: never blocked
        else:
            nstar = float(2 * np.log(np.sqrt(V0) / (np.sqrt(c) - B * np.sqrt(lmax)))
                          / np.log(1 / gamma))
        x, last_escape = x0.copy(), -1
        for n in range(steps):
            if max_V_on_ball(x, P, B) > c:
                last_escape = n
            x = A @ x
        ok = (nstar is None and last_escape == steps - 1) or \
             (nstar is not None and last_escape <= int(np.ceil(nstar)))
        all_ok &= ok
        rows.append({"budget": B, "predicted_deadline": None if nstar is None else round(nstar, 2),
                     "measured_last_escape": last_escape, "consistent": bool(ok)})
        pred = "never blocked (B >= ceiling)" if nstar is None else f"n* = {nstar:.2f}"
        print(f"  B={B:.2f}: predicted {pred:>28}   measured last-escape = {last_escape}   "
              f"{'CONSISTENT' if ok else 'VIOLATION'}")
    return {"label": label, "gamma": round(gamma, 4), "cond_P": round(condP, 1),
            "B_star_inf": round(Binf, 4), "V0": round(V0, 3),
            "budgets": rows, "all_consistent": bool(all_ok)}, all_ok


def main() -> None:
    report = {"claim": "certified basin (gamma, c, P) => anchor budget B < B*_inf has a "
                       "computable escape deadline n*(B); bite governed by cond(P)",
              "verification": "exact trust-region max of V(x_n+a) over ||a||<=B vs predicted deadline",
              "cases": [], "evidence_class": "PROVEN (synthetic maps, V-metric) + PROJECTION (Ouro)"}
    ok_all = True

    print("== NORMAL basin (well-conditioned): the deadline should BITE ==")
    case, ok = run_case(np.diag([0.6, 0.7, 0.8]), "normal_well_conditioned")
    report["cases"].append(case); ok_all &= ok

    print("\n== NON-NORMAL sliver (same eigenvalues): ceiling tiny, no practical bite ==")
    Jx = np.array([[0.6, 9.0, 3.0], [0.0, 0.7, 9.0], [0.0, 0.0, 0.8]])
    case, ok = run_case(Jx, "nonnormal_sliver", budgets=(0.01, 0.05, 0.4))
    report["cases"].append(case); ok_all &= ok

    half_life = float(np.log(2) / np.log(1 / RHO_OURO))
    proj = {"label": "ouro_projection", "measured_rho": RHO_OURO,
            "sqrtV_half_life_steps": round(half_life, 1),
            "gap_closed_at_depth_4": round(1 - RHO_OURO ** 4, 2),
            "gap_closed_at_depth_8": round(1 - RHO_OURO ** 8, 2),
            "regime": "sliver (measured strongly non-normal) -> weak Euclidean deadline",
            "retrodicts": "anchoring null in experiments/ouro_canary_vs_logprob.py",
            "note": "projection of a measured rate through the inequality — not a new measurement"}
    report["cases"].append(proj)
    print(f"\n== OURO projection (measured rho={RHO_OURO}) ==")
    print(f"  sqrt-commitment half-life ~ {half_life:.1f} steps; "
          f"gap closed at depth 4: {100 * (1 - RHO_OURO ** 4):.0f}%, depth 8: {100 * (1 - RHO_OURO ** 8):.0f}%")
    print("  sliver regime -> weak deadline -> retro-dicts the measured anchoring null (supporting, not validating)")

    report["all_synthetic_checks_consistent"] = bool(ok_all)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{'ALL CHECKS CONSISTENT' if ok_all else 'VIOLATIONS FOUND'} -> {OUT.relative_to(REPO)}")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
