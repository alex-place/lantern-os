// Σ₀ convergence brain: order the providers for THIS turn. The brain
// (provider-router.selectProvider, surfaced as `hintProvider`) decides who LEADS;
// an explicit request pins to one; otherwise the brain's pick leads and a stable
// backstop chain follows. Filtered to providers that actually have a key (ollama is
// always reachable). The single ranked list the dispatch loop walks.
const _PROVIDER_ALIASES = {
  claude: "anthropic", "claude-sonnet": "anthropic", anthropic: "anthropic",
  google: "gemini", gemini: "gemini", openai: "openai", gpt: "openai",
  grok: "xai", xai: "xai", ollama: "ollama", local: "ollama",
  cohere: "cohere", command: "cohere",
};

// True when this deployment is pointed at Vertex. Mirrors gemini-transport.useVertex()
// (kept as a bare env read so ordering never pulls in google-auth-library).
function _vertexConfigured() {
  return process.env.GEMINI_USE_VERTEX === "1" || !!process.env.VERTEX_PROJECT;
}

function _dispatchHasKey(p) {
  const e = process.env;
  switch (p) {
    case "anthropic": return !!e.ANTHROPIC_API_KEY;
    // Gemini is also reachable keyless via Vertex ADC (the funded path) — see
    // lib/gemini-transport.useVertex(). Mirror provider-router.providerHasKey.
    case "gemini": return !!(e.GEMINI_API_KEY || e.GOOGLE_API_KEY || e.GEMINI_USE_VERTEX === "1" || e.VERTEX_PROJECT);
    case "openai": return !!e.OPENAI_API_KEY;
    case "xai": return !!e.XAI_API_KEY;
    case "cohere": return !!e.COHERE_API_KEY;
    case "ollama": return true;
    default: return false;
  }
}

function buildBrainOrder({ requestedProvider, hintProvider }) {
  const DISPATCH = ["anthropic", "gemini", "openai", "xai", "cohere", "ollama"];
  const norm = (p) => {
    const s = String(p || "").toLowerCase();
    if (s.startsWith("gemini-")) return "gemini";   // gemini-2.5-pro etc.
    return _PROVIDER_ALIASES[s] || null;
  };
  if (requestedProvider) {
    const n = norm(requestedProvider);
    if (!n || !DISPATCH.includes(n)) return [];
    // The pinned provider LEADS, but the rest of the chain backstops it: a pinned
    // provider that is rate-limited / down must not dead-end the whole turn. The
    // dispatch loop emits a hard error only if the pinned provider is also the last
    // one standing (see _isLastProvider in stream-chat.js).
    const order = [n];
    for (const p of DISPATCH) if (p !== n) order.push(p);
    return order.filter(_dispatchHasKey);
  }
  const seen = new Set();
  const order = [];
  const push = (p) => { const n = norm(p); if (n && DISPATCH.includes(n) && !seen.has(n)) { seen.add(n); order.push(n); } };
  // Operator preference (KEYSTONE_PREFERRED_PROVIDER) leads Auto mode — e.g. set to
  // "gemini" to spend Google credits first. Only biases the lead; the brain hint and
  // the full backstop chain still follow, so a down/rate-limited preferred provider
  // never dead-ends the turn. Empty/unset → the Vertex default below decides.
  //
  // Vertex being configured means Google Cloud credits are funding this deployment,
  // and Vertex is the ONLY wire that draws them (the AI-Studio key is free-tier and
  // bills nothing — see lib/gemini-transport). So absent an explicit preference,
  // Gemini leads there: spending the credits is the reason Vertex was turned on.
  // Still only a lead bias — the backstop chain follows, so a Vertex outage or
  // rate-limit never dead-ends the turn.
  push(process.env.KEYSTONE_PREFERRED_PROVIDER || (_vertexConfigured() ? "gemini" : null));
  push(hintProvider);                  // the brain's pick leads next
  for (const p of DISPATCH) push(p);   // stable backstop chain after it
  return order.filter(_dispatchHasKey);
}

module.exports = { buildBrainOrder, _PROVIDER_ALIASES, _dispatchHasKey };
