"""PRE-REGISTERED benchmark predictions for the reliability-architecture design (#2927/#2925).

Committed BEFORE running the evals, so the predictions are falsifiable. Numbers are produced
by a transparent model from the mechanism measured THIS SESSION, not pulled from a hat. The
falsifiable CORE is the ordering + crossover of the 'novel_delta' column (the part my
mechanism predicts); the absolute system scores carry wide bars and depend on base rates that
must be re-verified before the eval.

MODEL (two stacked, separable mechanisms):
  1. Verifier amplification (NOT novel — standard best-of-N + a sound filter). Works wherever
     a verifier exists, largest where the base coverage gap is largest. Contribution:
        amp = rho_v * (cov - p0),   cov = pass@budget coverage ceiling (empirical-shape input,
                                          NOT the naive 1-(1-p0)^N which ignores sample
                                          correlation), rho_v = verifier selection precision.
  2. Foldback + decomposition (THE NOVEL PART, phi-gated). Only engages on long-horizon,
     weakly-verified tasks where hidden errors ACCUMULATE past the error threshold K_c~1/q.
     CRITICAL BOUND: decomposition recovers error-accumulation failures, it does NOT
     manufacture capability the model lacks — so the novel gain is capped at what is
     REACHABLE (cov*1.2), never the absolute ceiling. This is why a task the model simply
     cannot do per-step (SWE-bench at 1.5B, base~1%) gets little novel gain: the failure is
     raw inability, not recoverable error.
        reach = min(ceiling, cov * 1.2)
        novel = phi * horizon_weight * max(0, reach - (p0 + amp))
     phi=frustration (measured coding=0.092; math predicted high), horizon_weight in [0,1].

  system = clamp(p0 + amp + novel, 0, ceiling)

Every parameter is declared per-benchmark with its status. Base rates are APPROX PUBLIC for a
~1.5B box-served model (the sweet spot) and MUST be re-measured on the exact served checkpoint
before scoring — they are the largest source of error in the absolute column.

Run:  python experiments/benchmark_prediction_preregister.py
"""

from __future__ import annotations

import json
import os

OUT = os.path.join("experiments", "results", "benchmark_prediction_preregister.json")
CEILING = 0.92  # no wrapped small model realistically saturates; verifier precision + hard tail

# Per-benchmark parameters. STATUS tags: [approx-public: verify] / [measured] / [predicted] / [assumed].
BENCH = [
    # name, p0(base pass@1), cov(pass@budget ceiling), rho_v(verifier precision),
    #       phi(frustration), horizon_weight, notes
    {"name": "HumanEval", "p0": 0.55, "cov": 0.82, "rho_v": 0.95, "phi": 0.09, "hw": 0.05,
     "note": "exec unit tests = STRONG local verifier; phi measured 0.092 (this session); short horizon"},
    {"name": "MBPP", "p0": 0.52, "cov": 0.80, "rho_v": 0.95, "phi": 0.09, "hw": 0.05,
     "note": "same regime as HumanEval; verifier-amplification dominated"},
    {"name": "GSM8K", "p0": 0.57, "cov": 0.86, "rho_v": 0.60, "phi": 0.35, "hw": 0.30,
     "note": "answer-checkable but NO per-step exec oracle; medium horizon; phi predicted moderate"},
    {"name": "MATH", "p0": 0.28, "cov": 0.62, "rho_v": 0.55, "phi": 0.55, "hw": 0.75,
     "note": "long multi-step proofs; weak local verification; the novel mechanism's home turf"},
    {"name": "SWE-bench-Verified", "p0": 0.012, "cov": 0.10, "rho_v": 0.80, "phi": 0.60, "hw": 0.90,
     "note": "base ~0 so sampling barely helps; DECOMPOSITION-dominated (least-tested); widest bars"},
    {"name": "LongMemEval", "p0": 0.45, "cov": 0.68, "rho_v": 0.50, "phi": 0.30, "hw": 0.70,
     "note": "long-context memory QA; verifier weak (no exec); foldback ~ segment+re-ground"},
]

# uncertainty bands (pp) on the NOVEL delta, by how well-tested the regime is
NOVEL_BAND = {"HumanEval": 3, "MBPP": 3, "GSM8K": 8, "MATH": 12, "SWE-bench-Verified": 12, "LongMemEval": 12}


def predict(b):
    amp = b["rho_v"] * max(0.0, b["cov"] - b["p0"])
    after_amp = min(CEILING, b["p0"] + amp)
    reach = min(CEILING, b["cov"] * 1.2)  # novel gain is capped at REACHABLE, not the ceiling
    novel = b["phi"] * b["hw"] * max(0.0, reach - after_amp)
    system = min(CEILING, after_amp + novel)
    band = NOVEL_BAND[b["name"]] / 100.0
    return {
        "benchmark": b["name"],
        "base_pass@1_approx": round(b["p0"], 3),
        "verifier_amplification_pp": round(amp * 100, 1),
        "novel_mechanism_delta_pp": round(novel * 100, 1),
        "novel_delta_band_pp": f"±{NOVEL_BAND[b['name']]}",
        "predicted_system_central": round(system, 3),
        "predicted_system_range": [round(max(0.0, system - band - amp * 0.15), 3),
                                   round(min(CEILING, system + band), 3)],
        "status": b["note"],
    }


def main():
    rows = [predict(b) for b in BENCH]
    # falsifiable orderings. Corrected after the capability-bound fix: the novel gain peaks
    # where the model is CAPABLE per-step but ACCUMULATES errors (MATH), NOT where it is
    # raw-incapable (SWE at 1.5B). Two different reasons for ~0: HumanEval (low phi),
    # SWE (raw inability). MATH is the home turf.
    novel = {r["benchmark"]: r["novel_mechanism_delta_pp"] for r in rows}
    ordering_ok = (novel["MATH"] > novel["LongMemEval"] > novel["GSM8K"]
                   and novel["HumanEval"] <= 1.0 and novel["MBPP"] <= 1.0)
    report = {
        "date": "2026-07-24",
        "status": "PRE-REGISTERED prediction — committed before the evals; falsifiable",
        "served_model_assumed": "~1.5B box-served (Qwen2.5-1.5B / Coder-1.5B class); ternary/4-bit on 8GB",
        "budget_assumed": "~8-12 generation calls + N-verifier bank per task (verifier amplification), foldback repair on failure",
        "ceiling": CEILING,
        "predictions": rows,
        "falsifiable_core": {
            "primary_claim_novel_delta_ordering":
                "novel_delta(MATH) > novel_delta(LongMemEval) > novel_delta(GSM8K) > novel_delta(HumanEval)~novel_delta(MBPP)~0",
            "two_reasons_for_zero": "HumanEval/MBPP ~0 because phi is LOW (strong verifier); SWE-bench small because base capability is near-zero (raw inability, not recoverable error) — the novel gain needs BOTH high phi AND per-step reachability",
            "ordering_holds_in_model": bool(ordering_ok),
            "crossover_claim": "on a benchmark with a tunable length axis, the novel delta rises with horizon and crosses ~0 near K=1/q",
            "kill": "if HumanEval/MBPP novel_delta exceeds ~2pp (mechanism helping where phi is low → confounded) OR "
                    "MATH/LongMemEval novel_delta ~0 (mechanism not helping where phi is high AND model is capable → mechanism wrong)",
        },
        "honesty": {
            "what_is_mechanism_derived": "the novel_mechanism_delta column and the ORDERING (from measured phi + the foldback/threshold laws)",
            "what_is_a_lookup": "base_pass@1 (approx public, RE-VERIFY on the exact served checkpoint) and cov (pass@budget shape)",
            "what_is_standard_not_novel": "verifier_amplification (best-of-N + sound filter) — real lift, but not this design's contribution",
            "widest_bars": "SWE-bench (decomposition-dominated, least-tested) and every absolute score",
            "binding_open_input": "real phi on weak-verification workloads (#2928) — if it is <0.1 even there, every novel_delta collapses toward 0",
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("PRE-REGISTERED PREDICTIONS (~1.5B served + verifier bank + foldback), CEILING", CEILING)
    print(f"{'benchmark':20s} {'base':>6} {'+amp(std)':>10} {'+NOVEL':>8} {'=system':>9}  {'range':>13}")
    for r in rows:
        print(f"{r['benchmark']:20s} {r['base_pass@1_approx']:>6.2f} "
              f"{r['verifier_amplification_pp']:>9.1f}p {r['novel_mechanism_delta_pp']:>6.1f}p "
              f"{r['predicted_system_central']:>9.3f}  {str(r['predicted_system_range']):>13}")
    print(f"\nfalsifiable ordering (novel delta: MATH > LongMemEval > GSM8K > HumanEval~MBPP~0;"
          f" SWE small = raw inability not recoverable error) holds in model: {ordering_ok}")
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
