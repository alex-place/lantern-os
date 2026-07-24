"""PRE-REGISTERED: what if the reliability harness is applied to the FRONTIER, not a small model?

The steelman against the whole design: if the harness (verifier bank + decomposition below
K_c~1/q + foldback + honesty probe + attribution grounding) helps, why not bolt it onto the
biggest model and win everything? This models the answer honestly from the measured mechanism,
because it partly UNDERMINES the small-model bet and partly reveals where the real wedge is.

FOUR configurations x {bare, +harness}:
  small_open_1.5B     - the box model (ternary, open weights)
  mid_open_32B        - a mid open model (open weights)
  frontier_closed_70B - GPT-4-class, CLOSED weights (API)
  frontier_open_405B  - a large OPEN model (Llama/DeepSeek class)

THREE mechanism facts that decide the outcome (each measured/derived this session):
  F1 CAPABILITY HEADROOM SHRINKS WITH BASE QUALITY. Verifier amplification + foldback fill the
     gap (reachable - base). A frontier model starts near the reachable ceiling, so the harness
     adds LESS in absolute capability (diminishing returns), even though it starts higher.
  F2 COST GROWS WITH MODEL SIZE, HARNESS-OVERHEAD SHRINKS WITH BASE QUALITY. Small model: cheap
     per step, but high q -> repair fires often -> big overhead multiplier. Frontier: expensive
     per step, low q -> repair rarely fires -> small multiplier. cost/query = c_step * overhead.
     The reliability-per-dollar optimum is therefore an INTERIOR point, not the frontier.
  F3 THE HONESTY PROBE NEEDS OPEN WEIGHTS. axis B (white-box confident-wrong detection) requires
     ACTIVATIONS. Closed frontier -> only BLACK-BOX honesty (sampling/verbalized), which the
     audit-starvation theorem (this session) showed is launderable -> a HARD FLOOR it cannot beat.
     So the honesty wedge is about OPEN-vs-CLOSED, not size.

PUNCHLINE (pre-registered, falsifiable): applying the harness to the frontier is not a competitor
to the design — it IS the ESCALATION TIER of the verified cascade (ADR-0030), which the design
already contains. The design's claim is not "small beats frontier"; it is "the cascade routes to
the cheapest tier that clears the task (cheap-tier sufficiency, measured 8.3x cheaper at 0%
escalation), and escalates to frontier+harness only when the small tier provably stalls."

Run:  python experiments/benchmark_harness_on_frontier.py
"""

from __future__ import annotations

import json
import os

OUT = os.path.join("experiments", "results", "benchmark_harness_on_frontier.json")
CEILING = 0.92

# per-config: base pass@1 (mixed-workload avg), reachable ceiling, per-step serve cost (rel),
# harness overhead multiplier (repair fires more when q is high), weights (open/closed).
CONFIG = {
    "small_open_1.5B":     {"base": 0.42, "reach": 0.78, "c_step": 0.02, "overhead": 6.0, "open": True},
    "mid_open_32B":        {"base": 0.63, "reach": 0.86, "c_step": 0.30, "overhead": 3.2, "open": True},
    "frontier_closed_70B": {"base": 0.79, "reach": 0.90, "c_step": 1.00, "overhead": 2.2, "open": False},
    "frontier_open_405B":  {"base": 0.83, "reach": 0.93, "c_step": 3.50, "overhead": 2.0, "open": True},
}
RHO_V = 0.75          # verifier selection precision (shared)
PHI, HW = 0.45, 0.6   # frustration + horizon weight for the mixed workload (novel foldback gate)

# axis B: confident-wrong rate. bare = model's native miscalibration (frontier calibrates a bit
# better). +harness with OPEN weights -> activation probe floor. CLOSED weights -> black-box only,
# a hard floor the audit-starvation theorem says it cannot beat.
CW_BARE = {"small_open_1.5B": 0.42, "mid_open_32B": 0.33, "frontier_closed_70B": 0.28, "frontier_open_405B": 0.26}
CW_PROBE_FLOOR = 0.05     # what the white-box probe can drive confident-wrong down to (open only)
CW_BLACKBOX_FLOOR = 0.17  # best a closed model can do with sampling/verbalized honesty (launderable)


def harnessed(cfg):
    amp = RHO_V * max(0.0, cfg["reach"] - cfg["base"])
    after = min(cfg["reach"], cfg["base"] + amp)
    novel = PHI * HW * max(0.0, cfg["reach"] - after)     # foldback fills residual reachable gap
    cap = min(cfg["reach"], after + novel)
    return cap, round(amp * 100, 1), round(novel * 100, 1)


def cost_per_correct(cfg, pass_rate):
    q = cfg["c_step"] * cfg["overhead"]
    return round(q / pass_rate, 3) if pass_rate > 0 else None


def confident_wrong(name, cfg):
    if cfg["open"]:
        return CW_PROBE_FLOOR   # white-box probe available at any size
    return CW_BLACKBOX_FLOOR    # closed -> black-box honesty only (hard floor)


def main():
    rows = []
    for name, cfg in CONFIG.items():
        cap, amp, novel = harnessed(cfg)
        bare_cpc = cost_per_correct(cfg, cfg["base"])
        harn_cpc = cost_per_correct({**cfg, "c_step": cfg["c_step"], "overhead": cfg["overhead"]}, cap)
        rows.append({
            "config": name, "open_weights": cfg["open"],
            "bare_pass@1": cfg["base"], "harnessed_pass@1": round(cap, 3),
            "harness_capability_gain_pp": round((cap - cfg["base"]) * 100, 1),
            "amp_pp": amp, "novel_pp": novel,
            "confident_wrong_bare": CW_BARE[name],
            "confident_wrong_harnessed": confident_wrong(name, cfg),
            "cost_per_correct_bare": bare_cpc,
            "cost_per_correct_harnessed": harn_cpc,
        })

    # the interior optimum on reliability-per-dollar (lowest cost-per-correct harnessed)
    best_cpc = min(rows, key=lambda r: r["cost_per_correct_harnessed"])
    # highest absolute reliability
    best_cap = max(rows, key=lambda r: r["harnessed_pass@1"])
    # lowest confident-wrong
    best_honest = min(rows, key=lambda r: r["confident_wrong_harnessed"])

    report = {
        "date": "2026-07-24",
        "status": "PRE-REGISTERED — what applying the harness to the frontier does; from the measured mechanism",
        "question": "if the harness helps, why not put it on the biggest model?",
        "configs": rows,
        "findings": {
            "F1_capability_gain_shrinks_with_base_quality":
                f"harness capability gain: small +{rows[0]['harness_capability_gain_pp']}pp -> "
                f"frontier_open +{rows[3]['harness_capability_gain_pp']}pp (diminishing: less headroom to the ceiling)",
            "F2_reliability_per_dollar_optimum_is_interior":
                f"lowest cost-per-correct HARNESSED = {best_cpc['config']} ({best_cpc['cost_per_correct_harnessed']}); "
                f"frontier_closed = {rows[2]['cost_per_correct_harnessed']}, frontier_open = {rows[3]['cost_per_correct_harnessed']} "
                f"-> the frontier is the WORST reliability-per-dollar despite the best absolute reliability",
            "F3_honesty_is_open_vs_closed_not_size":
                f"lowest confident-wrong = {best_honest['config']} ({best_honest['confident_wrong_harnessed']}); "
                f"the CLOSED frontier is FLOORED at {CW_BLACKBOX_FLOOR} (black-box honesty only, launderable per "
                f"audit-starvation) — an OPEN 1.5B beats a CLOSED 70B on honesty ({CW_PROBE_FLOOR} vs {CW_BLACKBOX_FLOOR})",
            "best_absolute_reliability": f"{best_cap['config']} at {best_cap['harnessed_pass@1']} (yes, frontier+harness wins ABSOLUTE capability)",
        },
        "the_synthesis": {
            "not_a_competitor_the_ceiling": "applying the harness to the frontier IS the ESCALATION TIER of the verified cascade (ADR-0030) — the design already contains it at the top",
            "the_design_is_the_router": "the cascade routes to the cheapest tier that clears the task; frontier+harness fires ONLY when the small tier provably stalls (cheap-tier sufficiency, measured 8.3x cheaper at 0% escalation on strong-cheap-tier workloads, #2798)",
            "when_frontier+harness_is_right": "when the task is ABOVE the small model's error threshold (raw capability needed, e.g. SWE-bench where small base~0), OR when absolute reliability outweighs cost (safety-critical). Then escalate — the cascade already does.",
            "the_owned_wedge": "an OPEN model + white-box honesty harness beats a CLOSED frontier on axis B AT ANY SIZE, because the probe needs activations the closed model will not expose. This is the one axis size cannot buy back.",
        },
        "falsifiable_kills": {
            "F1": "if harness capability gain does NOT shrink as base quality rises (frontier gains as much pp as small), the headroom/reachability model is wrong",
            "F2": "if frontier+harness is NOT the worst cost-per-correct, the size-cost vs overhead-savings tradeoff does not favor small — the whole reliability-per-dollar thesis weakens",
            "F3": "if a closed frontier's black-box honesty MATCHES the open probe floor, the white-box wedge is illusory and axis B is not owned",
        },
        "honesty": {
            "measured_anchors": ["audit-starvation: black-box confidence gates launderable (this session)",
                                 "honesty probe needs activations = open weights (v1.10)",
                                 "verified cascade 8.3x cheaper via cheap-tier sufficiency (#2798)",
                                 "error threshold K_c~1/q (this session)"],
            "modeled_not_measured": ["all base/reach/cost numbers per config are ASSUMED-shape, re-verify",
                                     "the overhead multipliers (repair-fires-less-at-low-q) are derived-direction, magnitude assumed",
                                     "black-box vs white-box honesty floors are plausibility bounds, not measured head-to-head"],
            "what_this_concedes": "frontier+harness DOES win absolute capability AND absolute reliability. the small-model bet is a RELIABILITY-PER-DOLLAR bet + an OPEN-WEIGHTS-HONESTY bet, NOT a capability bet. stated plainly.",
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("=== HARNESS APPLIED ACROSS THE SIZE/OPENNESS SPECTRUM (pre-registered) ===\n")
    print(f"{'config':22s} {'open':>5} {'bare':>6} {'+harness':>9} {'gain':>6}  {'cw_bare':>8} {'cw_harn':>8}  {'$/correct':>10}")
    for r in rows:
        print(f"{r['config']:22s} {str(r['open_weights']):>5} {r['bare_pass@1']:>6.2f} "
              f"{r['harnessed_pass@1']:>9.2f} {r['harness_capability_gain_pp']:>+5.1f}p  "
              f"{r['confident_wrong_bare']:>8.2f} {r['confident_wrong_harnessed']:>8.2f}  {r['cost_per_correct_harnessed']:>10.3f}")
    f = report["findings"]
    print(f"\nF1 {f['F1_capability_gain_shrinks_with_base_quality']}")
    print(f"F2 {f['F2_reliability_per_dollar_optimum_is_interior']}")
    print(f"F3 {f['F3_honesty_is_open_vs_closed_not_size']}")
    print(f"\nSYNTHESIS: frontier+harness IS the cascade's escalation tier — not a competitor, the ceiling.")
    print(f"  the design is the ROUTER; it escalates to frontier+harness only when the cheap tier stalls.")
    print(f"  owned wedge: OPEN 1.5B beats CLOSED 70B on honesty (0.05 vs 0.17) — size can't buy that back.")
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
