feat(providers): wire Cohere into the live chat dispatch + swarm orchestrator

Cohere was declared across the config/status/routing layer but no generation
path could actually get text out of it: the main dream-chat streamer had no
Cohere branch (and PCSF ranking excluded it from the executable set), and the
swarm orchestrator's SSE token-extractor had no `cohere` case so its native
`/v2/chat` stream yielded empty tokens.

Now integrated via Cohere's OpenAI-compatible endpoint
(`api.cohere.ai/compatibility/v1/chat/completions`), reusing the existing
OpenAI SSE parser and `openaiCompatibleToolTurn` helper (extended with an
optional `path`):

- `stream-chat/provider-order.js`: `cohere` added to aliases, DISPATCH, and
  `_dispatchHasKey` so the brain can select it (pinned or Auto backstop).
- `stream-chat.js`: full Cohere streamer block (single-shot + CHAT_TOOL_EXEC
  tool loop), mirroring the OpenAI/xAI paths.
- `pcsf-refresh.js`: `cohere` added to the EXECUTABLE set for merit ranking.
- `provider-models.js`: default `command-a-plus-05-2026` (`command-r-plus`
  retired 2025-09-15), overridable via `COHERE_MODEL`.
- `swarm-orchestrator.js`: Cohere repointed to the compat endpoint with
  `streamFormat: "openai"` and refreshed model chain.
- Routing/model tables (`provider-router.js`, `routes/providers.js`) updated
  to the live model id.

Verified end-to-end against the real API with the user's key, driven through
the actual `/api/dream/chat/stream` endpoint on the dev server:
- plain chat: provider `cohere`, model `command-a-plus-05-2026`, `online:true`,
  real streamed reply with the Keystone persona applied;
- native tool loop (CHAT_TOOL_EXEC=1): Cohere issued 3 tool calls and
  synthesized a final answer — Command A function-calling works over the compat
  endpoint, so Cohere is a first-class tool-using provider in chat, not just a
  text completer.
