"""Section 9's missing epsilon, found: the two-timescale composition threshold is set by the
fast block's OPEN-LOOP DC GAIN -- a quantity neither Part I nor Part II ever looks at.

THE HOLE. SIGMA0-COLLAPSE-CERTIFICATE.md section 9 composes Part I (fast state x) with Part II
(slow weights theta) and states the result as certified iff (a) Part I holds on the fast flow,
(b) Part II's gate holds on the slow flow, and "(c) epsilon is small enough that the
quasi-equilibrium approximation is valid  [TARGET - ... NOT proven]".

Condition (c) carries NO BOUND. "Small enough" is not something an operator can check, and the
imported tools (Borkar 1997; Khalil singular perturbation) are asymptotic as epsilon -> 0: they
say a threshold exists, not where it is. This file locates it, exactly, in the linear regime.

A HYPOTHESIS THAT WAS REFUTED FIRST, kept because the refutation is the more useful half.
Section 1.2 insists that for the FAST flow the spectrum alone is the wrong object ("full-spectrum,
not A_s alone"), and 1.2.1 adds Kreiss/pseudospectral machinery because non-normal A grows
transiently while rho(A) < 1. Section 9 imports its composition result with no such correction, so
the obvious suspicion was that (c) is governed by transient amplification -- eps* proportional to
1/K(A). THAT IS WRONG. Sweeping A(k) = [[0.9, k],[0, 0.9]] with the loop gain pinned, eps_c is
EXACTLY constant (0.019856) while the transient peak grows 100x (3.9 -> 387). Non-normality does
not move the composition threshold at all, and the whole effect below reproduces on a perfectly
NORMAL diagonal A. The Kreiss machinery is the right correction for section 4's canary thresholds
and the wrong one here.

WHAT ACTUALLY GOVERNS IT. Model (discrete, matching the primary JSRR gate rho(A) < 1):

    fast   x_{k+1} = A x_k + B theta_k
    slow   theta_{k+1} = theta_k + eps (c^T x_k + d theta_k)
    joint  M(eps) = [[A, B], [eps c^T, 1 + eps d]]          -- exactly computable

Write the fast block's open-loop DC gain  g = c^T (I-A)^{-1} B.  The reduced ("quasi-equilibrium")
slow flow is theta_{k+1} = (1 + eps a_red) theta_k with a_red = g + d, so the NAIVE threshold --
everything Parts I and II give you -- is eps_naive = 2/|a_red|.

MEASURED: eps_c -> 2/|g|, not 2/|a_red|.

THE FAILURE MODE IS CANCELLATION, and it is not exotic. a_red = g + d can be made small by a
direct slow term d that nearly cancels a large g. Part II then reads a perfectly tame reduced
coefficient (a_red = -1) while the underlying fast-loop gain is 1000. Part I reads rho(A) = 0.9
and is content. Both certificates pass, and the composed system still diverges for any
eps > ~2/g -- which at g = 1000 is 0.0019 against a naive limit of 2.0, an overestimate of ~1000x.
Neither certificate is wrong; the composition is simply not a function of the two verdicts.

PRE-REGISTERED GATES (fixed before this revision was run; the transient hypothesis above was
tested first, failed its own C3, and is reported as refuted rather than rescued):
  D1 (gain, not the reduced coefficient): with a_red pinned at -1 and g swept over 3 decades,
     eps_c tracks 2/|g| -- the ratio eps_c / (2/|g|) exceeds 0.8 at the top of the sweep and
     eps_c spans at least two decades while eps_naive is constant.
  D2 (the naive threshold is unsafe): eps_c / eps_naive < 0.01 at the top of the sweep, i.e. an
     operator satisfying Part I, satisfying Part II, and choosing eps under the reduced-flow limit
     has a DIVERGING composed system by two orders of magnitude.
  D3 (non-normality is NOT the driver): with the loop gain pinned and only non-normality varied
     100x, eps_c changes by less than 1%. This is the refutation of the first hypothesis, stated
     as a gate so it cannot be quietly dropped.
  KILL: eps_c tracks 2/|a_red| instead of 2/|g| -> the naive threshold is right and there is
     nothing to report.

Exact and deterministic -- no sampling, no simulated noise; eps_c is a bisection on the spectral
radius of an explicitly-formed 3x3. Read-only; changes no shipped code.

SCOPE, honestly. Linear, single slow variable, constant A. Section 9's real object is nonlinear
and stochastic, so this is a counterexample to the *sufficiency* of (a)+(b)+"small eps", not a
general composition theorem. That is enough to make the point: a bound that fails in the linear
regime cannot hold in the general one.

Run:  python experiments/sigma0_composition_epsilon_threshold.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "sigma0_composition_epsilon_threshold.json")
R = 0.9                        # rho(A), held fixed -- Part I's verdict is identical everywhere
A_RED = -1.0                   # reduced slow flow, held fixed -- Part II's verdict likewise
GAINS = [1.0, 2.0, 10.0, 100.0, 1000.0]
NONNORMAL_KS = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]


def joint(A, B, c, d, eps):
    n = A.shape[0]
    M = np.zeros((n + 1, n + 1))
    M[:n, :n] = A
    M[:n, n] = B
    M[n, :n] = eps * c
    M[n, n] = 1.0 + eps * d
    return M


def rho(M):
    return float(max(abs(np.linalg.eigvals(M))))


def critical_eps(A, B, c, d, hi=8.0, iters=90, lo=1e-9):
    """Largest eps with rho(M(eps)) < 1.

    The bisection floor `lo` is 1e-9, not machine-tiny, and that matters: at eps ~ 1e-14 the
    slow eigenvalue is 1 - eps|d| ~ 1 - 1e-12, and EIGENVALUES OF A NON-NORMAL MATRIX ARE
    ILL-CONDITIONED (perturbation ~ ||A||/|cond of the eigenvector basis|). With the k=100 block
    that error exceeds the 1e-12 margin, so `rho >= 1` fires on a numerically stable system and
    the routine returns a spurious 0.0. Observed exactly that on the D3 sweep before this fix.
    1e-9 sits seven decades below the measured thresholds and comfortably above the noise.
    """
    if rho(joint(A, B, c, d, hi)) < 1.0:
        return hi
    if rho(joint(A, B, c, d, lo)) >= 1.0:
        return 0.0
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if rho(joint(A, B, c, d, mid)) < 1.0:
            lo = mid
        else:
            hi = mid
    return lo


def transient_peak(A, tmax=4000):
    P, best = np.eye(A.shape[0]), 1.0
    for _ in range(tmax):
        P = A @ P
        n = float(np.linalg.norm(P, 2))
        best = max(best, n)
        if n < 1e-14:
            break
    return best


def main():
    I2 = np.eye(2)
    B = np.array([0.0, 1.0])
    rep = {"date": "2026-07-27", "rho_A_fixed": R, "a_red_fixed": A_RED,
           "gain_sweep": [], "nonnormal_control": []}

    # ── D1/D2: sweep the open-loop DC gain with BOTH certificates pinned ──────────────────
    A = np.array([[R, 0.0], [0.0, R]])            # NORMAL: non-normality plays no part
    print("=== Section 9 condition (c): where is the threshold? ===")
    print(f"Part I  pinned: rho(A) = {R} on every row (normal A -- no transient at all)")
    print(f"Part II pinned: a_red  = {A_RED} on every row  =>  eps_naive = 2.0 always\n")
    print(f"{'DC gain g':>10} {'d':>9} {'a_red':>7} {'eps_naive':>10} {'eps_c':>11} {'2/|g|':>10} {'eps_c/(2/|g|)':>14} {'overest.':>9}")
    for g in GAINS:
        c = np.array([0.0, g * (1 - R)])          # (I-A)^-1 B = [0, 1/(1-R)]  =>  dc gain = g
        dc = float(c @ np.linalg.solve(I2 - A, B))
        d = A_RED - dc                            # cancellation: d ~ -g pins a_red
        ec = critical_eps(A, B, c, d)
        en = 2.0 / abs(A_RED)
        rep["gain_sweep"].append({"g": dc, "d": d, "a_red": dc + d, "eps_naive": en,
                                  "eps_c": ec, "two_over_g": 2 / abs(dc),
                                  "ratio_to_2_over_g": ec / (2 / abs(dc)),
                                  "naive_overestimate_factor": en / ec if ec > 0 else None})
        print(f"{dc:>10.1f} {d:>9.1f} {dc+d:>7.1f} {en:>10.4f} {ec:>11.6f} {2/abs(dc):>10.6f} "
              f"{ec/(2/abs(dc)):>14.4f} {en/ec if ec>0 else float('inf'):>8.0f}x")

    # ── D3: vary ONLY non-normality, loop gain pinned ─────────────────────────────────────
    print(f"\n{'k (non-normality)':>18} {'transient':>11} {'eps_c':>11}")
    for k in NONNORMAL_KS:
        Ak = np.array([[R, k], [0.0, R]])
        c = np.array([1.0 / k, 0.0])              # 1/k pins the loop gain as k varies
        dc = float(c @ np.linalg.solve(I2 - Ak, B))
        d = A_RED - dc
        ec = critical_eps(Ak, B, c, d)
        tr = transient_peak(Ak)
        rep["nonnormal_control"].append({"k": k, "transient": tr, "dc_gain": dc, "eps_c": ec})
        print(f"{k:>18.0f} {tr:>11.2f} {ec:>11.6f}")

    gs = rep["gain_sweep"]
    top = gs[-1]
    d1 = bool(top["ratio_to_2_over_g"] > 0.8
              and (max(x["eps_c"] for x in gs) / min(x["eps_c"] for x in gs)) > 100)
    d2 = bool(top["eps_c"] / top["eps_naive"] < 0.01)
    ecs = [x["eps_c"] for x in rep["nonnormal_control"]]
    d3 = bool((max(ecs) - min(ecs)) / max(ecs) < 0.01)
    kill = bool(abs(top["eps_c"] - top["eps_naive"]) / top["eps_naive"] < 0.1)

    rep["gates"] = {
        "D1_threshold_tracks_open_loop_gain": {"PASS": d1,
                                               "eps_c_over_2_over_g_at_top": round(top["ratio_to_2_over_g"], 4)},
        "D2_naive_threshold_unsafe": {"PASS": d2,
                                      "overestimate_factor_at_top": round(top["eps_naive"] / top["eps_c"], 1)},
        "D3_nonnormality_is_NOT_the_driver": {"PASS": d3,
                                              "eps_c_spread_with_transient_varying_100x": round(
                                                  (max(ecs) - min(ecs)) / max(ecs), 8),
                                              "note": "refutes this file's first hypothesis (eps* ~ 1/Kreiss)"},
        "KILL_naive_was_right": kill,
        "VERDICT": ("WITHDRAWN - eps_c matches the naive 2/|a_red| after all"
                    if kill else
                    "CONFIRMED - (c)'s threshold is 2/|open-loop DC gain|, which neither Part I nor "
                    "Part II measures; cancellation in a_red hides it, and non-normality is NOT the cause"
                    if (d1 and d2 and d3) else "PARTIAL - see gate flags")}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)
    print(f"\nGATES: D1={d1}  D2={d2}  D3={d3}  KILL={kill}")
    print(f"VERDICT: {rep['gates']['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main()
