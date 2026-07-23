"use strict";
// #2787 (M2 math) / #2853 (conv-engine Remember) — the EOQ re-grounding cadence.
//
// The shipped grounding tick is a magic constant (grounding-policy.js GROUNDING_TICK_MS,
// 30 min for every fact). M2's grounding half-life law replaces it with a DERIVED, per-key
// cadence: claims go stale at rate ρ (per claim-type), and under a renewal model with
// verification price p_v and error cost p_e the optimal re-grounding interval is the EOQ
// square-root law
//
//     T* = √( 2·(p_v/p_e) / ρ )
//
// This module is the live JS twin of experiments/owned_math_m1_m2_ledger_scan.py::scan_m2 —
// it estimates ρ the SAME way (de-bursted censored-exposure MLE over the both-class
// grounding-calibration ledger) so the served cadence matches the measured one. It EXTENDS
// the existing grounding cadence seam (feeds isGroundingDue), reads the existing calibration
// ledger, and adds no new store.
//
// HONEST FALLBACK (the #2787 "kill" criterion): when a key has too few flips / no exposure to
// fit ρ, groundingCadenceForKey returns null → the caller keeps the constant GROUNDING_TICK_MS.
// A per-key cadence only overrides the constant where reality supports it.

const { isGroundingDue, GROUNDING_TICK_MS } = require("./grounding-policy");

const DEBURST_MS = 60 * 1000; // probes < 60 s apart are one observation (matches scan_m2)
const DEFAULT_PV_PE = 0.1; // p_verify / p_error; mid of the doc's [0.01, 1] bracket
// Guard rails so a tiny-sample ρ can't yield an absurd cadence.
const MIN_CADENCE_MS = 60 * 1000; // 1 min floor
const MAX_CADENCE_MS = 24 * 60 * 60 * 1000; // 24 h cap

function _ms(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function _isOne(o) {
  return o === 1 || o === true;
}
function _isZero(o) {
  return o === 0 || o === false;
}

/**
 * Estimate the staleness rate ρ (per SECOND) from calibration events for ONE key.
 * Censored-exposure exponential MLE: ρ = (success→failure flips) / (time spent last-success),
 * de-bursting consecutive probes < 60 s apart. Mirrors scan_m2 exactly.
 *
 * @param {Array<{ts:(string|number), outcome:(0|1|boolean)}>} events
 * @returns {{rhoPerSec:(number|null), nFlips:number, exposureSec:number, halfLifeHours:(number|null), nBurstDropped:number}}
 */
function estimateDecayRate(events) {
  const pts = [];
  for (const e of events || []) {
    const t = _ms(e && e.ts);
    const o = e && e.outcome;
    if (t == null) continue;
    if (!_isOne(o) && !_isZero(o)) continue;
    pts.push([t, _isOne(o) ? 1 : 0]);
  }
  pts.sort((a, b) => a[0] - b[0]);

  let flips = 0;
  let exposureMs = 0;
  let burstDropped = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, o0] = pts[i];
    const [t1, o1] = pts[i + 1];
    const dt = t1 - t0;
    if (dt <= 0) continue;
    if (dt < DEBURST_MS) {
      burstDropped++;
      continue;
    }
    if (o0 === 1) {
      exposureMs += dt;
      if (o1 === 0) flips++;
    }
  }

  if (flips === 0 || exposureMs <= 0) {
    return { rhoPerSec: null, nFlips: flips, exposureSec: exposureMs / 1000, halfLifeHours: null, nBurstDropped: burstDropped };
  }
  const exposureSec = exposureMs / 1000;
  const rhoPerSec = flips / exposureSec;
  return {
    rhoPerSec,
    nFlips: flips,
    exposureSec,
    halfLifeHours: Math.log(2) / rhoPerSec / 3600,
    nBurstDropped: burstDropped,
  };
}

/**
 * EOQ optimal re-grounding interval in MS: T* = √(2·(p_v/p_e)/ρ), computed in seconds (to
 * match the doc's bracket) then scaled to ms and clamped to [MIN_CADENCE_MS, MAX_CADENCE_MS].
 * Returns null when ρ is missing/non-positive (→ caller uses the constant tick).
 */
function eoqIntervalMs(rhoPerSec, { pVerify, pError } = {}) {
  if (!(rhoPerSec > 0)) return null;
  const ratio = pVerify != null && pError != null && pError > 0 ? pVerify / pError : DEFAULT_PV_PE;
  const tStarSec = Math.sqrt((2 * ratio) / rhoPerSec);
  return Math.max(MIN_CADENCE_MS, Math.min(MAX_CADENCE_MS, tStarSec * 1000));
}

/**
 * Derive the per-key re-grounding cadence (ms) from the calibration ledger rows. Filters to
 * `key`, estimates ρ, applies the EOQ law. Returns null when the ledger can't yet fit ρ for
 * this key — the honest fallback to the constant GROUNDING_TICK_MS.
 *
 * @param {string} key
 * @param {Array<{key:string, ts:(string|number), outcome:(0|1|boolean)}>} calRows
 * @param {{pVerify?:number, pError?:number}} [opts]
 * @returns {{cadenceMs:(number|null), rhoPerSec:(number|null), nFlips:number, halfLifeHours:(number|null)}}
 */
function groundingCadenceForKey(key, calRows, opts = {}) {
  const rows = (calRows || []).filter((r) => r && String(r.key) === String(key));
  const est = estimateDecayRate(rows);
  const cadenceMs = eoqIntervalMs(est.rhoPerSec, opts);
  return { cadenceMs, rhoPerSec: est.rhoPerSec, nFlips: est.nFlips, halfLifeHours: est.halfLifeHours };
}

/**
 * Live decision: is a re-grounding due for `key`? Uses the EOQ-derived per-key cadence when the
 * ledger supports it, else falls back to the constant GROUNDING_TICK_MS. Pure — inject now/rows.
 * Returns { due, cadenceMs, derived } (derived=false ⇒ constant fallback).
 */
function isRegroundingDue(key, lastGroundedAtMs, { nowMs = Date.now(), calRows = [], pVerify, pError } = {}) {
  const { cadenceMs } = groundingCadenceForKey(key, calRows, { pVerify, pError });
  const derived = cadenceMs != null;
  const effective = derived ? cadenceMs : GROUNDING_TICK_MS;
  return { due: isGroundingDue(lastGroundedAtMs, nowMs, effective), cadenceMs: effective, derived };
}

module.exports = {
  estimateDecayRate,
  eoqIntervalMs,
  groundingCadenceForKey,
  isRegroundingDue,
  DEBURST_MS,
  DEFAULT_PV_PE,
  MIN_CADENCE_MS,
  MAX_CADENCE_MS,
};
