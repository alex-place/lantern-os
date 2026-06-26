### Chat `web_search`: bounded timeout + retry + keyless fallback (no more silent memory answers)

- The chat tool loop's `web_search` went straight through the MCP search path, which frequently **times out** — the model would then silently answer from its own knowledge. The tool now uses a new `webSearch()` orchestrator: bounded MCP call (per-call timeout + 1 retry), then a **keyless fallback chain** — DuckDuckGo's Instant Answer API, then the Wikipedia search API — so a slow/down MCP path still returns real, cited results.
- On total failure the tool returns an **explicit** `[web_search error: … — search is unavailable right now; say so rather than answering from memory]` instead of an empty result, so the model reports the outage instead of fabricating.
- Tunables: `WEB_SEARCH_MCP_TIMEOUT` (6s), `WEB_SEARCH_DIRECT_TIMEOUT` (6s). Note: DuckDuckGo's HTML scrape endpoint now serves a bot-challenge page, so the JSON Instant Answer API is used directly. Fixes #1212.
