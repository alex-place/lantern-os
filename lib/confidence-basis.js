"use strict";
/**
 * confidence-basis.js (#2803)
 *
 * Autowork's convergence-record confidence fields are mostly hard-coded constants
 * (`codebaseResearch: scopeFiles.length>0 ? 0.85 : 0.5`, `webGrounded: 0.8/0.4`,
 * `testsPassed: 0.9/0.3/0.0`, `overall` = a weighted sum, capped 0.95). Exactly ONE is
 * genuinely calibrated: `calibratedTrust` (#1011, Brier-calibrated against real
 * outcomes, 0.5 prior until grounded). Presenting the weighted sum as "Confidence: 84%"
 * performs a measurement that mostly isn't one — corrosive for a product whose
 * differentiator is "knows when it doesn't know."
 *
 * This module tags each field's epistemic basis so records stop performing measurement:
 *   - `measured` — outcome-calibrated (Brier). Only `calibratedTrust` today.
 *   - `prior`    — a formula constant (a label prior, not evidence). Note: some priors
 *                  are gated on a real event this run (e.g. testsPassed reflects a real
 *                  pass/fail), but their MAGNITUDES are uncalibrated constants, so they
 *                  are priors until the #1011 calibratedTrust pattern is extended to them
 *                  (step 2 of #2803).
 */

// The only fields that are genuinely outcome-calibrated. Extend this set (not the
// callers) as step 2 lands real outcome recording for more fields.
const MEASURED_FIELDS = new Set(["calibratedTrust"]);

function basisOf(field) {
  return MEASURED_FIELDS.has(field) ? "measured" : "prior";
}

// Map an entire confidence object → { field: 'measured' | 'prior' }.
function confidenceBasis(conf) {
  const out = {};
  for (const k of Object.keys(conf || {})) out[k] = basisOf(k);
  return out;
}

// A compact, honest summary for the done-event / any confidence display.
// e.g. { measured: ['calibratedTrust'], prior: [...6...],
//        label: '1 measured (calibratedTrust), 6 prior' }
function basisSummary(conf) {
  const b = confidenceBasis(conf);
  const measured = Object.keys(b).filter((k) => b[k] === "measured");
  const prior = Object.keys(b).filter((k) => b[k] === "prior");
  return {
    measured,
    prior,
    label: `${measured.length} measured (${measured.join(", ") || "none"}), ${prior.length} prior`,
  };
}

module.exports = { confidenceBasis, basisSummary, basisOf, MEASURED_FIELDS };
