"""Correlated frustration — the structured counterexample to the unfold-depth law.

Rungs A/B (issue #2927) assumed hidden errors are INDEPENDENT across re-solved steps, and
derived m* = -1/ln(1-q) ~ 1/q, independent of K. That independence was named as the primary
threat to validity. This rung attacks it directly.

CAUSAL (correlated) FRUSTRATION: a wrong step POISONS everything downstream — later steps
are built on a false premise, so re-solving them cannot help. Repair works only if it
reaches back past the ROOT. The root is the FIRST wrong step, so with per-step error rate w
it is GEOMETRICALLY distributed and concentrated EARLY.

DERIVED BEFORE RUNNING (pre-registration):
    P(unfold of depth m reaches the root) = P(first K-m steps clean) = (1-w)^(K-m)
    P(fix | m) = (1-w)^(K-m) * (1-w')^m          (w' = repair-tier error rate)
    d log P / dm = log(1-w') - log(1-w) = CONSTANT in m

  => the objective is LOG-LINEAR in m: there is NO interior optimum. The optimum sits at a
     BOUNDARY, and when the repair tier is better than the original pass (w' < w) that
     boundary is m = K: FULL RESTART. Under causal frustration the depth law is not
     inaccurate, it is INAPPLICABLE — and the very policy rung A beat becomes optimal.

  Mixed regime: with correlation strength c in [0,1] (a wrong step poisons downstream with
  probability c), the objective mixes the two, so the optimum should MIGRATE from ~1/q
  (c=0) to K (c=1). That migration is the phase boundary, and its location is the
  practically useful quantity.

PRE-REGISTERED GATES (fixed before first run, 2026-07-24):
  G-C1 (counterexample exists): at c = 1, the empirical optimal depth exceeds 2x the
        depth law's 1/q prediction AND grows with K (slope of m* vs K > 0.25). This
        FALSIFIES K-independence outside the independent regime.
  G-C2 (the prescription becomes HARMFUL, not merely suboptimal): at c = 1, following rung
        B's fixed-depth-1/q policy scores WORSE than plain full restart — i.e. the advice
        inverts against the baseline it originally beat.
  G-C3 (constructive answer): root-seeking BISECT (binary search for the root using a
        prefix oracle, then unfold from there) beats both fixed-depth and full restart at
        c = 1, and its verification cost stays O(log K).
  NULL (a good outcome, recorded as such): if m* stays ~1/q at every c, independence was
        not load-bearing and the law is MORE robust than claimed.

Exact enumeration of the analytic objective + Monte-Carlo policy simulation (fixed seeds).

Run:  python experiments/folding_correlated_frustration.py
"""

from __future__ import annotations

import json
import math
import os
import random

OUT = os.path.join("experiments", "results", "folding_correlated_frustration.json")

W = 0.12          # per-step error rate, cheap/original pass
W_REPAIR = 0.05   # per-step error rate, repair (strong) tier
PHI = 1.0         # all errors hidden from local verification (worst case; isolates correlation)
SEEDS = (101, 202, 303)
N = 4000
COST = {"solve": 1.0, "verify_prefix": 0.25}   # prefix oracle is cheaper than a re-solve


def p_fix_analytic(m, K, c):
    """Mixture of the causal and independent objectives at correlation strength c.

    causal      : must reach the root (geometric, early) -> (1-W)^(K-m) * (1-W_REPAIR)^m
    independent : error uniform in position          -> (m/K)   * (1-W_REPAIR)^m
    """
    causal = ((1 - W) ** (K - m)) * ((1 - W_REPAIR) ** m)
    indep = (m / K) * ((1 - W_REPAIR) ** m)
    return c * causal + (1 - c) * indep


def optimal_depth(K, c):
    best = max(range(1, K + 1), key=lambda m: p_fix_analytic(m, K, c))
    return best, p_fix_analytic(best, K, c)


# ------------------------------------------------------------------ policy simulation
def make_instance(rng, K, c):
    """Returns (root, poisons). root = index of first wrong step or None; poisons = causal."""
    for j in range(K):
        if rng.random() < W:
            return j, (rng.random() < c)
    return None, False


def resolve_span(rng, a, b, c):
    """Re-solve steps [a,b). Returns (new_root_or_None, poisons) for the re-solved span."""
    for j in range(a, b):
        if rng.random() < W_REPAIR:
            return j, (rng.random() < c)
    return None, False


def attempt(rng, K, c, start):
    """Re-solve [start,K). Succeeds iff no new error appears in the span."""
    r, _ = resolve_span(rng, start, K, c)
    return r is None


def policy_fixed_depth(rng, K, c, q_law_depth, budget):
    """Rung B's prescription: always unfold the last m = 1/q steps."""
    root, poison = make_instance(rng, K, c)
    spend = K * COST["solve"]
    if root is None:
        return True, spend
    m = min(K, max(1, q_law_depth))
    while budget - spend >= m * COST["solve"]:
        start = K - m
        spend += m * COST["solve"]
        if poison and root < start:
            continue          # re-solving downstream of a live root cannot help
        if attempt(rng, K, c, start):
            return True, spend
    return False, spend


def policy_full_restart(rng, K, c, budget):
    root, poison = make_instance(rng, K, c)
    spend = K * COST["solve"]
    while budget - spend >= K * COST["solve"]:
        spend += K * COST["solve"]
        if attempt(rng, K, c, 0):
            return True, spend
    return bool(root is None), spend


def policy_progressive(rng, K, c, foldon, budget):
    """Rung A's policy: unfold one foldon deeper each time."""
    root, poison = make_instance(rng, K, c)
    spend = K * COST["solve"]
    if root is None:
        return True, spend
    back = 1
    while back * foldon <= K:
        start = K - back * foldon
        need = (K - start) * COST["solve"]
        if budget - spend < need:
            break
        spend += need
        if not (poison and root < start):
            if attempt(rng, K, c, start):
                return True, spend
        back += 1
    return False, spend


def policy_bisect_root(rng, K, c, budget):
    """Root-seeking: binary-search the first bad prefix with a prefix oracle, unfold there.

    Requires a stronger instrument than the end-only global verifier — a PREFIX ORACLE
    (can a valid completion follow this prefix?). Its cost is charged explicitly.
    """
    root, poison = make_instance(rng, K, c)
    spend = K * COST["solve"]
    if root is None:
        return True, spend
    while True:
        lo, hi = 0, K            # binary search for the first bad index
        probes = math.ceil(math.log2(K)) if K > 1 else 1
        if budget - spend < probes * COST["verify_prefix"]:
            return False, spend
        spend += probes * COST["verify_prefix"]
        start = root             # the oracle localizes it exactly (that is what it buys)
        need = (K - start) * COST["solve"]
        if budget - spend < need:
            return False, spend
        spend += need
        r2, poison2 = resolve_span(rng, start, K, c)
        if r2 is None:
            return True, spend
        root, poison = r2, poison2   # a new error appeared; localize again


def run_policies(K, c, q_law_depth, budget):
    out = {}
    for name in ("fixed_depth_1_over_q", "full_restart", "progressive_unfold", "bisect_root"):
        accs, spends = [], []
        for seed in SEEDS:
            rng = random.Random(seed * 977 + K * 13 + int(c * 100))
            res = []
            for _ in range(N):
                if name == "fixed_depth_1_over_q":
                    res.append(policy_fixed_depth(rng, K, c, q_law_depth, budget))
                elif name == "full_restart":
                    res.append(policy_full_restart(rng, K, c, budget))
                elif name == "progressive_unfold":
                    res.append(policy_progressive(rng, K, c, max(1, q_law_depth), budget))
                else:
                    res.append(policy_bisect_root(rng, K, c, budget))
            accs.append(sum(1 for ok, _ in res if ok) / N)
            spends.append(sum(s for _, s in res) / N)
        out[name] = {"success": round(sum(accs) / len(accs), 4),
                     "avg_spend": round(sum(spends) / len(spends), 2)}
    return out


def main():
    Ks = [16, 32, 64, 128]
    cs = [0.0, 0.25, 0.5, 0.75, 1.0]
    q = (1 - (1 - W_REPAIR)) * PHI or W_REPAIR      # hidden-error rate at repair tier
    m_law = max(1, round(-1.0 / math.log(1 - W_REPAIR)))   # rung B's prescription

    # ---------- analytic optimum migration
    grid = []
    for c in cs:
        for K in Ks:
            m_star, p = optimal_depth(K, c)
            grid.append({"c": c, "K": K, "m_star": m_star, "p_fix": round(p, 6),
                         "m_law_1_over_q": m_law,
                         "ratio_to_law": round(m_star / m_law, 2),
                         "at_boundary_K": bool(m_star == K)})

    def slope_vs_K(c):
        pts = [(g["K"], g["m_star"]) for g in grid if g["c"] == c]
        n = len(pts); mx = sum(p[0] for p in pts) / n; my = sum(p[1] for p in pts) / n
        den = sum((p[0] - mx) ** 2 for p in pts)
        return round(sum((p[0] - mx) * (p[1] - my) for p in pts) / den, 4) if den else 0.0

    slopes = {c: slope_vs_K(c) for c in cs}

    # ---------- policy contest at equal budget
    contests = []
    for c in cs:
        for K in (32, 128):
            budget = 4.0 * K
            r = run_policies(K, c, m_law, budget)
            r.update({"c": c, "K": K, "budget": budget})
            r["fixed_minus_restart_pp"] = round(
                100 * (r["fixed_depth_1_over_q"]["success"] - r["full_restart"]["success"]), 2)
            r["bisect_minus_best_other_pp"] = round(100 * (
                r["bisect_root"]["success"] - max(r["fixed_depth_1_over_q"]["success"],
                                                  r["full_restart"]["success"],
                                                  r["progressive_unfold"]["success"])), 2)
            contests.append(r)

    # ---------- gates
    c1_cells = [g for g in grid if g["c"] == 1.0]
    gc1 = bool(all(g["ratio_to_law"] > 2.0 for g in c1_cells) and slopes[1.0] > 0.25)
    c1_contests = [x for x in contests if x["c"] == 1.0]
    gc2 = bool(all(x["fixed_minus_restart_pp"] < 0 for x in c1_contests))
    gc3 = bool(all(x["bisect_minus_best_other_pp"] > 0 for x in c1_contests))
    null = bool(all(abs(g["ratio_to_law"] - 1.0) < 1.0 for g in grid))

    gates = {
        "G_C1_law_falsified_under_causal_frustration": {
            "PASS": gc1, "m_star_at_c1": {g["K"]: g["m_star"] for g in c1_cells},
            "m_law": m_law, "slope_m_vs_K_at_c1": slopes[1.0]},
        "G_C2_prescription_inverts_vs_full_restart": {
            "PASS": gc2, "fixed_minus_restart_pp_at_c1": {
                x["K"]: x["fixed_minus_restart_pp"] for x in c1_contests}},
        "G_C3_bisect_is_the_correlated_regime_answer": {
            "PASS": gc3, "bisect_advantage_pp_at_c1": {
                x["K"]: x["bisect_minus_best_other_pp"] for x in c1_contests}},
        "NULL_law_robust_everywhere": null,
        "slopes_m_star_vs_K_by_c": slopes,
    }
    gates["VERDICT"] = (
        "COUNTEREXAMPLE CONFIRMED — depth law is scoped to independent frustration; "
        "under causal frustration the optimum moves to the boundary (full restart) and "
        "root-seeking dominates" if (gc1 and gc2 and gc3)
        else "PARTIAL — see flags" if (gc1 or gc2) else "NO COUNTEREXAMPLE — law robust")

    report = {"date": "2026-07-24",
              "attacks": "the independence assumption behind m* = -1/ln(1-q) (issue #2927 rung B)",
              "derivation": "causal: P(fix|m) = (1-W)^(K-m) (1-W')^m  =>  d log P/dm constant => NO interior optimum, boundary solution",
              "params": {"W": W, "W_repair": W_REPAIR, "phi": PHI, "m_law": m_law,
                         "Ks": Ks, "cs": cs, "N": N, "seeds": list(SEEDS), "cost": COST},
              "analytic_optimum_migration": grid,
              "policy_contests": contests,
              "gates": gates}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"depth-law prescription m = {m_law}\n")
    print(f"{'c':>5} " + " ".join(f"K={K:<4}" for K in Ks) + "   slope(m* vs K)")
    for c in cs:
        row = " ".join(f"{next(g['m_star'] for g in grid if g['c']==c and g['K']==K):<6}" for K in Ks)
        print(f"{c:>5} {row}   {slopes[c]:>+.3f}")
    print("\npolicy contest (success @ equal budget):")
    print(f"{'c':>5} {'K':>5} {'fixed1/q':>9} {'restart':>8} {'progr':>7} {'bisect':>7}  {'fixed-restart':>13}")
    for x in contests:
        print(f"{x['c']:>5} {x['K']:>5} {x['fixed_depth_1_over_q']['success']:>9.3f} "
              f"{x['full_restart']['success']:>8.3f} {x['progressive_unfold']['success']:>7.3f} "
              f"{x['bisect_root']['success']:>7.3f}  {x['fixed_minus_restart_pp']:>+12.2f}pp")
    print("\nGATES:", json.dumps(gates, indent=1))
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
