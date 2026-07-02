/**
 * Unified Provider Router
 * Single source of truth for all LLM provider selection and fallback logic.
 * Replaces scattered fallback chains in stream-chat.js and dream-chat.js.
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { appendJsonlQueued } = require("./file-queue");

const CACHE_TTL_MS = 60_000;
const PROVIDER_CALL_LOG_PATH = path.resolve(__dirname, "..", "..", "data", "provider-calls.jsonl");
// lib/ -> lantern-garage -> apps -> repo root (3 levels up).
const PCSF_PROVIDER_PATH = path.resolve(__dirname, "..", "..", "..", "data", "pcsf", "provider.pcsf.json");

// ── PCSF live ranking ────────────────────────────────────────────────────────
// provider.pcsf.json is the persisted, inspectable provider ranking — refreshed
// from real leaderboard outcomes by lib/pcsf-refresh.js. It is the SOURCE OF
// TRUTH for provider order; the static PROVIDER_CHAINS below is the candidate set
// + cold fallback when PCSF has no ranking yet. Kill-switch: PCSF_ROUTING=0.
let _pcsfRoutingCache = { at: 0, byTask: null };
function loadPcsfRouting() {
  if (process.env.PCSF_ROUTING === "0") return null;
  const now = Date.now();
  if (now - _pcsfRoutingCache.at < CACHE_TTL_MS) return _pcsfRoutingCache.byTask;
  let byTask = null;
  try {
    const raw = JSON.parse(fs.readFileSync(PCSF_PROVIDER_PATH, "utf8"));
    if (raw && raw.routing && raw.routing.by_task_type) byTask = raw.routing.by_task_type;
  } catch { byTask = null; }
  _pcsfRoutingCache = { at: now, byTask };
  return byTask;
}

/** Reorder a static chain so providers follow the PCSF ranking for this task.
 *  Providers absent from the PCSF list keep their static order, after ranked ones. */
function orderChainByPcsf(chain, taskType, byTaskOverride) {
  const byTask = byTaskOverride !== undefined ? byTaskOverride : loadPcsfRouting();
  const order = byTask && (byTask[taskType] || byTask.default);
  if (!Array.isArray(order) || !order.length) return { chain, ranked: false };
  const rank = new Map(order.map((p, i) => [String(p).toLowerCase(), i]));
  const reordered = chain
    .map((step, i) => ({ step, i, r: rank.has(step.provider) ? rank.get(step.provider) : Infinity }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.step);
  return { chain: reordered, ranked: true };
}

// Provider configuration with fallback chains by task type
const PROVIDER_CHAINS = {
  // Kernel chain (#894): Keystone/Ouro model first; Claude is explicit last-resort.
  // Controlled by KEYSTONE_ROLLOVER_MODE: "shadow"(default/unset)=Claude only (Stage 0,
  // safe); "default"=Keystone/Ouro first, Claude fallback (Stage 1+).
  // Anthropic tier uses claude-sonnet-5 — Anthropic's mid-tier model built for
  // long-running, multi-step agentic sessions (self-correction, dynamic
  // replanning) which is exactly the kernel/autowork escalation workload.
  kernel: [
    { provider: "ollama", models: ["keystone-ft", "ouro:latest"] },
    { provider: "anthropic", models: ["claude-sonnet-5"] },
  ],

  // Local model order here is the coarse fallback; lib/local-model-registry.js is
  // the source of truth for which LOCAL model leads (VRAM-gated, Ouro-default /
  // capability-first aware — see docs/SIGMA0-MODEL-ADAPTER.md). Ouro leads by
  // decision (2026-06-26); Qwen is the opt-in capability lever behind it.
  coding: [
    { provider: "ollama", models: ["ouro:latest", "qwen2.5-coder"] },
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

  // #1167: ollama used to lead here too. isProviderHealthy() defaults an unrecorded
  // provider to "healthy" and ollama essentially never gets recorded unhealthy (it
  // always returns *something*, even a hallucinated/off-tone answer) — so once the
  // local coder was reliably served, cloud was never reached for ANY general/creative
  // message. Cloud now leads; ollama stays as a genuine offline backstop.
  creative: [
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "openai", models: ["gpt-4o"] },
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "cohere", models: ["command-a-plus-05-2026"] },
    { provider: "ollama", models: ["lantern-csf-dream"] },
  ],

  default: [
    { provider: "gemini", models: ["gemini-2.5-flash"] },
    { provider: "anthropic", models: ["claude-sonnet-4-6"] },
    { provider: "openai", models: ["gpt-4o-mini"] },
    { provider: "mistral", models: ["mistral-large-latest"] },
    { provider: "ollama", models: ["lantern-csf-dream", "qwen2.5-coder"] },
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

  // Use task type to select chain, then reorder by the live PCSF ranking
  // (provider.pcsf.json, refreshed from leaderboard outcomes). PCSF is the source
  // of truth for order; the static chain is the candidate set + cold fallback.
  const baseChain = PROVIDER_CHAINS[taskType] || PROVIDER_CHAINS.default;
  const { chain, ranked: pcsfRanked } = orderChainByPcsf(baseChain, taskType);

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
        reason: pcsfRanked ? `pcsf_rank:${taskType}` : `task_type:${taskType}`,
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
    // #897: record Claude escalation as a convergence event so the rollover dashboard
    // (#898) can track Keystone win/loss rate without grepping logs.
    if (nextProviderStep.provider === "anthropic" && provider !== "anthropic") {
      try {
        const { emitConvergenceRecord } = require("./convergence-records");
        emitConvergenceRecord({
          hypothesis: `Provider fallback: ${provider} failed → escalating to claude (${taskType})`,
          evidence_ids: [],
          result: {
            type: "claude_fallback",
            trigger: "provider_failed",
            failed_provider: provider,
            fallback_provider: "anthropic",
            fallback_model: nextProviderStep.models[0],
            task_type: taskType,
            failed_providers: [...fallbackState.providers],
            issue_number: context.issueNumber || null,
            keystone_stage: context.keystoneStage || null,
            error: lastError ? String(lastError.message).slice(0, 200) : null,
          },
          confidence: 1.0,
          reasoner: "provider-router",
          verified: false,
          verification_notes: "automatic fallback — not a human decision",
        }).catch(() => {}); // best-effort, never block the fallback
      } catch (_e) { /* require may fail in tests — never block */ }
    }
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
    }, { rotate: true }); // bound growth — appended on every provider call (#872)
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

/**
 * Select provider for the Keystone kernel path (#894). Independent of chat
 * selectProvider so the kernel never inherits the chat surface's Claude default.
 * KEYSTONE_ROLLOVER_MODE: "default" → Keystone/Ouro first, anthropic last-resort;
 * "shadow" (default when unset) → anthropic only (Stage 0, safe).
 * @param {string|null} requestedProvider  explicit override from the request
 * @returns {Promise<{provider:string, model:?string, mode:string}>}
 */
async function selectKernelProvider(requestedProvider = null) {
  const mode = process.env.KEYSTONE_ROLLOVER_MODE || "shadow";

  if (requestedProvider) {
    return { provider: requestedProvider, model: null, mode };
  }

  if (mode === "default") {
    // Try Keystone/Ouro first, fall back to Claude only on failure.
    const kernelChain = PROVIDER_CHAINS.kernel;
    for (const step of kernelChain) {
      if (isProviderHealthy(step.provider)) {
        return { provider: step.provider, model: step.models[0], mode };
      }
    }
  }

  // Shadow mode (or all kernel providers unhealthy): use Claude.
  return { provider: "anthropic", model: "claude-sonnet-5", mode };
}

module.exports = {
  selectProvider,
  callProvider,
  isProviderHealthy,
  recordProviderSuccess,
  recordProviderFailure,
  getProviderStatus,
  selectKernelProvider,
  PROVIDER_CHAINS,
  loadPcsfRouting,
  orderChainByPcsf,
};
