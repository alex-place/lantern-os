/**
 * Single source of truth for default LLM model IDs.
 *
 * WHY THIS EXISTS: model IDs were hardcoded as string literals scattered across
 * stream-chat.js, self-edit-engine.js, swarm-orchestrator.js, routes/providers.js
 * and the docs. They drifted apart — e.g. the auto-work path called a retired
 * Grok model ID (→ "Model not found"), while the same stream-chat function sent
 * a request to one model but logged the receipt as a different one. None of this
 * was caught by CI because a wrong model *string* is still valid JS syntax.
 *
 * RULE: every runtime path that needs a default model MUST read it from here
 * (overridable per-provider by the documented env var). The health-check route
 * tests THESE SAME models, so a green "verified" badge means the model the code
 * actually runs is reachable. tests/test_provider_model_consistency.py enforces
 * that no runtime lib reintroduces a divergent hardcoded model literal.
 */

// Documented defaults. Override at runtime via the listed env var.
const DEFAULTS = {
  anthropic: "claude-haiku-4-5-20251001", // env: ANTHROPIC_MODEL
  openai: "gpt-4.1-mini",                 // env: OPENAI_MODEL
  gemini: "gemini-2.5-flash",             // env: GEMINI_MODEL  (2.0-flash had free-tier limit:0; 2.5 works)
  xai: "grok-3-mini",                     // env: XAI_MODEL — matches PROVIDERS.md + health check
};

const ENV_VAR = {
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  gemini: "GEMINI_MODEL",
  xai: "XAI_MODEL",
};

/** Resolve the effective model for a provider: env override if set, else the default. */
function modelFor(provider) {
  const key = ENV_VAR[provider];
  return (key && process.env[key] && process.env[key].trim()) || DEFAULTS[provider];
}

// User-selectable models per UI provider id — the single source of truth for both
// the dream-chat model dropdown (served via GET /api/providers/models) and the
// server-side allow-list that validates a per-request `model` override (#1127,
// ADR-0008). Keys are the UI provider values used in the chat request body
// (`claude`, `openai`, `gemini`, `grok`, `ollama`), NOT the env-var provider keys
// above — keep them aligned with dream-chat's provider <select>. The first entry
// in each list is the recommended default surfaced to the user.
const SELECTABLE_MODELS = {
  claude: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"],
  openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  grok: ["grok-3-mini", "grok-3"],
  ollama: ["ouro:latest", "qwen2.5-coder", "mistral"],
};

/** List the user-selectable models for a UI provider id ([] if none / unknown). */
function selectableModels(provider) {
  return SELECTABLE_MODELS[provider] || [];
}

/** True only if `model` is an explicitly allow-listed model for `provider`. */
function isSelectableModel(provider, model) {
  return !!model && selectableModels(provider).includes(model);
}

module.exports = { DEFAULTS, ENV_VAR, modelFor, SELECTABLE_MODELS, selectableModels, isSelectableModel };
