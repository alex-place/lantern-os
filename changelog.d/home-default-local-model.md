### Home model dropdown: default to the local model when it's available

The home provider dropdown (`#home-provider-pin`) now leads with the on-device models (Local Σ₀,
Unisona FT) and, on a first visit, **defaults to the local model when `/api/providers/status`
confirms it is up** — so queries route on-device first, matching the "your local AI" promise.

Respectful of explicit choice: an explicit Auto or a pinned provider is still honored (persisted in
localStorage); a saved provider that has since gone offline falls back to Auto and is cleared; and
when local is down — or status is unreachable — it falls back to Auto (that path is unchanged, so a
route to an unconfirmed local model is never forced). The option list is still built dynamically
from `/api/providers/status`, listing only live providers. Verified: 6/6 default-branch unit cases +
all inline scripts parse (`node --check`). The local-up default engages once Ouro/Ollama is serving
(:11434) so the status reports `ollama.available`.
