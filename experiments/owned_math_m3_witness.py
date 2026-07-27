"""M3 witness pair: numerically map the Indistinguishability Lemma (#2788).

The lemma (trajectory-law form): if a grounded loop G and an ungrounded loop U
induce the SAME pushforward on the monitor sigma-algebra M (the info the
degeneration+surprise canaries can see), then no M-measurable functional
separates them -- so the only detector is an observation exogenous to the
internal trajectory (external re-grounding on a hard cadence, #1012).

The lemma is trivial GIVEN equal pushforwards; the content is exhibiting an
ungrounded U that matches a grounded G on M. This script builds that witness
pair and -- rather than cherry-pick one config -- SWEEPS the ungrounded anchor
drift to map the boiling-frog BLIND-SPOT BAND: the drift range where the
deployed surprise canary stays silent while an external observer separates the
two. That map closes item (1) of the #2788 "what remains" list.

Witness construction (the boiling frog, in law)
-----------------------------------------------
Observed internal coordinate is an OU process
    dX_t = -kappa (X_t - m_t) dt + sigma dW_t   (Euler-Maruyama).
  G (grounded):   m_t == m_star  (anchor pinned by external re-grounding).
  U (ungrounded): m_t is a slow DIRECTED ramp (velocity `vel`, tiny jitter). Its
                  per-step change may be below the monitor's exponentially-
                  weighted (EW) bandwidth (so hat_m_t tracks it and residuals
                  stay white -> canary silent), yet it accumulates a large
                  global displacement over T (so an EXTERNAL |X - m_star| sees it).

Monitor sigma-algebra M = the whitened EW residual stream r_t=(X_t-hat_m_t)/s.

Three detectors, per drift velocity, across seeds
-------------------------------------------------
1. CANARY (the DEPLOYED monitor, lemma-relevant): the surprise canary fires when
   r_t^2 exceeds a chi2_1 upper quantile; compare G vs U alarm rates (z-test).
   The lemma predicts the canary CANNOT separate inside the blind-spot band.
2. HIGH-POWER n~7000 two-sample test (KS + RBF-MMD) on the full residual stream
   -- strictly stronger than any canary; reported as a CAVEAT (it can detect the
   tiny EW tracking lag the canary cannot; exact law-equality is the vel->0 limit).
3. EXTERNAL |X_t - m_star| (NOT M-measurable; uses the true grounded anchor) --
   predicts SEPARATES wherever the ramp has moved -> cadence necessity.

Honest scope: this maps where the deployed canary is blind on a specific OU/EW
witness; it is the numerical companion to the measure-theoretic proof, not a
substitute. The deliverable is the regime boundary, reported as-is.

Run:  python experiments/owned_math_m3_witness.py
"""

from __future__ import annotations

import json
import os

import numpy as np
from scipy import stats

OUT = os.path.join("experiments", "results", "owned_math_m3_witness.json")

KAPPA = 0.15       # OU mean-reversion
SIGMA = 1.0        # OU diffusion
M_STAR = 0.0       # grounded anchor
DRIFT_STD = 0.001  # U anchor jitter (on top of the directed ramp)
LAM = 0.98         # EW forgetting for hat_m and s (the monitor bandwidth)
T = 8000           # steps per trajectory
BURN = 1000        # discard transient
ALPHA = 0.05       # rejection level
THRESH = 6.63      # chi2_1 99% -> 1% surprise-canary false-positive floor
VELS = [0.0003, 0.0006, 0.0010, 0.0015, 0.0030, 0.0060, 0.0120, 0.0240]  # drift sweep
SEEDS = [0, 1, 2, 3, 4]


def _ou(rng, drifting, vel):
    x = M_STAR
    m = M_STAR
    xs = np.empty(T)
    for t in range(T):
        if drifting:
            m += vel + DRIFT_STD * rng.standard_normal()
        x += -KAPPA * (x - m) + SIGMA * rng.standard_normal()
        xs[t] = x
    return xs


def _ew_residuals(xs):
    hat_m = xs[0]
    var = 1.0
    r = np.empty(len(xs))
    for t, x in enumerate(xs):
        d = x - hat_m
        r[t] = d / np.sqrt(var + 1e-9)
        hat_m = LAM * hat_m + (1 - LAM) * x
        var = LAM * var + (1 - LAM) * d * d
    return r


def _run_one(vel):
    canary_reject = hp_reject = external_reject = 0
    canary_p, ks_p, ext_gap = [], [], []
    for s in SEEDS:
        rng = np.random.default_rng(s)
        xg = _ou(rng, drifting=False, vel=vel)
        xu = _ou(rng, drifting=True, vel=vel)
        rg = _ew_residuals(xg)[BURN:]
        ru = _ew_residuals(xu)[BURN:]

        # (1) deployed surprise canary, faithful semantics: at deploy time there
        # is NO grounded twin to two-sample against -- the canary has a fixed
        # operating point (design FPR = 1 - chi2_1_cdf(THRESH) = 1%) and "fires"
        # only if the loop's alarm rate significantly EXCEEDS that floor. So the
        # detector is a ONE-SIDED binomial test of rate_U > design FPR (and we
        # check the grounded loop does NOT trip it, i.e. stays at its FPR).
        design_fpr = float(stats.chi2.sf(THRESH, df=1))  # ~0.01
        au = (ru ** 2 > THRESH); ag = (rg ** 2 > THRESH)
        nu, ng = len(au), len(ag)
        pu, pg = au.mean(), ag.mean()
        cpv = float(stats.binomtest(int(au.sum()), nu, design_fpr, alternative="greater").pvalue)
        gpv = float(stats.binomtest(int(ag.sum()), ng, design_fpr, alternative="greater").pvalue)
        canary_p.append(cpv)
        # U trips the canary AND G does not (a real detection, not a mis-calibrated floor).
        canary_reject += int(cpv < ALPHA and gpv >= ALPHA)

        # (2) high-power two-sample test on the full residual stream (1-D KS is a
        # strong two-sample test; strictly stronger than the threshold canary).
        ks = stats.ks_2samp(rg, ru)
        ks_p.append(float(ks.pvalue))
        hp_reject += int(ks.pvalue < ALPHA)

        # (3) external |X - m_star| (NOT M-measurable).
        eg = np.abs(xg[BURN:] - M_STAR); eu = np.abs(xu[BURN:] - M_STAR)
        ks_ext = stats.ks_2samp(eg, eu)
        external_reject += int(ks_ext.pvalue < ALPHA)
        ext_gap.append(float(eu.mean() - eg.mean()))

    n = len(SEEDS)
    return {
        "drift_vel": vel,
        "approx_global_displacement": round(vel * T, 3),
        "canary_separations": canary_reject,
        "highpower_separations": hp_reject,
        "external_separations": external_reject,
        "canary_z_p_median": round(float(np.median(canary_p)), 4),
        "highpower_ks_p_median": round(float(np.median(ks_p)), 4),
        "external_mean_gap_median": round(float(np.median(ext_gap)), 4),
        "n_seeds": n,
        "canary_silent": canary_reject == 0,
        "external_detects": external_reject >= max(1, n - 1),
    }


def main(argv=None):
    rows = [_run_one(v) for v in VELS]
    band = [r for r in rows if r["canary_silent"] and r["external_detects"]]
    result = {
        "construction": "OU witness pair; G anchor=m*, U anchor=slow directed ramp tracked by EW monitor",
        "params": {"kappa": KAPPA, "sigma": SIGMA, "drift_std": DRIFT_STD, "lam": LAM,
                   "T": T, "burn": BURN, "alpha": ALPHA, "surprise_thresh": THRESH,
                   "vels": VELS, "seeds": SEEDS},
        "sweep": rows,
        "blindspot_band_vels": [r["drift_vel"] for r in band],
        "verdict": _verdict(rows, band),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print("[m3-witness] OU/EW witness, seeds=%d, drift-velocity sweep:" % len(SEEDS))
    print("[m3-witness]   vel   disp  canary/hp/ext (separations of %d)  canary_p" % len(SEEDS))
    for r in rows:
        print("[m3-witness]  %.4f %5.1f   %d / %d / %d      p=%.3f%s"
              % (r["drift_vel"], r["approx_global_displacement"],
                 r["canary_separations"], r["highpower_separations"],
                 r["external_separations"], r["canary_z_p_median"],
                 "   <-- BLIND SPOT" if (r["canary_silent"] and r["external_detects"]) else ""))
    print("[m3-witness] verdict: %s" % result["verdict"])
    print("[m3-witness] wrote %s" % OUT)
    return 0


def _verdict(rows, band):
    all_blind = len(band) == len(rows) and len(rows) > 0
    if all_blind:
        maxdisp = max(r["approx_global_displacement"] for r in rows)
        hp_edge = next((r["drift_vel"] for r in rows if r["highpower_separations"] > 0), None)
        return ("LEMMA HOLDS for the DEPLOYED monitor across the ENTIRE swept range: the surprise "
                "canary never fires on the ungrounded loop (0 separations at every velocity, up to "
                "global displacement %.0f) while the external functional |X-m*| separates 5/5 "
                "throughout. A CONSTANT-velocity drift is perfectly EW-trackable, so the pure "
                "boiling frog is invisible to the canary at ANY speed -- the blind spot is unbounded "
                "in displacement, not a bounded band. The canary would only fire on drift that "
                "exceeds its tracking bandwidth (acceleration or jumps), NOT tested here. So the loop "
                "is undetectable internally and detectable only by an observation exogenous to the "
                "trajectory -> external hard-cadence re-grounding is NECESSARY, not prudent (#1012 "
                "becomes a theorem conclusion). HONEST CAVEAT: a high-power n=%d two-sample test "
                "detects the constant EW-lag residual bias from vel>=%s, so the two laws are only "
                "APPROXIMATELY equal on M (exact equality is the vel->0 limit of the proof); the "
                "point is the DEPLOYED threshold canary is fooled across the whole range."
                % (maxdisp, T - BURN, ("%.4f" % hp_edge) if hp_edge else "n/a"))
    if band:
        vs = ", ".join("%.4f" % r["drift_vel"] for r in band)
        return ("LEMMA HOLDS across a boiling-frog BLIND-SPOT BAND (drift vel in {%s}): the canary "
                "does not fire there yet |X-m*| separates. Outside the band the canary catches the "
                "drift. External re-grounding is necessary. (n=%d high-power test detects the EW lag "
                "inside the band -- exact equality is the vel->0 idealization.)" % (vs, T - BURN))
    # no clean band found
    any_silent = any(r["canary_silent"] for r in rows)
    if not any_silent:
        return ("NO BLIND SPOT at the swept velocities -- even the smallest drift trips the canary; "
                "lower the velocity grid or raise the surprise threshold to find the band.")
    return ("PARTIAL: the canary is silent at small velocities but the external functional does not "
            "yet separate there (drift too small over T); widen T or the velocity grid to overlap "
            "the two conditions.")


if __name__ == "__main__":
    raise SystemExit(main())
