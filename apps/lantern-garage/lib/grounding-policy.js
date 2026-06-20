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

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

module.exports = { dilation, groundingPolicy, chatDilation, D_MIN, D_MAX, D_DEFAULT };
