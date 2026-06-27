// Shared plumbing for the Σ₀ serving-path canaries (collapse + groundedness).
//
// The two canaries measure ORTHOGONAL failure axes and must keep separate scores
// (a fluent-but-ungrounded "42-state" reply scores HEALTHY on the collapse axis, so
// a single blended number would let each mode hide the other — see canary.js). But
// their low-level text plumbing is identical; this module is the one place it lives,
// so the two axis modules stay DRY without merging their scores.

// Unicode word tokenizer (letters/numbers/apostrophe), lowercased.
function tokenize(text) {
  const m = String(text || "").toLowerCase().match(/[\p{L}\p{N}']+/gu);
  return m || [];
}

// Sentence/line units. `lower` lowercases (collapse axis wants case-folded literal
// self-repeat); the groundedness axis keeps case so entity capitalization survives.
function splitUnits(text, { lower = false, minLen = 8 } = {}) {
  return String(text || "")
    .split(/[\n.!?]+/)
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter((s) => s.length >= minLen);
}

module.exports = { tokenize, splitUnits };
