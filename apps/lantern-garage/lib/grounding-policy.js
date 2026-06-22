// grounding-policy.js — the within→without bridge for the chat.
//
// JS mirror of src/convergence_io/dilation.py (G12-correct) + a chat-level dilation
// estimator. Time-dilation D is a single budget: productively-uncertain messages
// dilate (think more → ground harder); a frozen/degenerate signal collapses D toward
// D_MIN (act / go look now). groundingPolicy(D) turns D into how much EXTERNAL
// grounding to buy (web breadth, corroboration floor, deep mode).

const D_MIN = 0.1;
const D_MAX = 5.0;
const D_DEFAULT = 1.0;

// Boiling-frog defense (#1012): a HARD time cadence for external grounding. Cert §4's
// "calm while wrong" regime + the 2026 Boiling Frog Threshold result (arXiv:2603.08455)
// show internal monitors carry no extractable signal for gradual/periodic drift — so
// proximity-triggered grounding alone is provably insufficient. We re-touch external
// reality on a timer regardless of how low collapse-proximity is. Configurable via
// GROUNDING_TICK_MS; set 0 to disable. Default 30 min.
const GROUNDING_TICK_MS = (() => {
  const v = parseInt(process.env.GROUNDING_TICK_MS, 10);
  return Number.isFinite(v) ? v : 30 * 60 * 1000;
})();

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Is a mandatory grounding tick due? Pure (now/cadence injectable for tests).
//   lastGroundedAtMs : ms epoch of the last grounding, or 0/null if never
//   returns true when the cadence has elapsed (or grounding never happened).
function isGroundingDue(lastGroundedAtMs, nowMs = Date.now(), cadenceMs = GROUNDING_TICK_MS) {
  if (!cadenceMs || cadenceMs <= 0) return false; // cadence disabled
  if (!lastGroundedAtMs) return true;             // never grounded → ground now
  return nowMs - lastGroundedAtMs >= cadenceMs;
}

// Mirror of dilation() including the G12 collapse-proximity sign-fix:
// near collapse (proximity→1) D deflates toward D_MIN instead of inflating.
function dilation(uncertainty, costPressure = 0, confidence = 0.5, collapseProximity = 0) {
  uncertainty = clamp(uncertainty, 0, 1);
  costPressure = clamp(costPressure, 0, 1);
  confidence = clamp(confidence, 0, 1);
  const p = clamp(collapseProximity, 0, 1);
  const raw = (1 + uncertainty) / ((1 + confidence) * (1 + costPressure));
  let d = clamp(raw, D_MIN, D_MAX);
  d = (1 - p) * d + p * D_MIN;
  return clamp(d, D_MIN, D_MAX);
}

// Mirror of grounding_policy(): D → external-grounding budget.
function groundingPolicy(D, { baseMaxResults = 5, baseMinSources = 2 } = {}) {
  D = clamp(D, D_MIN, D_MAX);
  if (D <= 1.0) {
    return { fetchExternal: D > 0.5, maxResults: baseMaxResults, minSources: baseMinSources, deepMode: false };
  }
  return {
    fetchExternal: true,
    maxResults: Math.round(baseMaxResults * D),
    minSources: baseMinSources + (D >= 3.0 ? 1 : 0),
    deepMode: D >= 3.0,
  };
}

// Estimate chat-level dilation from the message (transparent heuristic — the chat's
// analog of the Σ₀ uncertainty signal). High when the query needs fresh reality, is
// analytical, expresses uncertainty, or is long/multi-part. `collapseProximity` lets a
// post-generation degeneration/repetition signal collapse D (go re-ground).
function chatDilation(message, { confidence = 0.5, collapseProximity = 0 } = {}) {
  const t = String(message || "");
  let u = 0.3;
  if (/\b(latest|current|today|recent|news|price|now|2024|2025|2026|this week|this month)\b/i.test(t)) u += 0.3;
  if (/\b(compare|versus|vs\.?|difference|why|how exactly|trade-?offs?|evaluate|analy[sz]e)\b/i.test(t)) u += 0.2;
  if (/\b(not sure|unsure|maybe|confus|unclear|don'?t know|is it true|verify)\b/i.test(t)) u += 0.2;
  const questions = (t.match(/\?/g) || []).length;
  if (questions >= 2) u += 0.1;
  if (t.length > 280) u += 0.1;
  return dilation(clamp(u, 0, 1), 0, confidence, collapseProximity);
}

module.exports = { dilation, groundingPolicy, chatDilation, isGroundingDue, GROUNDING_TICK_MS, D_MIN, D_MAX, D_DEFAULT };
