feat(chat): per-provider model dropdown in dream-chat settings (#1127 work item 1)

Settings now shows a Model select under AI Provider for cloud providers
(Claude / ChatGPT / Gemini / Grok), populated from the new
`GET /api/providers/models` endpoint; the default entry reflects the server's
effective `modelFor()` resolution (env override included). The selection is
sent as `model` on `/api/dream/chat/stream` and honoured server-side only when
the provider is also pinned AND the id is on the `provider-models.js`
allowlist (`isAllowedModel`) — an arbitrary or retired id can never hijack
routing, and fallback providers keep their own defaults when the backstop
chain walks past the pin. Persists per provider in localStorage. Improves the
Reason stage (explicit model routing control). Covered by
`test/model-pin.test.js` (8 tests).
