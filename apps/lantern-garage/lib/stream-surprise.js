// Σ₀ Verify-stage valve (#1678) — capture per-token logprobs from logprob-exposing
// providers during streaming and feed the surprise field into the groundedness canary
// as `tokenSurprise` → `modelUncertainty` (lib/groundedness-canary.js).
//
// The canary's receiving end already exists and is tested; the missing piece this module
// supplies is the INPUT: request native logprobs from each provider that exposes them,
// and parse the per-token logprobs out of that provider's streaming chunk format into the
// shared, model-agnostic surprise field (lib/token-surprise.js).
//
// Design contract:
//   • Default OFF (SURPRISE_CANARY=1 to enable). The flag is read DYNAMICALLY per call so
//     the live valve can be toggled without a restart and so it is trivially testable.
//   • Graceful no-op everywhere it cannot help: flag off, provider without logprobs
//     (Anthropic), or a chunk that simply carries no logprob payload. In every such case
//     value() returns null → the canary sees no tokenSurprise → modelUncertainty stays 0
//     → behaviour is byte-identical to before. Requests are NOT mutated when the flag is
//     off (the augmenters return their input unchanged), so default chat is untouched.
//   • This is Layer-1.5 — opening the valve. Whether feeding the signal in actually raises
//     hallucination recall (Layer 2) / verified-pass-rate (Layer 3) is measured downstream
//     (#1679/#1680). The map itself was validated in #1673/#1676.
"use strict";

const { fromOpenAILogprobs, surpriseField } = require("./token-surprise");

const LN2 = Math.log(2);

/** Dynamic flag read — never cache, so the valve can be toggled at runtime and tested. */
function enabled() {
  return process.env.SURPRISE_CANARY === "1";
}

// A per-token bits accumulator threaded alongside `fullReply` in the stream loop.
// All push* methods are no-ops when the flag is off, so call sites need no extra guard.
function createSurpriseAccumulator() {
  /** @type {{token:string, bits:number}[]} */
  const bits = [];

  return {
    // OpenAI / xAI(Grok) / Ollama-OpenAI-compat streaming chunk:
    //   evt.choices[0].logprobs.content = [{ token, logprob }]   (natural-log logprob)
    pushOpenAIEvent(evt) {
      if (!enabled()) return;
      const content = evt && evt.choices && evt.choices[0] && evt.choices[0].logprobs
        && evt.choices[0].logprobs.content;
      if (Array.isArray(content)) {
        for (const c of fromOpenAILogprobs(content)) bits.push(c);
      }
    },

    // Gemini / Vertex streaming chunk (responseLogprobs):
    //   evt.candidates[0].logprobsResult.chosenCandidates = [{ token, logProbability }]
    //   logProbability is a natural-log probability.
    pushGeminiEvent(evt) {
      if (!enabled()) return;
      const chosen = evt && evt.candidates && evt.candidates[0]
        && evt.candidates[0].logprobsResult && evt.candidates[0].logprobsResult.chosenCandidates;
      if (Array.isArray(chosen)) {
        for (const c of chosen) {
          const lp = c == null ? null : Number(c.logProbability);
          if (lp != null && Number.isFinite(lp)) bits.push({ token: (c && c.token) || "", bits: -lp / LN2 });
        }
      }
    },

    reset() { bits.length = 0; },

    count() { return bits.length; },

    // The per-token bits array, or null when nothing was captured. null is the signal the
    // canary interprets as "no model-internal uncertainty available" (modelUncertainty 0).
    value() { return bits.length ? bits.slice() : null; },

    // Compact JSON-loggable summary (mean/p90/tailMass …), or null. For receipts/telemetry.
    field() { return bits.length ? surpriseField(bits) : null; },
  };
}

// Request augmenters — add each provider's native logprob request, flag-gated. When the
// flag is off they return their input UNCHANGED so default requests are byte-identical.

/** OpenAI-compatible chat-completions body → ask for per-token logprobs. */
function withOpenAILogprobs(payloadObj) {
  if (!enabled() || !payloadObj || typeof payloadObj !== "object") return payloadObj;
  return { ...payloadObj, logprobs: true };
}

/** Gemini generationConfig → ask for per-token logprobs (top-1). */
function withGeminiLogprobs(generationConfig) {
  if (!enabled() || !generationConfig || typeof generationConfig !== "object") return generationConfig;
  return { ...generationConfig, responseLogprobs: true, logprobs: 1 };
}

module.exports = {
  enabled,
  createSurpriseAccumulator,
  withOpenAILogprobs,
  withGeminiLogprobs,
};
