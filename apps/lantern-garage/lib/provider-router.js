/**
 * Unified Provider Router
 * Single source of truth for all LLM provider selection and fallback logic.
 * Replaces scattered fallback chains in stream-chat.js and dream-chat.js.
 */

const http = require("http");
const https = require("https");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const CACHE_TTL_MS = 60_000;
const PROVIDER_CALL_LOG_PATH = path.resolve(__dirname, "..", "..", "data", "provider-calls.jsonl");

// Provider configuration with fallback chains by task type
const PROVIDER_CHAINS = {
  coding: [
    { provider: "ollama", models: ["qwen2.5-coder", "deepseek"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4-turbo", "gpt-4o-mini"] },
    { provider: "deepseek", models: ["deepseek-chat"] },
  ],

  reasoning: [
    { provider: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4-turbo"] },
    { provider: "gemini", models: ["gemini-2.5-pro"] },
    { provider: "deepseek", models: ["deepseek-chat"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
  ],

  creative: [
    { provider: "ollama", models: ["lantern-csf-dream"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "openai", models: ["gpt-4o"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "cohere", models: ["command-r-plus"] },
  ],

  default: [
    { provider: "ollama", models: ["lantern-csf-dream", "qwen2.5-coder"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "anthropic", models: ["claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4o-mini"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
  ],
};

// Provider health state (fleet-wide, shared across all requests)
const _providerState = {};
let _lastHealthCheck = 0;

/**
 * Does this provider have an API key available in the environment?
 * (ollama/local is always "available".)
 */
function providerHasKey(provider) {
  const env = process.env;
  switch (String(provider || "").toLowerCase()) {
    case "anthropic": return !!env.ANTHROPIC_API_KEY;
    case "openai": return !!env.OPENAI_API_KEY;
    case "gemini": return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
    case "xai": case "grok": return !!env.XAI_API_KEY;
    case "mistral": return !!env.MISTRAL_API_KEY;
    case "cohere": return !!env.COHERE_API_KEY;
    case "deepseek": return !!env.DEEPSEEK_API_KEY;
    case "perplexity": return !!env.PERPLEXITY_API_KEY;
    case "openrouter": return !!env.OPENROUTER_API_KEY;
    case "ollama": case "local": return true;
    default: return false;
  }
}

/**
 * Select which provider + model to use for a request
 * @param {string} message - User message
 * @param {string} taskType - "coding"|"reasoning"|"creative"|"default"
 * @param {string} requestedProvider - Override provider if specified
 * @returns {Promise<{provider, model, chain}>}
 */
async function selectProvider(message, taskType = "default", requestedProvider = null) {
  // If user explicitly requested a provider, try that first
  if (requestedProvider) {
    const matched = findProviderChain(requestedProvider);
    if (matched) {
      return {
        provider: matched.provider,
        model: matched.models[0],
        chain: matched.models.slice(1),
        reason: `explicit_request:${requestedProvider}`,
      };
    }
  }

  // Use task type to select chain
  const chain = PROVIDER_CHAINS[taskType] || PROVIDER_CHAINS.default;

  // LEADERBOARD_ROUTING: rank cloud(with key) + local together by compositeScore
  // and pick the best on merit (Auto mode only). Default off → legacy chain order.
  if (process.env.LEADERBOARD_ROUTING === "1" && !requestedProvider) {
    try {
      const { rankCandidates } = require("./model-leaderboard");
      const { CLOUD_PROVIDERS } = require("./leaderboard-routing");
      const candidates = [];
      for (const step of chain) {
        if (!isProviderHealthy(step.provider)) continue;
        if (step.provider === "ollama") {
          // local candidate scored by its MODEL name (how local outcomes record)
          candidates.push({ provider: "ollama", model: step.models[0], key: step.models[0] });
        } else if (providerHasKey(step.provider)) {
          // cloud candidate scored by PROVIDER name
          candidates.push({ provider: step.provider, model: step.models[0], key: step.provider });
        }
      }
      if (!candidates.some((c) => c.provider === "ollama")) {
        candidates.push({ provider: "ollama", model: "lantern-csf-dream", key: "lantern-csf-dream" });
      }
      const rankedCands = await rankCandidates(candidates, taskType, { cloudSet: CLOUD_PROVIDERS });
      const best = rankedCands[0];
      if (best) {
        return {
          provider: best.provider,
          model: best.model,
          chain: [],
          reason: `leaderboard:${best.score.toFixed(2)}${best.scored ? "" : ":coldstart"}`,
        };
      }
    } catch (e) {
      console.error("[provider-router] leaderboard routing error (non-fatal):", e.message);
      // fall through to legacy chain selection
    }
  }

  // Find first healthy provider in chain
  for (const step of chain) {
    if (isProviderHealthy(step.provider)) {
      return {
        provider: step.provider,
        model: step.models[0],
        chain: step.models.slice(1),
        reason: `task_type:${taskType}`,
      };
    }
  }

  // If all providers in chain are unhealthy, log warning and use first anyway
  console.warn(`[provider-router] All providers unhealthy for ${taskType}, using fallback`);
  const fallback = chain[0];
  return {
    provider: fallback.provider,
    model: fallback.models[0],
    chain: fallback.models.slice(1),
    reason: `fallback:all_unhealthy`,
  };
}

// Σ₀ Fix: Track fallback cost per message to detect and escalate runaway chains
const _fallbackContext = new Map(); // messageId → {startTime, attemptCount, totalCost, providers}

/**
 * Call a specific LLM provider with intelligent fallback
 * @param {string} provider
 * @param {string} model
 * @param {object} payload - Provider-specific payload (messages, system prompt, etc.)
 * @param {string} taskType - For context/logging
 * @param {object} context - {agent, recentDreams, csfContext, etc.}
 * @returns {Promise<{content, provider, model, attempt, fallbackReason, latencyMs, tokensUsed, cost}>}
 */
async function callProvider(provider, model, payload, taskType = "default", context = {}, _globalAttempt = 0) {
  const startTime = Date.now();
  let attempt = 1;
  let lastError = null;

  // Σ₀ Fix: Track global attempt count across all providers
  const MAX_FALLBACK_ATTEMPTS = 5; // Escalate after 5 failed attempts (stop the bleed)
  const messageId = JSON.stringify([payload, taskType]).substring(0, 20); // Quick message fingerprint

  if (!_fallbackContext.has(messageId)) {
    _fallbackContext.set(messageId, { startTime, attemptCount: 0, providers: [] });
  }
  const fallbackState = _fallbackContext.get(messageId);
  fallbackState.attemptCount++;

  // Escalation gate: if we've tried too many providers, stop and return error
  if (fallbackState.attemptCount > MAX_FALLBACK_ATTEMPTS) {
    console.error(`[provider-router] ESCALATION: Exceeded max fallback attempts (${MAX_FALLBACK_ATTEMPTS}) for ${taskType}`);
    _fallbackContext.delete(messageId);
    throw new Error(
      `[provider-router] ESCALATION: Message failed across ${fallbackState.providers.join(", ")}. Stopped after ${MAX_FALLBACK_ATTEMPTS} attempts. Last error: ${lastError?.message || "unknown"}`
    );
  }

  const chain = PROVIDER_CHAINS[taskType] || PROVIDER_CHAINS.default;
  const providerStep = chain.find((s) => s.provider === provider);
  const modelsToTry = providerStep ? [...providerStep.models] : [model];

  // Try models in sequence within this provider
  for (const tryModel of modelsToTry) {
    try {
      const result = await _callProviderImpl(provider, tryModel, payload, context);
      const latencyMs = Date.now() - startTime;

      // Log successful call
      await _logProviderCall({
        provider,
        model: tryModel,
        attempt: fallbackState.attemptCount,
        status: "success",
        latencyMs,
        taskType,
        tokensUsed: result.tokensUsed || 0,
        cost: result.cost || 0,
        attemptChain: fallbackState.providers.join(" -> "),
      });

      // Record success in provider state
      recordProviderSuccess(provider);
      _fallbackContext.delete(messageId); // Clean up

      return {
        content: result.content,
        provider,
        model: tryModel,
        attempt: fallbackState.attemptCount,
        fallbackReason: fallbackState.providers.length > 0 ? `Fallback after ${fallbackState.providers.join(", ")}` : null,
        latencyMs,
        tokensUsed: result.tokensUsed || 0,
        cost: result.cost || 0,
        attemptChain: fallbackState.providers,
      };
    } catch (err) {
      lastError = err;
      const latencyMs = Date.now() - startTime;

      // Log failed attempt
      await _logProviderCall({
        provider,
        model: tryModel,
        attempt: fallbackState.attemptCount,
        status: "failure",
        errorCode: err.code || err.message.split(" ")[0],
        latencyMs,
        taskType,
        escalationRisk: fallbackState.attemptCount >= MAX_FALLBACK_ATTEMPTS ? "HIGH" : "normal",
      });

      // Record failure in provider state
      recordProviderFailure(provider, err.code || "unknown");
      fallbackState.providers.push(provider);

      attempt++;
    }
  }

  // All models in this provider failed, try next provider in chain
  const nextProviderStep = chain.find(
    (s, idx) => idx > chain.findIndex((s) => s.provider === provider)
  );

  if (nextProviderStep && fallbackState.attemptCount < MAX_FALLBACK_ATTEMPTS) {
    console.log(`[provider-router] Fallback: ${provider} failed, trying ${nextProviderStep.provider} (attempt ${fallbackState.attemptCount}/${MAX_FALLBACK_ATTEMPTS})`);
    return await callProvider(nextProviderStep.provider, nextProviderStep.models[0], payload, taskType, context, fallbackState.attemptCount);
  }

  // Escalation: all providers exhausted OR max attempts exceeded
  _fallbackContext.delete(messageId);
  throw new Error(
    `[provider-router] All providers failed for ${taskType} (${fallbackState.attemptCount} attempts). Last error: ${lastError?.message || "unknown"}`
  );
}

/**
 * Actual provider API call (delegates to provider-specific code)
 * NOTE: Streaming implementations stay in stream-chat.js for now
 * This is used for sync chat and testing
 * @private
 */
async function _callProviderImpl(provider, model, payload, context) {
  // For now, sync calls are not implemented here
  // Stream-chat.js has the streaming implementations
  // This stub ensures the routing logic works
  throw new Error(`Sync call not implemented for ${provider}. Use stream-chat.js for streaming.`);
}

/**
 * Check if a provider is healthy (not rate-limited, not auth failed, etc.)
 */
function isProviderHealthy(provider) {
  const state = _providerState[provider];
  if (!state) return true; // Unknown = assume healthy

  // Provider is blocked due to rate limit, skip it
  if (state.blockedUntil && Date.now() < state.blockedUntil) {
    return false;
  }

  // Provider has no API key
  if (state.noKey) {
    return false;
  }

  return true;
}

/**
 * Record a successful provider call (for health tracking)
 */
function recordProviderSuccess(provider) {
  if (!_providerState[provider]) {
    _providerState[provider] = {};
  }
  _providerState[provider].lastSuccess = Date.now();
  _providerState[provider].consecutiveFailures = 0;
}

/**
 * Record a provider failure (rate limit, auth error, etc.)
 */
function recordProviderFailure(provider, errorCode) {
  if (!_providerState[provider]) {
    _providerState[provider] = {};
  }

  _providerState[provider].lastFailure = Date.now();
  _providerState[provider].lastError = errorCode;
  _providerState[provider].consecutiveFailures = (_providerState[provider].consecutiveFailures || 0) + 1;

  // Handle rate limits
  if (errorCode === "429" || errorCode === "quota_exceeded") {
    _providerState[provider].blockedUntil = Date.now() + 60_000; // Block for 60s
  }

  // Handle auth failures
  if (errorCode === "401" || errorCode === "403" || errorCode === "invalid_api_key") {
    _providerState[provider].noKey = true;
  }

  // After 5 consecutive failures, temporarily block
  if (_providerState[provider].consecutiveFailures >= 5) {
    _providerState[provider].blockedUntil = Date.now() + 30_000;
  }
}

/**
 * Get current provider health status (for debugging/observability)
 */
function getProviderStatus() {
  return { ..._providerState };
}

/**
 * Log a provider call for metrics and debugging
 * @private
 */
async function _logProviderCall(entry) {
  try {
    await appendJsonlQueued(PROVIDER_CALL_LOG_PATH, {
      timestamp: new Date().toISOString(),
      ...entry,
    });
  } catch (err) {
    console.error("[provider-router] Failed to log provider call:", err.message);
  }
}

/**
 * Find a provider chain by name/alias
 * @private
 */
function findProviderChain(providerName) {
  const name = providerName.toLowerCase();
  for (const chain of Object.values(PROVIDER_CHAINS)) {
    const found = chain.find(
      (step) =>
        step.provider === name ||
        step.provider.startsWith(name) ||
        step.models.some((m) => m.includes(name))
    );
    if (found) return found;
  }
  return null;
}

module.exports = {
  selectProvider,
  callProvider,
  isProviderHealthy,
  recordProviderSuccess,
  recordProviderFailure,
  getProviderStatus,
};
