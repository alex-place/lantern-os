// Σ₀ model-internal surprise signal for the Verify stage (groundedness axis).
//
// The groundedness canary (./groundedness-canary.js, #1260) scores the 42-state —
// confident + unanchored — from TEXT alone (assertion density, hedging, citations).
// That is model-agnostic but blind to one thing only the model knows: was it
// internally *uncertain* about the very tokens it asserted so fluently?
//
// surprise_i = -log2 p(token_i)  [bits]  — the per-token code length (§ Shannon).
// High surprise concentrated on content tokens (names, numbers, dates) = the model
// was guessing the specifics it stated confidently. This is the token-level reading
// of the semantic-entropy hallucination signal (Farquhar et al., Nature 2024):
// elevated generation uncertainty predicts confabulation.
//
// This module is the model-AGNOSTIC primitive: parse whatever per-token logprobs a
// provider exposes (OpenAI-style, Ollama-style, or a local loop_lm/decode_canary
// stream) into a compact surprise field, and map that field to an internal-
// uncertainty scalar in [0,1]. It is a PURE function module — no I/O, no model.
// When no provider exposes logprobs (e.g. Anthropic), the consumer simply gets
// nothing and behaves exactly as before (graceful no-op).
//
// Measured provenance: docs/research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md §7
// (the lapse FIELD is real even though depth-as-storage was killed).

const LN2 = Math.log(2);
const round = (x) => Number(Number(x).toFixed(4));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// A natural-log logprob (OpenAI/most APIs) → bits of surprise.
function logprobToBits(lp) {
  return lp == null || !Number.isFinite(Number(lp)) ? null : -Number(lp) / LN2;
}

// OpenAI-style streamed logprobs: choices[0].logprobs.content = [{ token, logprob }].
// Returns [{ token, bits }].
function fromOpenAILogprobs(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    const bits = c && typeof c.logprob === "number" ? -c.logprob / LN2 : null;
    if (bits != null && Number.isFinite(bits)) out.push({ token: (c && c.token) || "", bits });
  }
  return out;
}

// Ollama-style (when present): array of { token, logprob } or { token, prob }.
function fromOllamaLogprobs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    let bits = null;
    if (c && typeof c.logprob === "number") bits = -c.logprob / LN2;
    else if (c && typeof c.prob === "number" && c.prob > 0) bits = -Math.log(c.prob) / LN2;
    if (bits != null && Number.isFinite(bits)) out.push({ token: (c && c.token) || "", bits });
  }
  return out;
}

// Aggregate a per-token bits array into a compact, JSON-loggable field summary.
function surpriseField(perToken) {
  const bits = (perToken || []).map((t) => (t && typeof t.bits === "number" ? t.bits : t))
    .filter((b) => Number.isFinite(b));
  if (!bits.length) return null;
  const n = bits.length;
  const mean = bits.reduce((a, b) => a + b, 0) / n;
  const sorted = [...bits].sort((a, b) => a - b);
  const p90 = sorted[Math.min(n - 1, Math.floor(0.9 * (n - 1)))];
  // tail mass: fraction of tokens costing > 6 bits (p < 1/64) — "the model was guessing".
  const tailMass = bits.filter((b) => b > 6).length / n;
  return {
    nTokens: n,
    meanBits: round(mean),
    p90Bits: round(p90),
    maxBits: round(sorted[n - 1]),
    tailMass: round(tailMass),
  };
}

// Map a field summary to an internal-uncertainty scalar in [0,1].
// tailMass (already a fraction) is the primary driver; p90 is a saturating secondary
// (4 bits ≈ confident, 12 bits ≈ very unsure). Calibrated so fluent text → ~0.
function fieldToUncertainty(field) {
  if (!field) return 0;
  const tail = clamp01(field.tailMass);
  const p90 = clamp01((field.p90Bits - 4) / 8);
  return round(clamp01(0.7 * tail + 0.3 * p90));
}

// Normalize whatever a caller passes as `tokenSurprise` into an uncertainty scalar:
//   - a number  → treated as an already-computed uncertainty in [0,1]
//   - a field   → fieldToUncertainty
//   - an array  → surpriseField → fieldToUncertainty (accepts [{bits}] or [number])
function toUncertainty(tokenSurprise) {
  if (tokenSurprise == null) return 0;
  if (typeof tokenSurprise === "number") return clamp01(tokenSurprise);
  if (Array.isArray(tokenSurprise)) return fieldToUncertainty(surpriseField(tokenSurprise));
  if (typeof tokenSurprise === "object") return fieldToUncertainty(tokenSurprise);
  return 0;
}

module.exports = {
  logprobToBits,
  fromOpenAILogprobs,
  fromOllamaLogprobs,
  surpriseField,
  fieldToUncertainty,
  toUncertainty,
};
