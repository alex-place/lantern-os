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

// Per-model calibration of the field→[0,1] scalar (#1681).
//
// #1673/#1676 established that a mean/p90-bits blend through a strictly-monotonic logistic
// RANKS hallucination correctly (AUROC 0.77/0.81). But ranking is scale-free, so the
// MAGNITUDE the canary thresholds on is meaningless without per-model calibration: a small
// model whose per-token bits run < 1 maps every reply to ~0 under a fixed CENTER=5 (the
// #1678 live test confirmed this — surprise field 0.41 vs 0.97 bits/token, yet uncertainty
// 0/0). #1681 calibrates CENTER/GAIN per model so a confident-correct reply lands ~0.27 and
// a guessed one ~0.73, around a usable 0.5 boundary — WITHOUT changing AUROC (a monotonic
// transform leaves ranking intact). Values derived from the #1673 labeled rows; method:
// CENTER = midpoint of the class-mean blends, GAIN = 2 / (halluc_mean − correct_mean).
const DEFAULT_CALIBRATION = { center: 5, gain: 1 }; // uncalibrated: ranking-valid, magnitude conservative (~0 on low-bit models)
const CALIBRATION = {
  "qwen2.5-coder:1.5b": { center: 1.092, gain: 2.827 }, // #1673 data → correct~0.27 / halluc~0.73
  "mistral": { center: 0.336, gain: 5.825 },            // #1673 data → correct~0.27 / halluc~0.73
};

// Resolve a model id to its calibration. Exact match first, then same model-family base
// (before the ":tag") so "mistral:latest" → "mistral" and "qwen2.5-coder:latest" →
// "qwen2.5-coder:1.5b". Unknown model → default (current uncalibrated, safe-conservative).
function calibrationFor(modelId) {
  if (!modelId || typeof modelId !== "string") return DEFAULT_CALIBRATION;
  const id = modelId.toLowerCase();
  if (CALIBRATION[id]) return CALIBRATION[id];
  const base = id.split(":")[0];
  for (const key of Object.keys(CALIBRATION)) {
    if (key.split(":")[0] === base) return CALIBRATION[key];
  }
  return DEFAULT_CALIBRATION;
}

// Map a field summary to an internal-uncertainty scalar in [0,1]. `calib` ({center,gain})
// shapes the logistic; default leaves the ranking-valid, conservatively-small mapping. The
// transform is strictly monotonic, so AUROC is unchanged by the choice of calibration
// (#1673/#1676); calibration only makes the MAGNITUDE meaningful per model (#1681).
function fieldToUncertainty(field, calib = DEFAULT_CALIBRATION) {
  if (!field) return 0;
  const mean = Number.isFinite(field.meanBits) ? field.meanBits : 0;
  const p90 = Number.isFinite(field.p90Bits) ? field.p90Bits : mean;
  const blendBits = 0.5 * mean + 0.5 * p90;
  const center = calib && Number.isFinite(calib.center) ? calib.center : DEFAULT_CALIBRATION.center;
  const gain = calib && Number.isFinite(calib.gain) ? calib.gain : DEFAULT_CALIBRATION.gain;
  return round(clamp01(1 / (1 + Math.exp(-gain * (blendBits - center)))));
}

// Normalize whatever a caller passes as `tokenSurprise` into an uncertainty scalar:
//   - a number  → treated as an already-computed uncertainty in [0,1] (calibration N/A)
//   - a field   → fieldToUncertainty(field, calib)
//   - an array  → surpriseField → fieldToUncertainty(field, calib) (accepts [{bits}] or [number])
function toUncertainty(tokenSurprise, calib = DEFAULT_CALIBRATION) {
  if (tokenSurprise == null) return 0;
  if (typeof tokenSurprise === "number") return clamp01(tokenSurprise);
  if (Array.isArray(tokenSurprise)) return fieldToUncertainty(surpriseField(tokenSurprise), calib);
  if (typeof tokenSurprise === "object") return fieldToUncertainty(tokenSurprise, calib);
  return 0;
}

module.exports = {
  logprobToBits,
  fromOpenAILogprobs,
  fromOllamaLogprobs,
  surpriseField,
  fieldToUncertainty,
  toUncertainty,
  calibrationFor,
  CALIBRATION,
  DEFAULT_CALIBRATION,
};
