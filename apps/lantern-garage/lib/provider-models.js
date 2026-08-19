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
  cohere: "command-a-plus-05-2026",       // env: COHERE_MODEL — via Cohere's OpenAI-compat endpoint (command-r-plus retired 2025-09)
};

const ENV_VAR = {
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  gemini: "GEMINI_MODEL",
  xai: "XAI_MODEL",
  cohere: "COHERE_MODEL",
};

// Ordered quota/429 fallbacks tried after modelFor("gemini"). This lives here rather
// than inline in a caller because that is precisely how the previous chain rotted: it
// listed `gemini-3.5-flash` and `gemini-3.1-flash-lite`, which do not exist on any
// wire. Every fallback hop was a guaranteed 404 — and on Vertex, where a 404 is not a
// retryable quota error, the cloud box had no working fallback at all.
// Probed live against Vertex us-central1 (2026-07-15): 2.5-flash, 2.5-flash-lite and
// 2.5-pro all answer 200; both gemini-3.x ids 404. Re-probe before editing this list.
const GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-pro"];

/** Resolve the effective model for a provider: env override if set, else the default. */
function modelFor(provider) {
  const key = ENV_VAR[provider];
  return (key && process.env[key] && process.env[key].trim()) || DEFAULTS[provider];
}

// Per-provider model choices a chat user may pin from the UI (#1127 work item 1).
// This is an ALLOWLIST: /api/dream/chat/stream only honours a requested model that
// appears here for the pinned provider, so the client can never route a turn to an
// arbitrary/retired model id. Keep ids current with PROVIDERS.md; the default for
// each provider is whatever modelFor() resolves (env override included) and is
// always accepted even if this list drifts.
const CHAT_MODEL_OPTIONS = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 (deep)" },
  ],
  openai: [
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini (fast)" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
  gemini: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (fast)" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (cheapest)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (deep)" },
  ],
  xai: [
    { id: "grok-3-mini", label: "Grok 3 mini (fast)" },
    { id: "grok-3", label: "Grok 3" },
  ],
};

// ── Difficulty-based model escalation (within a provider) ────────────────────
// Auto mode resolved every turn to the provider's DEFAULT model — the cheap/fast tier
// (gemini-2.5-flash, gpt-4.1-mini, claude-haiku, grok-3-mini). That is right for the bulk of
// chat, but it also silently capped quality on the turns that most need reasoning: a hard
// design/proof/tradeoff question got Flash. router-gate.js escalates the PROVIDER chain
// (and only behind ROUTER_GATE=1); nothing ever escalated the model tier WITHIN a provider.
//
// The deep model for each provider, drawn from the same verified allowlist above so
// escalation can never route to an id the health check doesn't cover.
const DEEP_MODELS = {
  gemini: "gemini-2.5-pro",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1",
  xai: "grok-3",
};

// Deliberately conservative: escalation costs real money (a frontier turn is ~67x a cheap
// one — see the escalation-meter rationale), so this fires on turns that plainly ask for
// reasoning, not on anything merely long. Lookups, greetings and simple factual questions
// stay on the cheap tier, which is where the measured workload says they belong.
const _DEEP_INTENT = /\b(analy[sz]e|analysis|reason|prove|proof|derive|design|architect(?:ure)?|trade-?offs?|compare|comparison|evaluate|assess|critique|refactor|debug|diagnose|root cause|why (?:does|do|is|are|did)|explain why|implications?|strategy|plan out|step by step|think (?:hard|deeply|carefully)|pros and cons)\b/i;
const _MULTI_PART = /\b(and then|after that|also (?:explain|compare|analy)|first.*then|multiple|several (?:options|approaches))\b/i;

/**
 * Should this turn use the provider's deep model instead of its default?
 * Pure + side-effect free so it is testable and cheap to call per dispatch attempt.
 */
function isDeepTurn(message, opts = {}) {
  const text = String(message || "");
  if (!text.trim()) return false;
  if (opts.codingIntent) return true;          // code changes are the classic deep turn
  if (_DEEP_INTENT.test(text)) return true;
  // A long, multi-part request is doing more than one thing and benefits from the deep tier.
  if (text.length > 400 && _MULTI_PART.test(text)) return true;
  return false;
}

/**
 * The model to actually run for *provider* on this turn. Escalates to the deep tier for a
 * hard turn; otherwise the normal default (env override included). A deep model is only
 * returned when one is defined for the provider AND escalation is enabled.
 * KEYSTONE_MODEL_ESCALATION=0 pins every turn to the default tier.
 */
function escalatedModelFor(provider, message, opts = {}) {
  const off = ["0", "false", "off", "no"].includes(String(process.env.KEYSTONE_MODEL_ESCALATION ?? "").trim().toLowerCase());
  if (off) return modelFor(provider);
  // An env-pinned model is an explicit operator choice — never override it.
  if (ENV_VAR[provider] && process.env[ENV_VAR[provider]]) return modelFor(provider);
  const deep = DEEP_MODELS[provider];
  if (!deep || !isDeepTurn(message, opts)) return modelFor(provider);
  return deep;
}

/** True when *model* is a UI-pinnable choice for *provider* (or its effective default). */
function isAllowedModel(provider, model) {
  if (!provider || !model) return false;
  if (model === modelFor(provider)) return true;
  return (CHAT_MODEL_OPTIONS[provider] || []).some((m) => m.id === model);
}

module.exports = { DEFAULTS, ENV_VAR, modelFor, CHAT_MODEL_OPTIONS, isAllowedModel, GEMINI_FALLBACK_MODELS, DEEP_MODELS, isDeepTurn, escalatedModelFor };
