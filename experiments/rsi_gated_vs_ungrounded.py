"""
rsi_gated_vs_ungrounded.py — recursive self-improvement, gated vs ungrounded, as a
runnable toy (pre-registered; replaces an unverified paste-in with a real artifact).

CONTEXT (verified 2026-07-18): frontier labs treat RSI as a near-term preparedness
problem — OpenAI runs dedicated "Researcher, Recursive Self-Improvement Safety /
Preparedness" roles ($445k, safety team, "any mitigation for loss of control risk";
openai.com/careers). The mechanism risks named across the 2025-26 literature are
instability, ERROR ACCUMULATION ACROSS CYCLES, and loss of oversight — i.e. exactly the
collapse/drift modes SIGMA0-COLLAPSE-CERTIFICATE.md formalizes. This toy demonstrates the
mechanism at minimal scale and measures what the Σ_θ-style gate + freshness discipline buy.

MODEL (the load-bearing realism choices, stated):
  * Each cycle the system proposes a self-modification with TRUE effect
    δ_true ~ N(μ_prop, σ_prop), μ_prop ≤ 0 — most self-proposed changes are not
    improvements; progress must come from SELECTING the good ones.
  * SELF-assessment: δ_self = δ_true + b_t + ε. The assessor's bias ACCUMULATES when
    acceptance is driven by its own flattery: b_{t+1} = b_t + η·(δ_self − δ_true) on
    ungrounded accepts — accepting on self-assessment trains the assessor to flatter
    (the error-accumulation mechanism the RSI literature names; same shape as the
    cert's §8.4.1 stuck-error ratchet, one level up).
  * EXTERNAL verification: δ_ext = δ_true + ε_ext (small noise), available only every
    k-th cycle — verification THROUGHPUT is the scarce resource (Grounding Ledger budget).
  * TWO capabilities tracked per arm: TRUE capability (compounds accepted δ_true) and
    BELIEVED capability (compounds accepted δ_self) — their gap is SELF-DELUSION, the
    sharpest RSI failure metric ("the system thinks it is improving").

ARMS:
  ungrounded    accept iff δ_self > 0                       (pure internal RSI)
  gated         accept only at verification cycles iff δ_ext > 0   (Σ_θ-style anchor)
  screened      internal screen THEN external gate: δ_self > 0 AND δ_ext > 0 at verify
                cycles ("internal signals detect; only fresh truth selects", operational)

PRE-REGISTERED HYPOTHESES (before the run):
  H1 (delusion): ungrounded acceptance precision DEGRADES over cycles (bias accumulation)
     and its believed/true gap grows ≫ the gated arms' (which stay ≈ 0).
  H2 (bounded, better): gated TRUE capability ≥ ungrounded TRUE capability in the median,
     with lower cross-seed dispersion and no crash tail.
  H3 (throughput law): gated improvement rate scales with verification frequency 1/k over
     k ∈ {1, 2, 4, 8} — RSI is verification-throughput-limited, not proposal-limited.
  KILL: if ungrounded matches gated on true capability AND precision, the grounding story
     adds nothing at toy scale and the blueprint subsection must not cite this.

Evidence class: MEASURED (toy illustration, CPU). Explicitly NOT new theory — the cert's
measured/proven results are the load-bearing ones; this is the RSI-shaped demonstration of
them for AGI-CONVERGENCE-BLUEPRINT.md §CONVERGE.

Run:  python experiments/rsi_gated_vs_ungrounded.py   (numpy only, seconds, CPU)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "data" / "sigma0" / "rsi_gated_report.json"

CYCLES = 60
SEEDS = 200
MU_PROP, SIGMA_PROP = -0.01, 0.06     # most proposals are not improvements
SIGMA_SELF, SIGMA_EXT = 0.04, 0.01    # self-assessment noisier than external verification
ETA = 0.35                            # assessor-bias learning rate on flattering accepts
K_DEFAULT = 4                         # external verification every k-th cycle
K_SWEEP = (1, 2, 4, 8)


def run_arm(arm, seed, k=K_DEFAULT, cycles=CYCLES):
    rng = np.random.default_rng((seed, hash(arm) & 0xFFFF, k))
    true_log = 0.0
    believed_log = 0.0
    bias = 0.0
    accepts = goods = 0
    precision_late = precision_early = [0, 0]  # [good, total] — filled below
    early, late = [0, 0], [0, 0]
    for t in range(cycles):
        d_true = rng.normal(MU_PROP, SIGMA_PROP)
        d_self = d_true + bias + rng.normal(0.0, SIGMA_SELF)
        verify_cycle = (t % k) == 0
        if arm == "ungrounded":
            accept = d_self > 0
        elif arm == "gated":
            accept = verify_cycle and (d_true + rng.normal(0.0, SIGMA_EXT)) > 0
        elif arm == "screened":
            accept = verify_cycle and d_self > 0 and (d_true + rng.normal(0.0, SIGMA_EXT)) > 0
        else:
            raise ValueError(arm)
        if accept:
            true_log += d_true
            believed_log += d_self
            accepts += 1
            goods += int(d_true > 0)
            (early if t < cycles // 2 else late)[1] += 1
            (early if t < cycles // 2 else late)[0] += int(d_true > 0)
            if arm == "ungrounded":
                bias += ETA * (d_self - d_true)   # flattery reinforces the assessor
    prec = goods / accepts if accepts else float("nan")
    prec_e = early[0] / early[1] if early[1] else float("nan")
    prec_l = late[0] / late[1] if late[1] else float("nan")
    return {"true": float(np.exp(true_log)), "believed": float(np.exp(believed_log)),
            "delusion": float(np.exp(believed_log - true_log)), "precision": prec,
            "precision_early": prec_e, "precision_late": prec_l,
            "accepts": accepts, "final_bias": bias}


def summarize(rows):
    t = np.array([r["true"] for r in rows])
    d = np.array([r["delusion"] for r in rows])
    pe = np.array([r["precision_early"] for r in rows]); pe = pe[~np.isnan(pe)]
    pl = np.array([r["precision_late"] for r in rows]); pl = pl[~np.isnan(pl)]
    return {"true_median": float(np.median(t)), "true_iqr": float(np.subtract(*np.percentile(t, [75, 25]))),
            "crash_rate": float(np.mean(t < 0.8)),
            "delusion_median": float(np.median(d)),
            "precision_early": float(np.mean(pe)) if len(pe) else None,
            "precision_late": float(np.mean(pl)) if len(pl) else None}


def main():
    arms = {a: summarize([run_arm(a, s) for s in range(SEEDS)])
            for a in ("ungrounded", "gated", "screened")}
    print(f"== RSI toy: {CYCLES} cycles, {SEEDS} seeds, verify every k={K_DEFAULT} ==")
    for a, r in arms.items():
        print(f"  {a:>10}: true×{r['true_median']:.2f} (IQR {r['true_iqr']:.2f}, crash {r['crash_rate']:.0%})"
              f"  delusion×{r['delusion_median']:.2f}  precision early→late "
              f"{(r['precision_early'] or 0):.2f}→{(r['precision_late'] or 0):.2f}")

    sweep = {k: summarize([run_arm("gated", s, k=k) for s in range(SEEDS)])["true_median"]
             for k in K_SWEEP}
    print("  throughput sweep (gated, true median by verify-every-k): "
          + "  ".join(f"k={k}:×{v:.2f}" for k, v in sweep.items()))

    u, g, sc = arms["ungrounded"], arms["gated"], arms["screened"]
    h1 = (u["precision_late"] < u["precision_early"] - 0.05) and \
         (u["delusion_median"] > 3 * max(g["delusion_median"], sc["delusion_median"]))
    h2 = (g["true_median"] >= u["true_median"]) and (g["true_iqr"] < u["true_iqr"]) and \
         (g["crash_rate"] <= u["crash_rate"])
    ks = list(K_SWEEP)
    h3 = all(sweep[ks[i]] >= sweep[ks[i + 1]] - 0.02 for i in range(len(ks) - 1)) and \
         (sweep[1] > sweep[8] + 0.05)
    kill = (abs(u["true_median"] - g["true_median"]) < 0.02 and
            u["precision_late"] is not None and g["precision_late"] is not None and
            abs(u["precision_late"] - g["precision_late"]) < 0.02)
    ok = h1 and h2 and h3 and not kill

    report = {"claim": "ungrounded RSI self-corrupts (assessor-bias ratchet -> precision decay "
                       "+ believed/true delusion); a Σ_θ-style external gate bounds it and still "
                       "improves; improvement rate is verification-throughput-limited",
              "params": {"cycles": CYCLES, "seeds": SEEDS, "mu_prop": MU_PROP, "sigma_prop": SIGMA_PROP,
                         "sigma_self": SIGMA_SELF, "sigma_ext": SIGMA_EXT, "eta": ETA, "k": K_DEFAULT},
              "arms": arms, "throughput_sweep_true_median": {str(k): round(v, 3) for k, v in sweep.items()},
              "verdicts": {"H1_delusion_and_precision_decay": bool(h1),
                           "H2_gated_bounded_and_no_worse": bool(h2),
                           "H3_throughput_limited": bool(h3),
                           "kill_grounding_adds_nothing": bool(kill)},
              "reproduced": bool(ok),
              "verified_context": "OpenAI 'Researcher, Recursive Self-Improvement Safety/"
                                  "Preparedness' roles (openai.com/careers, verified 2026-07-18)",
              "evidence_class": "MEASURED (toy illustration; demonstrates cert results at RSI "
                                "scale — NOT new theory)"}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n  H1 delusion+decay: {'PASS' if h1 else 'FAIL'} | H2 gated bounded/no-worse: "
          f"{'PASS' if h2 else 'FAIL'} | H3 throughput-limited: {'PASS' if h3 else 'FAIL'} | "
          f"kill: {kill}")
    print(f"{'REPRODUCED: ungrounded RSI deludes itself; the gate makes improvement real and bounded' if ok else 'NOT reproduced — inspect before citing'}")
    print(f"-> {OUT.relative_to(REPO)}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
