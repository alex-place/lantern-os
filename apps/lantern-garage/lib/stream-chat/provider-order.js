// Σ₀ convergence brain: order the providers for THIS turn. The brain
// (provider-router.selectProvider, surfaced as `hintProvider`) decides who LEADS;
// an explicit request pins to one; otherwise the brain's pick leads and a stable
// backstop chain follows. Filtered to providers that actually have a key (ollama is
// always reachable). The single ranked list the dispatch loop walks.
const _PROVIDER_ALIASES = {
  claude: "anthropic", "claude-sonnet": "anthropic", anthropic: "anthropic",
  google: "gemini", gemini: "gemini", openai: "openai", gpt: "openai",
  grok: "xai", xai: "xai", ollama: "ollama", local: "ollama",
};

function _dispatchHasKey(p) {
  const e = process.env;
  switch (p) {
    case "anthropic": return !!e.ANTHROPIC_API_KEY;
    case "gemini": return !!(e.GEMINI_API_KEY || e.GOOGLE_API_KEY);
    case "openai": return !!e.OPENAI_API_KEY;
    case "xai": return !!e.XAI_API_KEY;
    case "ollama": return true;
    default: return false;
  }
}

function buildBrainOrder({ requestedProvider, hintProvider }) {
  const DISPATCH = ["anthropic", "gemini", "openai", "xai", "ollama"];
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
  // never dead-ends the turn. Empty/unset → unchanged (brain hint leads).
  push(process.env.KEYSTONE_PREFERRED_PROVIDER);
  push(hintProvider);                  // the brain's pick leads next
  for (const p of DISPATCH) push(p);   // stable backstop chain after it
  return order.filter(_dispatchHasKey);
}

module.exports = { buildBrainOrder, _PROVIDER_ALIASES, _dispatchHasKey };
