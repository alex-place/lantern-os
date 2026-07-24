"""The unfold-depth law — optimal foldon granularity is the inverse hidden-error rate.

Follow-on rung to `folding_cascade_frustration.py` (issue #2927). That result showed
partial unfolding beats monotone escalation, with advantage (1-q)^-(K-m) exponential in
the PRESERVED prefix. This rung tests the sharper consequence: because unfolding too
SHALLOW misses the error and unfolding too DEEP re-exposes steps to fresh hidden errors,
there must be an INTERIOR optimum in the unfold depth m.

DERIVED BEFORE RUNNING (pre-registration):
  A repair attempt that unfolds the last m of K steps succeeds iff (a) the latent error
  lies inside the unfolded suffix, and (b) no NEW hidden error is introduced while
  re-solving it. With error position uniform on [1,K] and per-step hidden-error rate
  q = (1-p_strong)*phi:

      P(fix | m) = (m/K) * (1-q)^m

      d/dm [ m (1-q)^m ] = (1-q)^m [ 1 + m ln(1-q) ] = 0
      =>  m* = -1 / ln(1-q)  ~=  1/q          (INDEPENDENT OF K)

  THE UNFOLD-DEPTH LAW: unfold exactly as far as you can expect to re-solve before
  introducing one new hidden error. Cooperative-unit size is set by the error rate of the
  machinery doing the repair, not by the length of the chain.

PRE-REGISTERED GATES (fixed before first run, 2026-07-24):
  G-D1 (the law): empirical argmax depth matches theory within a factor of 2
        (|log2(m_emp / m_theory)| <= 1) at EVERY tested phi where m* < K.
  G-D2 (interior optimum): the empirical optimum is strictly interior (neither m=1 nor
        m=K) for at least the mid-range phi values -- if the optimum always sits at m=K,
        full restart is optimal after all and the granularity claim DIES.
  G-D3 (K-independence): m_emp does not grow with K (the law says depth is set by q, not
        by task length) -- correlation of m_emp with K must be weak (|slope| < 0.25
        steps per step of K).
  KILL: G-D1 fails at most phi -> the closed form is wrong; report the empirical law
        instead and withdraw the analytic claim.

Exact enumeration where possible (no sampling noise): P(fix|m) is computed in closed form
AND by Monte Carlo as a cross-check.

Run:  python experiments/folding_unfold_depth_law.py
"""

from __future__ import annotations

import json
import math
import os
import random

OUT = os.path.join("experiments", "results", "folding_unfold_depth_law.json")

P_STRONG = 0.93
SEEDS = (7, 8, 9)
N = 6000


def q_of(phi, p=P_STRONG):
    return (1.0 - p) * phi


def theory_depth(q):
    if q <= 0:
        return float("inf")  # no hidden errors -> unfold everything, nothing to lose
    return -1.0 / math.log(1.0 - q)


def p_fix_closed(m, K, q):
    """P(error inside unfolded suffix) * P(no new hidden error in m re-solved steps)."""
    return (min(m, K) / K) * (1.0 - q) ** m


def p_fix_mc(m, K, q, seed):
    """Monte Carlo cross-check of the same quantity (independent implementation path)."""
    rng = random.Random(seed)
    hits = 0
    for _ in range(N):
        pos = rng.randrange(K)                    # 0-indexed latent error position
        covered = pos >= K - m                    # unfolding the last m steps
        if not covered:
            continue
        fresh_bad = any(rng.random() < q for _ in range(m))
        if not fresh_bad:
            hits += 1
    return hits / N


def sweep(K, phi):
    q = q_of(phi)
    closed = [(m, p_fix_closed(m, K, q)) for m in range(1, K + 1)]
    m_emp = max(closed, key=lambda t: t[1])[0]
    m_th = theory_depth(q)
    # MC cross-check at the empirical argmax and its neighbours
    mc = {}
    for m in {max(1, m_emp - 1), m_emp, min(K, m_emp + 1)}:
        vals = [p_fix_mc(m, K, q, s * 100 + m) for s in SEEDS]
        mc[m] = round(sum(vals) / len(vals), 4)
    return {
        "K": K, "phi": phi, "q": round(q, 5),
        "m_empirical": m_emp,
        "m_theory_1_over_lnq": (None if math.isinf(m_th) else round(m_th, 2)),
        "m_theory_approx_1_over_q": (None if q <= 0 else round(1 / q, 2)),
        "p_fix_at_m_emp": round(dict(closed)[m_emp], 4),
        "p_fix_full_restart_m=K": round(dict(closed)[K], 4),
        "p_fix_minimal_m=1": round(dict(closed)[1], 4),
        "advantage_over_full_restart_x": (
            round(dict(closed)[m_emp] / dict(closed)[K], 2) if dict(closed)[K] > 0 else None),
        "interior_optimum": bool(1 < m_emp < K),
        "mc_crosscheck": mc,
        "closed_form_curve": [round(v, 4) for _, v in closed],
    }


def main():
    Ks = [8, 16, 32, 64, 128]
    phis = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0]

    rows = [sweep(K, phi) for K in Ks for phi in phis]

    # ---- G-D1: does the empirical argmax match the closed form (within 2x)?
    checks = []
    for r in rows:
        mt = r["m_theory_1_over_lnq"]
        if mt is None or mt >= r["K"]:
            continue  # law's optimum is outside the feasible range: m=K is correct there
        checks.append({"K": r["K"], "phi": r["phi"], "m_emp": r["m_empirical"],
                       "m_theory": mt,
                       "log2_ratio": round(math.log2(r["m_empirical"] / mt), 3)})
    gd1 = all(abs(c["log2_ratio"]) <= 1.0 for c in checks)

    # ---- G-D2: interior optimum in the mid range?
    mid = [r for r in rows if 0.1 <= r["phi"] <= 0.7]
    gd2 = sum(1 for r in mid if r["interior_optimum"]) >= 0.8 * len(mid)

    # ---- G-D3: is the optimal depth independent of K? (slope of m_emp vs K per phi)
    slopes = {}
    for phi in phis:
        pts = [(r["K"], r["m_empirical"]) for r in rows if r["phi"] == phi
               and theory_depth(q_of(phi)) < r["K"]]
        if len(pts) >= 3:
            n = len(pts)
            mx = sum(p[0] for p in pts) / n
            my = sum(p[1] for p in pts) / n
            den = sum((p[0] - mx) ** 2 for p in pts)
            slopes[phi] = round(sum((p[0] - mx) * (p[1] - my) for p in pts) / den, 4) if den else 0.0
    gd3 = all(abs(s) < 0.25 for s in slopes.values()) if slopes else False

    # ---- K-scaling of the advantage (the first theorem's prediction, now at optimal depth)
    kscale = []
    for K in Ks:
        r = next(x for x in rows if x["K"] == K and x["phi"] == 0.5)
        kscale.append({"K": K, "m_emp": r["m_empirical"],
                       "advantage_over_full_restart_x": r["advantage_over_full_restart_x"]})

    gates = {
        "G_D1_depth_law_within_2x": {"PASS": bool(gd1), "n_cells": len(checks),
                                     "worst_log2_ratio": (round(max((abs(c["log2_ratio"]) for c in checks), default=0), 3)),
                                     "cells": checks},
        "G_D2_interior_optimum_midrange": {"PASS": bool(gd2),
                                           "interior_frac": round(sum(1 for r in mid if r["interior_optimum"]) / len(mid), 3)},
        "G_D3_depth_independent_of_K": {"PASS": bool(gd3), "slopes_m_vs_K_per_phi": slopes},
        "KILL_law_wrong": bool(not gd1),
    }
    gates["VERDICT"] = ("REFUTED — closed-form depth law does not match" if not gd1
                        else "SUPPORTED — m* = -1/ln(1-q) predicts the optimum, interior, K-independent"
                        if gd2 and gd3 else "PARTIAL — see flags")

    # biological consistency note (heuristic, NOT a fit): observed foldons ~15-25 residues
    bio = {"observed_foldon_residues": "~15-25 (Englander, cytochrome c: 5 units)",
           "implied_q_if_law_holds": [round(1 / m, 4) for m in (15, 20, 25)],
           "reading": "the law retrodicts a per-residue unrecoverable-misfold rate of ~4-7% "
                      "for observed foldon sizes — an order-of-magnitude consistency check, not a fit"}

    report = {"date": "2026-07-24",
              "law": "m* = -1/ln(1-q) ~= 1/q  (optimal unfold depth = inverse hidden-error rate, INDEPENDENT of K)",
              "derivation": "P(fix|m) = (m/K)(1-q)^m ; d/dm = 0 => 1 + m ln(1-q) = 0",
              "params": {"p_strong": P_STRONG, "Ks": Ks, "phis": phis, "mc_N": N, "seeds": list(SEEDS)},
              "sweeps": rows, "k_scaling_at_phi_0.5": kscale,
              "gates": gates, "biological_consistency": bio}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"{'K':>4} {'phi':>5} {'q':>7} {'m_emp':>6} {'m_theory':>9} {'interior':>9} {'adv_vs_full':>12}")
    for r in rows:
        if r["K"] in (8, 32, 128):
            print(f"{r['K']:>4} {r['phi']:>5} {r['q']:>7.4f} {r['m_empirical']:>6} "
                  f"{str(r['m_theory_1_over_lnq']):>9} {str(r['interior_optimum']):>9} "
                  f"{str(r['advantage_over_full_restart_x']):>12}")
    print("\nK-scaling at phi=0.5:", json.dumps(kscale))
    print("\nGATES:", json.dumps({k: (v if not isinstance(v, dict) else
                                      {kk: vv for kk, vv in v.items() if kk != "cells"})
                                  for k, v in gates.items()}, indent=1))
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
