feat(api,router): OpenAI-compatible /v1 shim + RAM-tiered local model ladder + semantic code index

Make Keystone the convergence layer any OpenAI-speaking tool can point at, and
harden the local-first model floor.

- **/v1/chat/completions + /v1/models shim** (`apps/lantern-garage/routes/v1.js`):
  translates OpenAI `messages`/`model` into the NATIVE stream-chat request, calls
  the existing engine (`deps.handleStreamChat`), and transcodes its `{type:"token"}`
  SSE frames into OpenAI `chat.completion.chunk` frames (streaming) or one
  `chat.completion` object (non-streaming). No chat reimplemented — one adapter over
  the router we already run, so Aider/Continue/Cline set `base_url` and transparently
  get the convergence loop. Registered before auth (API clients use a bearer key, not
  a session); optional `KEYSTONE_V1_API_KEY` gate. VERIFIED live on :4199 — both
  streaming (chunks + role delta + finish_reason stop + `[DONE]`) and non-streaming
  return correct OpenAI shapes and the server stays alive.
- **RAM-tiered escalation ladder** (`data/models/local-registry.json`): five rungs
  (qwen2.5-coder 1.5b/3b/14b/32b + gpt-oss:20b), all `verified:false` so they sort
  BEHIND the on-box-verified Qwen-7B (External Reality Rule) and never auto-lead until
  reproduced on-box. The ladder auto-climbs with `VRAM_BUDGET_GB` (14b@12GB,
  gpt-oss@16GB, 32b@24GB) with zero code change; dormant on the 8GB box.
- **Semantic code index** (`apps/lantern-garage/lib/code-index.js` +
  `scripts/build-code-index.js`): declaration-boundary chunk → nomic-embed (REUSES
  `semantic-reranker.js`'s embed/cosine, now exported) → cosine query over a flat
  `data/code-index/` store, fail-safe to `[]`. Closes the lexical-only code-retrieval
  gap. MVP, zero new deps; retrieval-lift measurement pending Ollama.

Improves Reason (better local model selection + the funnel endpoint), Remember
(semantic code retrieval), and keeps Verify honest (unverified rungs gated).
