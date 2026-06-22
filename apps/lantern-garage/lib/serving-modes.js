"use strict";
/**
 * Serving modes for the dream-chat Node path — FAST (default) vs DEEP (OURO_NATIVE=1).
 *
 * Node mirror of src/serving_modes.py (PR #723 / issue #729). PR #723 landed the
 * anti-repetition decode params in the Python unified_agent_connector, but the live
 * dream-chat product (apps/lantern-garage) builds its own provider requests in
 * dream-chat.js / stream-chat.js and never picked them up. This module closes that
 * gap so the actual product gets the same token-loop mitigation.
 *
 * Coverage matches the merged reference: Ollama + OpenAI-compatible providers
 * (OpenAI / Groq / Deepseek / xAI). The Python connector intentionally leaves
 * Anthropic (no frequency_penalty) and Gemini unmodified, so this module does too.
 *
 * FAST mode (product default): aggressive anti-repetition decode params
 *   (top_p=0.95, frequency_penalty=0.5 for OpenAI-style; repeat_penalty=1.1,
 *   repeat_last_n=64 for Ollama). Target: sub-2s interactive replies, no ✅✅✅ loops.
 * DEEP mode (opt-in via OURO_NATIVE=1): gentler params to allow grounded reasoning.
 *
 * Keep the param values in sync with src/serving_modes.py.
 */

const FAST_MODE = Object.freeze({
  name: "fast",
  maxLatencyMs: 2000,
  description: "Cached inference with anti-repetition decode. Product default for interactive use.",
});

const DEEP_MODE = Object.freeze({
  name: "deep",
  maxLatencyMs: 120000,
  description: "Native Σ₀ Q-exit loop. Opt-in for architecture decisions and grounded reasoning.",
});

/** Return the active serving mode. DEEP only when OURO_NATIVE is truthy. */
function getServingMode() {
  return /^(1|true|yes)$/i.test(process.env.OURO_NATIVE || "") ? DEEP_MODE : FAST_MODE;
}

/**
 * Provider-neutral anti-repetition decode params for a mode.
 * Mirrors get_decode_params() in src/serving_modes.py.
 */
function getDecodeParams(mode) {
  const m = mode || getServingMode();
  if (m.name === "deep") {
    return { top_p: 0.98, frequency_penalty: 0.2, repetition_penalty: 1.05, repeat_last_n: 128 };
  }
  // fast (default)
  return { top_p: 0.95, frequency_penalty: 0.5, repetition_penalty: 1.1, repeat_last_n: 64 };
}

/**
 * Apply Ollama-shaped decode params onto an `options` object (mutates + returns it).
 * Ollama uses repeat_penalty / repeat_last_n rather than frequency_penalty.
 */
// Stop sequences that cut a local instruction/chat-tuned model's output the moment
// it tries to start a *new* turn or echo its prompt template — the #1 reliability
// problem with served local models (e.g. ouro:latest answers correctly, then appends
// "### Response:" and rambles into a fresh instruction block). These are turn/template
// markers, not content, so they never appear mid-answer in a clean reply.
const OLLAMA_STOP = Object.freeze([
  "### Response:", "### Instruction:", "### Input:", "### Task:",
  "<|im_end|>", "<|endoftext|>", "<|eot_id|>",
  "\n\nUser:", "\n\nHuman:", "\n\nAssistant:", "\n\nQuestion:",
]);

function applyOllamaDecodeParams(options, mode) {
  const opts = options || {};
  const m = mode || getServingMode();
  const dp = getDecodeParams(m);
  opts.top_p = dp.top_p;
  opts.repeat_penalty = dp.repetition_penalty;
  opts.repeat_last_n = dp.repeat_last_n;
  // Reliability over a small local model (Σ₀ thesis: grounded + clean beats raw size):
  // a steadier temperature so it doesn't wander, a length ceiling so a runaway can't
  // ramble forever, and stop sequences so it ends cleanly after the answer instead of
  // echoing its template. Caller-supplied values win.
  if (opts.temperature == null) opts.temperature = m.name === "deep" ? 0.6 : 0.4;
  if (opts.num_predict == null) opts.num_predict = m.name === "deep" ? 2048 : 768;
  opts.stop = Array.isArray(opts.stop) ? Array.from(new Set([...opts.stop, ...OLLAMA_STOP])) : OLLAMA_STOP.slice();
  return opts;
}

/**
 * Apply OpenAI-compatible decode params (OpenAI / Groq / Deepseek / xAI) onto a
 * request body (mutates + returns it): top_p + frequency_penalty.
 */
function applyOpenAIDecodeParams(body, mode) {
  const b = body || {};
  const dp = getDecodeParams(mode);
  b.top_p = dp.top_p;
  b.frequency_penalty = dp.frequency_penalty;
  return b;
}

module.exports = {
  FAST_MODE,
  DEEP_MODE,
  getServingMode,
  getDecodeParams,
  applyOllamaDecodeParams,
  applyOpenAIDecodeParams,
};
