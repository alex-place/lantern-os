"use strict";

/**
 * Surrogate leash (#2871) — cheap self-checks trusted only while re-fit against
 * ground truth.
 *
 * Precedent: surrogate-fitness evolutionary computation (UIUC US8131656B2) — the
 * cheap fitness model is only ever trusted inside a recalibration window; outside
 * it, you pay for the real evaluation. The Σ₀ analog: any cheap signal standing in
 * for real verification (a canary, a PRM-style pre-filter, a cheap-tier
 * self-assessment) must carry a leash:
 *
 *   - TRUST requires evidence: enough recent (surrogate, ground-truth) pairs AND
 *     measured agreement above the floor AND a re-fit recent enough. Missing any
 *     one ⇒ the surrogate's verdict is "no signal" and the caller pays for real
 *     verification. Distrust is the default state, not the exception.
 *   - DRIFT is detected by the same pairs: agreement below the floor flips the
 *     leash to distrust until fresh calibration restores it (the freshness law:
 *     internal signals detect, only fresh truth informs).
 *   - Staleness is counted in OBSERVATIONS, not wall-clock — deterministic, and
 *     it ties naturally to the M2/EOQ re-grounding clocks (#2853): a surrogate
 *     consulted often must be re-fit often.
 *
 * Pure in-memory mechanism with serialize()/restore() — persistence and the
 * choice of ground truth belong to the call site (exec verification, citation
 * checks). Named intended consumers: the decode canary as a reject pre-filter,
 * any future learned PRM in front of the exec verifier, cheap-tier
 * self-assessments in the cascade.
 */

const DEFAULTS = {
  window: 50, // paired samples kept for the agreement measurement
  minSamples: 10, // below this, trust is never granted (evidence first)
  minAgreement: 0.8, // measured agreement floor over the window
  maxObsSinceFit: 200, // observations allowed between calibrations before staleness
};

class SurrogateLeash {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.name = String(o.name || "surrogate");
    this.window = o.window;
    this.minSamples = o.minSamples;
    this.minAgreement = o.minAgreement;
    this.maxObsSinceFit = o.maxObsSinceFit;
    this.pairs = []; // [{s, g}] sliding window of calibration pairs
    this.obsSinceFit = 0; // observations consumed since the last calibrate()
    this.totalObs = 0;
    this.totalFits = 0;
  }

  /** Measured agreement over the window, or null with too few pairs. */
  agreement() {
    if (this.pairs.length < this.minSamples) return null;
    const agree = this.pairs.filter((p) => Boolean(p.s) === Boolean(p.g)).length;
    return agree / this.pairs.length;
  }

  /** The leash state: {trusted, reason, agreement, samples, obsSinceFit}. */
  status() {
    const a = this.agreement();
    let trusted = true;
    let reason = "calibrated";
    if (a == null) {
      trusted = false;
      reason = "insufficient-calibration";
    } else if (a < this.minAgreement) {
      trusted = false;
      reason = "drift";
    } else if (this.obsSinceFit > this.maxObsSinceFit) {
      trusted = false;
      reason = "stale";
    }
    return { trusted, reason, agreement: a, samples: this.pairs.length, obsSinceFit: this.obsSinceFit };
  }

  /**
   * Consult the surrogate. Returns {verdict, trusted, reason} — when trusted is
   * false the caller MUST treat verdict as absent and pay for real verification.
   */
  observe(surrogateVerdict) {
    this.totalObs += 1;
    this.obsSinceFit += 1;
    const st = this.status();
    return { verdict: Boolean(surrogateVerdict), trusted: st.trusted, reason: st.reason };
  }

  /** Feed a paired (surrogate, ground-truth) observation — the re-fit event. */
  calibrate(surrogateVerdict, groundTruth) {
    this.pairs.push({ s: Boolean(surrogateVerdict), g: Boolean(groundTruth) });
    if (this.pairs.length > this.window) this.pairs.shift();
    this.obsSinceFit = 0;
    this.totalFits += 1;
    return this.status();
  }

  serialize() {
    return {
      name: this.name,
      window: this.window,
      minSamples: this.minSamples,
      minAgreement: this.minAgreement,
      maxObsSinceFit: this.maxObsSinceFit,
      pairs: this.pairs.slice(),
      obsSinceFit: this.obsSinceFit,
      totalObs: this.totalObs,
      totalFits: this.totalFits,
    };
  }

  static restore(state) {
    const l = new SurrogateLeash(state || {});
    if (state) {
      l.pairs = Array.isArray(state.pairs) ? state.pairs.slice(-l.window) : [];
      l.obsSinceFit = Number(state.obsSinceFit) || 0;
      l.totalObs = Number(state.totalObs) || 0;
      l.totalFits = Number(state.totalFits) || 0;
    }
    return l;
  }
}

module.exports = { SurrogateLeash, DEFAULTS };
