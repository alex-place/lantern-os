// PCSF Provider Health Cache — 60-second in-memory TTL for provider routing state
// Avoids re-probing process.env on every chat request.
// Tracks key presence + last success/failure per provider.

const CACHE_TTL_MS = 60_000;
const MAX_HISTORY = 10;

// Canonical provider descriptors
const PROVIDERS = [
  { id: "keystone-ft", env: ["ANTHROPIC_API_KEY"], managed: true }, // Trained unisona.ai agent w/ memory store
  // GEMINI_USE_VERTEX / VERTEX_PROJECT: Gemini is reachable keyless via Vertex AI
  // (ADC, bills the Cloud project — the funded path). Counting them here keeps
  // gemini "available" for PCSF routing when only Vertex credits are configured.
  { id: "gemini",    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_USE_VERTEX", "VERTEX_PROJECT"] },
  { id: "anthropic", env: ["ANTHROPIC_API_KEY"] },
  { id: "openai",    env: ["OPENAI_API_KEY"] },
  { id: "xai",       env: ["XAI_API_KEY"] },
  { id: "ollama",    env: [] }, // always key-free; reachability checked separately
  { id: "mistral",   env: ["MISTRAL_API_KEY"] },
  { id: "cohere",    env: ["COHERE_API_KEY"] },
  { id: "perplexity", env: ["PERPLEXITY_API_KEY"] },
  { id: "deepseek",  env: ["DEEPSEEK_API_KEY"] },
  { id: "openrouter", env: ["OPENROUTER_API_KEY"] },
];

// Per-provider state
// { hasKey: bool, lastSuccess: ISO|null, lastFailure: ISO|null, lastError: string|null,
//   recentHistory: [{ts, status, error}], cachedAt: ms-timestamp }
const _state = {};
let _fullCacheTs = 0;

function _envPresent(keys) {
  return keys.some(k => !!(process.env[k] && process.env[k].trim()));
}

function _freshEntry(id) {
  const def = PROVIDERS.find(p => p.id === id);
  return {
    id,
    hasKey: def ? _envPresent(def.env) : false,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    recentHistory: [],
    cachedAt: Date.now(),
  };
}

function _ensureEntry(id) {
  if (!_state[id]) _state[id] = _freshEntry(id);
  return _state[id];
}

/**
 * Refresh the full provider snapshot from process.env.
 * Called at most once per TTL window.
 */
function refreshProviderCache() {
  const now = Date.now();
  for (const prov of PROVIDERS) {
    const entry = _ensureEntry(prov.id);
    entry.hasKey = _envPresent(prov.env);
    entry.cachedAt = now;
  }
  _fullCacheTs = now;
}

/**
 * Return current provider state map, refreshing if the TTL has expired.
 * Returns { gemini, anthropic, openai, xai, ollama, mistral, cohere, perplexity, deepseek, openrouter }
 * each with {hasKey, ...}.
 */
function getProviderState() {
  const now = Date.now();
  if (now - _fullCacheTs > CACHE_TTL_MS) {
    refreshProviderCache();
  }
  const result = {};
  for (const prov of PROVIDERS) {
    result[prov.id] = { ..._ensureEntry(prov.id) };
  }
  return result;
}

/**
 * Record a successful response from a provider.
 * @param {string} id  Provider id (gemini | anthropic | openai | xai | ollama)
 * @param {object} [meta]  Optional metadata (model, latency_ms)
 */
function recordProviderSuccess(id, meta = {}) {
  const entry = _ensureEntry(id);
  const ts = new Date().toISOString();
  entry.lastSuccess = ts;
  entry.lastError = null;
  entry.recentHistory.push({ ts, status: "ok", ...meta });
  if (entry.recentHistory.length > MAX_HISTORY) entry.recentHistory.shift();
}

/**
 * Record a failure from a provider.
 * @param {string} id     Provider id
 * @param {string} error  Error message / code
 */
function recordProviderFailure(id, error = "") {
  const entry = _ensureEntry(id);
  const ts = new Date().toISOString();
  entry.lastFailure = ts;
  entry.lastError = error;
  entry.recentHistory.push({ ts, status: "fail", error });
  if (entry.recentHistory.length > MAX_HISTORY) entry.recentHistory.shift();
}

/**
 * Return a redacted snapshot suitable for the /api/pcsf/routing endpoint.
 * Never exposes key values — only presence flags and history.
 */
function getRoutingSnapshot() {
  const state = getProviderState();
  const cacheAge = Math.round((Date.now() - _fullCacheTs) / 1000);
  return {
    schema: "lantern.pcsf.routing.v1",
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    cacheAgeSeconds: cacheAge,
    providers: Object.values(state).map(p => ({
      id: p.id,
      hasKey: p.hasKey,
      lastSuccess: p.lastSuccess,
      lastFailure: p.lastFailure,
      lastError: p.lastError,
      recentHistoryCount: p.recentHistory.length,
      recentHistory: p.recentHistory.slice(-5),
    })),
  };
}

// Prime the cache on module load
refreshProviderCache();

module.exports = { getProviderState, recordProviderSuccess, recordProviderFailure, getRoutingSnapshot, refreshProviderCache };
