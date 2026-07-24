"""PRE-REGISTERED min/max for ORACLE-P — a PURPOSE-BUILT model, distilled/merged to run only
as the reliability harness intends (#2925/#2927). Follow-on to benchmark_prediction_oracle_model.py.

The prior ORACLE-1.5B = general base + wrapper. This asks the operator's question: what if the
weights were CO-DESIGNED for the harness — distilled from exec-verified teachers, merged from
hand-packed specialists, and trained so it runs only as designed? Then min/max axis A
(reliability-per-$), axis B (honesty), and SWE-bench.

THE LEVERS (each tied to a mechanism measured this session, and BOUNDED):
  L1 DISTILL-LOWERS-q. An exec-verified teacher distilled into the student raises per-step
     correctness p, i.e. LOWERS hidden-error rate q. By the measured error threshold K_c~1/q
     this LENGTHENS the reliable horizon -> the SWE/MATH lever. BOUND: distillation transfers
     only capability the teacher HAS and the verifier CONFIRMS on the student's distribution
     (reachable = teacher_cov, NOT the ceiling). You cannot distill capability that isn't there.
  L2 SPECIALIST-MERGE-drops-breadth. Hand-pack small experts (coder-segment, math-segment,
     verifier, planner); the harness is the hand-built router. Drops the breadth a generalist
     wastes params on -> smaller/faster serve -> the axis-A cost lever. BOUND: catastrophic
     NARROWING — off-distribution robustness collapses; costed explicitly as a penalty.
  L3 HONESTY-PACKED-INTO-WEIGHTS. Train representations to be linearly honest (v1.10 white-box):
     the honesty probe filter gets sharper AND nearly free -> the axis-B lever. HARD GATE: this
     is the GLOSS TRAP (measured: glossed AUROC 1.0 vs de-glossed ~chance at 0.5B). Training
     against a probe target risks Goodhart; L3's gain applies ONLY if the anti-Goodhart red-team
     (G-redteam, v1.10) passes. If it fails, L3 = 0 and axis B stays at the external-probe value.

Two scenarios, both pre-registered:
  CONSERVATIVE: Goodhart bites (L3=0), distillation modest (q x0.75), narrowing penalty full.
  OPTIMISTIC  : clean distillation (q x0.5), probe holds (L3 full), narrowing accepted (specialist product).

NOTHING here beats the 70B frontier on raw capability — that wall is parameter-bound. The
min/max is on the two axes a purpose-built small model CAN lead, plus how far SWE moves.

Run:  python experiments/benchmark_prediction_oracle_packed.py
"""

from __future__ import annotations

import json
import math
import os

OUT = os.path.join("experiments", "results", "benchmark_prediction_oracle_packed.json")
CEILING = 0.92

# ORACLE-1.5B (general base + wrapper) central predictions — the baseline to improve on.
ORACLE_GEN = {
    "HumanEval": {"p0": 0.55, "cov": 0.82, "sys": 0.81},
    "MBPP":      {"p0": 0.52, "cov": 0.80, "sys": 0.79},
    "GSM8K":     {"p0": 0.57, "cov": 0.86, "sys": 0.76},
    "MATH":      {"p0": 0.28, "cov": 0.62, "sys": 0.58},
    "LongMemEval": {"p0": 0.45, "cov": 0.68, "sys": 0.62},
    "SWE-bench-Ver": {"p0": 0.012, "cov": 0.10, "sys": 0.10},
}
FRONTIER = {"HumanEval": 0.90, "MBPP": 0.86, "GSM8K": 0.95, "MATH": 0.75, "LongMemEval": 0.72, "SWE-bench-Ver": 0.55}

# teacher coverage on the distilled distribution (exec-verified frontier teacher on segment-sized
# subtasks). This is the reachability ceiling L1 can lift the student toward. [assumed: verify]
TEACHER_COV = {"HumanEval": 0.90, "MBPP": 0.88, "GSM8K": 0.93, "MATH": 0.70,
               "LongMemEval": 0.74, "SWE-bench-Ver": 0.35}
# horizon weight — how much the K_c~1/q lengthening helps (long-horizon benchmarks gain most).
HW = {"HumanEval": 0.10, "MBPP": 0.10, "GSM8K": 0.35, "MATH": 0.80, "LongMemEval": 0.70, "SWE-bench-Ver": 0.95}


def packed_capability(name, q_mult, narrowing_penalty):
    """L1: distillation raises reachable coverage toward the teacher's; the horizon-lengthening
    from lower q converts more of the reachable gap into pass rate on long tasks."""
    g = ORACLE_GEN[name]
    # distilled coverage moves fraction (1 - q_mult) of the way from wrapper-cov to teacher-cov
    dist_cov = g["cov"] + (1 - q_mult) * max(0.0, TEACHER_COV[name] - g["cov"])
    reach = min(CEILING, dist_cov * 1.15)
    # horizon lengthening: lower q (q_mult<1) fills more of (reach - current sys) on long tasks
    horizon_fill = HW[name] * (1 - q_mult) * max(0.0, reach - g["sys"])
    packed = min(reach, g["sys"] + horizon_fill)
    packed *= (1 - narrowing_penalty * HW[name] * 0.0)  # capability itself not narrowed; robustness is (below)
    return round(packed, 3), round(dist_cov, 3), round(reach, 3)


def scenario(tag, q_mult, l3_on, narrowing_penalty):
    caps = {}
    for name in ORACLE_GEN:
        packed, dcov, reach = packed_capability(name, q_mult, narrowing_penalty)
        caps[name] = {"packed_pass@1": packed, "distilled_cov": dcov, "reachable": reach,
                      "vs_oracle_gen_pp": round((packed - ORACLE_GEN[name]["sys"]) * 100, 1),
                      "vs_frontier_pp": round((packed - FRONTIER[name]) * 100, 1)}
    # axis A: cost per correct. specialist merge (L2) cuts query cost; honesty-by-construction
    # (L3) trims the verifier bank; lower q cuts foldback invocations.
    base_query_cost = 0.12  # ORACLE-1.5B general wrapper
    q_cost = base_query_cost
    q_cost *= 0.65          # L2 specialist compression (drop breadth)
    q_cost *= (0.80 if l3_on else 1.0)   # L3 honest-by-construction -> lighter verifier bank
    q_cost *= (0.7 + 0.3 * q_mult)       # lower q -> fewer repair invocations
    avg_pass = sum(caps[n]["packed_pass@1"] for n in caps) / len(caps)
    cost_per_correct = round(q_cost / avg_pass, 3)
    # axis B: confident-wrong rate. external-probe floor 0.11 (ORACLE-1.5B). L3 packs honesty
    # into weights -> sharper filter, but ONLY if anti-Goodhart passes.
    cw_external = 0.11
    cw = round(cw_external * (0.45 if l3_on else 1.0), 3)  # L3 halves it (probe sharper + free) if it holds
    ece = round(0.08 * (0.5 if l3_on else 1.0), 3)
    # robustness cost of running "only as designed" (L2 narrowing) — the honest downside
    ood_robustness = round(1.0 - narrowing_penalty, 3)  # 1.0 = general, lower = brittle off-distribution
    return {
        "scenario": tag, "q_multiplier": q_mult, "L3_honesty_packed": l3_on,
        "narrowing_penalty": narrowing_penalty,
        "capability": caps,
        "axis_A_cost_per_correct_frontier_query=1.0": {"ORACLE_gen": 0.197, "ORACLE_P": cost_per_correct,
            "frontier": 1.268, "P_cheaper_than_frontier_x": round(1.268 / cost_per_correct, 1)},
        "axis_B_honesty": {"confident_wrong": cw, "ece": ece, "vs_frontier_cw": 0.28,
            "vs_oracle_gen_cw": cw_external},
        "SWE_focus": {"packed": caps["SWE-bench-Ver"]["packed_pass@1"],
                      "oracle_gen": ORACLE_GEN["SWE-bench-Ver"]["sys"],
                      "frontier": FRONTIER["SWE-bench-Ver"],
                      "gain_vs_gen_pp": caps["SWE-bench-Ver"]["vs_oracle_gen_pp"]},
        "off_distribution_robustness_0to1": ood_robustness,
    }


def main():
    cons = scenario("CONSERVATIVE (Goodhart bites, modest distill)", q_mult=0.75, l3_on=False, narrowing_penalty=0.5)
    opti = scenario("OPTIMISTIC (clean distill, probe holds, specialist accepted)", q_mult=0.5, l3_on=True, narrowing_penalty=0.7)

    report = {
        "date": "2026-07-24",
        "status": "PRE-REGISTERED min/max for a PURPOSE-BUILT model (ORACLE-P), before build/eval",
        "model": {
            "name": "ORACLE-P",
            "is": "ORACLE-1.5B's weights CO-DESIGNED for the harness: distilled from exec-verified teachers (ADR-0015), "
                  "merged from hand-packed small specialists, honesty packed into representations (v1.10), ternary-served (ADR-0026)",
            "vs_ORACLE_gen": "ORACLE-1.5B = general base + wrapper; ORACLE-P = weights built to run ONLY as the harness intends",
        },
        "levers": {
            "L1_distill_lowers_q": "raises per-step p -> lowers q -> lengthens reliable horizon K_c~1/q (SWE/MATH lever). BOUND: reachable = teacher coverage, not ceiling.",
            "L2_specialist_merge": "hand-packed experts, harness = hand-built router -> drop breadth -> cheaper serve (axis A). BOUND: off-distribution brittleness, costed.",
            "L3_honesty_packed": "linearly-honest representations -> sharper+free probe filter (axis B). HARD GATE: gloss trap (measured); applies only if anti-Goodhart red-team passes.",
        },
        "scenarios": {"conservative": cons, "optimistic": opti},
        "the_verdict": {
            "capability_wall_holds": "ORACLE-P still LOSES to the 70B frontier on every capability row in BOTH scenarios — distillation transfers, it does not manufacture; a 1.5B does not out-capability a 40x-larger model",
            "SWE_moves_most": f"SWE-bench: gen {ORACLE_GEN['SWE-bench-Ver']['sys']} -> conservative {cons['SWE_focus']['packed']} -> optimistic {opti['SWE_focus']['packed']} (still << frontier {FRONTIER['SWE-bench-Ver']}); the long-horizon benchmark gains most from lower q, as the error threshold predicts",
            "axis_A_win_widens": f"cost-per-correct: ORACLE-gen 0.197 -> ORACLE-P {opti['axis_A_cost_per_correct_frontier_query=1.0']['ORACLE_P']} (optimistic) = ~{opti['axis_A_cost_per_correct_frontier_query=1.0']['P_cheaper_than_frontier_x']}x cheaper/correct than frontier",
            "axis_B_win_widens_IF_gate_passes": f"confident-wrong: gen 0.11 -> optimistic {opti['axis_B_honesty']['confident_wrong']} (if anti-Goodhart holds) vs frontier 0.28; conservative stays 0.11 (Goodhart bit)",
            "the_real_cost": f"running 'only as designed' = off-distribution robustness drops to {opti['off_distribution_robustness_0to1']} (optimistic) — a specialist product, brittle outside its lane. The min/max on A/B/SWE is PAID FOR in generality.",
        },
        "falsifiable_kills": {
            "L1": "if a distilled specialist's SWE-bench does NOT exceed the wrapped-general-base by the predicted margin, q-lowering did not lengthen the horizon as the threshold law claims",
            "L3": "if the anti-Goodhart red-team FAILS (a model trained to look honest fools the probe without being honest), L3=0 — axis B does not improve and the confident-wrong stays 0.11. THIS IS THE MOST LIKELY FAILURE (measured gloss trap).",
            "L2": "if off-distribution robustness collapse makes the specialist unusable as a product, the axis-A win is illusory (cheap but too narrow to deploy)",
        },
        "honesty": {
            "measured_anchors": ["error threshold K_c~1/q (this session)", "honesty probe 0.774-0.980 @1.5B (PR#2849)",
                                 "BitDistill ternary viable (ADR-0026)", "verified cascade 8.3x cheaper (#2798)"],
            "biggest_extrapolation": "teacher-coverage numbers and the q-multipliers are ASSUMED; the whole capability column is contingent on a distillation run that has not happened, and on real phi (#2928)",
            "not_claimed": "no frontier-beating capability; no free lunch — every A/B/SWE gain is paid in generality (L2) or gated on anti-Goodhart (L3) or on a real distill (L1)",
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    for tag, sc in (("CONSERVATIVE", cons), ("OPTIMISTIC", opti)):
        print(f"\n===== ORACLE-P {tag} =====")
        print(f"{'benchmark':15s} {'gen':>6} {'PACKED':>7} {'front':>6}  {'vs gen':>7} {'vs front':>8}")
        for n, c in sc["capability"].items():
            print(f"{n:15s} {ORACLE_GEN[n]['sys']:>6.2f} {c['packed_pass@1']:>7.2f} {FRONTIER[n]:>6.2f}  "
                  f"{c['vs_oracle_gen_pp']:>+6.1f}p {c['vs_frontier_pp']:>+7.1f}p")
        a = sc["axis_A_cost_per_correct_frontier_query=1.0"]; b = sc["axis_B_honesty"]
        print(f"  axis A cost/correct: ORACLE-P {a['ORACLE_P']} = {a['P_cheaper_than_frontier_x']}x cheaper/correct than frontier (gen was 0.197)")
        print(f"  axis B confident-wrong: {b['confident_wrong']} (gen 0.11, frontier 0.28) | ECE {b['ece']}")
        print(f"  SWE-bench: {sc['SWE_focus']['packed']} (gen {sc['SWE_focus']['oracle_gen']}, frontier {sc['SWE_focus']['frontier']})")
        print(f"  off-distribution robustness: {sc['off_distribution_robustness_0to1']} (1.0=general, lower=brittle specialist)")
    print("\nverdict: capability wall to 70B HOLDS both scenarios; SWE moves most (long horizon); "
          "axis A/B wins widen but are PAID in generality (L2) and GATED on anti-Goodhart (L3).")
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
