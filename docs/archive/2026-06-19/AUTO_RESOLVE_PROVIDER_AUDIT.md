# Auto Resolve Provider Audit

**Date:** 2026-06-15
**Scope:** Does "Auto Resolve" in Dream Chat hardcode OpenAI and bypass Claude?
**Verdict:** ❌ **Hypothesis not confirmed.** Auto Resolve is *not* hardcoded to OpenAI. OpenAI is the **last** fallback in both code paths. Claude support already exists and is wired correctly. The real cause of "Claude never answers" was a **configuration gap** (`ANTHROPIC_API_KEY` was empty) plus a **provider-ordering issue** where the Σ₀ router-gate's Claude escalation was computed but never applied.

**Status (2026-06-15):** ✅ Config fixed (valid `ANTHROPIC_API_KEY` set) — explicit Claude verified through the streaming endpoint (`source: anthropic`). ✅ Code fix applied + verified — Auto mode now honors the router/Σ₀ escalation to Claude (`stream-chat.js`). No new integration built (Claude support already existed).

---

## TL;DR

| Question | Answer |
|---|---|
| How does Auto Resolve select providers? | Two hardcoded priority ladders (one per code path). Auto = empty `requestedProvider`. |
| Is provider selection hardcoded to OpenAI? | **No.** OpenAI is priority **4/last** in both ladders. |
| Does Claude provider support exist elsewhere? | **Yes** — fully implemented in both `dream-chat.js` and `stream-chat.js`. |
| Does Dream Chat bypass the provider abstraction? | **Yes, partially.** `provider-router.selectProvider()` is *called* but its result is **ignored** (only logged). `provider-router.callProvider()` → `_callProviderImpl()` is an **unimplemented stub**. |
| Can Auto Resolve route through the provider manager? | Selection: already computed (just unused). Execution: would need the stub implemented — a real refactor, not a one-liner. |
| Why does the user see OpenAI? | `ANTHROPIC_API_KEY` empty (Claude skipped) + `GEMINI_API_KEY` rate-limited (429s) → Auto falls past Gemini to OpenAI. |

---

## Two chat paths (this matters)

There are **two** files named `dream-chat.js` and **two** request paths:

| Path | Endpoint | Handler | Used by |
|---|---|---|---|
| **Streaming** | `POST /api/dream/chat/stream` | `apps/lantern-garage/lib/stream-chat.js` | **The Dream Chat UI** (`public/js/dream-chat.js:441`) |
| Non-streaming | `POST /api/dream/...` | `apps/lantern-garage/lib/dream-chat.js` → `dreamChatReply()` | PR Watcher, sync callers |

> The frontend `apps/lantern-garage/public/js/dream-chat.js` is the UI; the backend `apps/lantern-garage/lib/dream-chat.js` is the persona/provider logic. Neither hardcodes OpenAI.

---

## Current flow (actual, verified)

```
Dream Chat UI (public/js/dream-chat.js:437,446)
   → provider = <dropdown value or undefined>   ("claude" | "openai" | "gemini" | "" = Auto)
   → POST /api/dream/chat/stream
        → stream-chat.js
             → selectProvider(...) computed at :940  ❗ result stored in primaryProviderHint and ONLY logged — never used to route
             → hardcoded ladder actually decides:
                  Provider 0  Ollama       (:988  if !requestedProvider || ollama|local)
                  Provider 0b Keystone-FT  (:1058 explicit only)
                  Provider 1  Gemini       (:1099 if geminiKey && (!requestedProvider || gemini...))
                  Provider 2  Anthropic    (:1195 if anthropicKey && (!requestedProvider || claude|anthropic|claude-sonnet))
                  Provider 3  OpenAI       (:1281 if openaiKey && (!requestedProvider || openai|gpt))   ← LAST
                  Fallback    streamLocalFallback (:1527)
```

Non-streaming ladder (`lib/dream-chat.js:720-955`) is the same idea but a **different order**:
`Ollama (1) → Anthropic/Claude (2) → Gemini (3) → OpenAI (4/last)`.

### Provider abstraction status (`lib/provider-router.js`)
- `selectProvider()` (:61) — **works**, returns a task-type-aware recommendation (e.g. `reasoning → anthropic` first). Both chat paths call it.
- `callProvider()` (:113) → `_callProviderImpl()` (:222) — **stub that throws** `"Sync call not implemented … Use stream-chat.js for streaming."` The execution layer was never built; the file's own header says *"Replaces scattered fallback chains in stream-chat.js and dream-chat.js"* — that replacement never happened.
- Net: the "provider manager" can **recommend** but cannot **execute**, so both paths ignore the recommendation and run their own inline ladders.

---

## Desired flow

```
Dream Chat
   → Provider Router (selectProvider already returns the right pick)
   → callProvider() executes against the chosen provider
        → Ollama | Claude | Gemini | OpenAI | …
   → Response
```

The selection half already exists; the missing piece is wiring **execution** through the router (implementing `_callProviderImpl`) **or**, much cheaper, having each path honor the already-computed `primaryProviderHint` to order its ladder.

---

## Evidence (dev-preview, server on :4178)

1. **`ANTHROPIC_API_KEY len=0`** in the loaded `.env` (GEMINI len=53, OPENAI len=23). Server log confirms: `[dream-chat] DEBUG: anthropicKey exists: false`. → Claude's block (`stream-chat.js:1195 if (anthropicKey && …)`) is skipped entirely; explicit `provider:"claude"` falls through to `source:"offline"`.
2. **Auto Resolve did NOT pick OpenAI.** `POST /api/dream/chat/stream {provider:""}` → `source:"ollama"` (never OpenAI).
3. **Explicit `provider:"openai"` → `source:"failed"`** — the 23-char `OPENAI_API_KEY` is a placeholder (401). OpenAI doesn't even function here, so it cannot be the forced default.
4. Server logs show repeated **Gemini `quota`/`429`** — when Gemini is throttled in Auto mode, the ladder advances to OpenAI, which is the only scenario that surfaces an OpenAI response.

---

## Root cause

The reported symptom ("Auto → OpenAI, never Claude") is produced by **configuration + ordering**, not hardcoding:

1. `ANTHROPIC_API_KEY` is **empty** → Claude is never eligible in either path.
2. `GEMINI_API_KEY` is valid but **rate-limited** → Auto advances past Gemini.
3. The next live provider is OpenAI → the user sees OpenAI.

---

## What was done (no new integration — Claude already existed)

**Did NOT build a new Claude integration.** It exists and is correct (`stream-chat.js:1195`, `dream-chat.js:778`).

1. **Config fix — APPLIED ✅:** set a valid `ANTHROPIC_API_KEY` in the worktree `.env` (gitignored; not committed). Selecting **Claude** in the dropdown now routes to `api.anthropic.com` — verified end-to-end via `POST /api/dream/chat/stream {provider:"claude"}` → `done.source = "anthropic"`.
2. **Code fix — APPLIED + VERIFIED ✅:** the **streaming** Auto ladder now honors the already-computed `primaryProviderHint` (`stream-chat.js:~947`). When the user picks Auto **and** the Σ₀ router-gate escalates a substantive turn to the reasoning chain (`selectProvider → anthropic`), the new `autoPrefersAnthropic` flag skips the Ollama/Gemini first-attempts so Claude handles the turn; OpenAI + the local fallback still backstop a Claude failure. Explicit provider selections and non-escalated Auto turns (which stay local-first) are unchanged.
   - **Verification:** a 248-char novel prompt in Auto logged `[router-gate] escalate -> reasoning (score=0.60>=0.45)` → `[provider-router] Selected anthropic for reasoning`, with **no Ollama/Gemini attempt** afterward (non-escalated turns still log Ollama-first). A trivial Auto prompt still logged `Selected ollama for creative` (local-first preserved).
3. **Larger refactor (NOT done — optional future work):** implement `provider-router._callProviderImpl()` with streaming, then have both paths call `callProvider()` so the router is the single execution path too. Medium effort; deferred unless the duplication becomes a maintenance problem.

> Note: fix #2 is a behavioral change for *escalated* Auto turns only (they now prefer Claude over Gemini's free grounding). Non-escalated Auto turns are unchanged (still Ollama→Gemini→Anthropic→OpenAI).

---

## Success test (PASSED)

| Step | Result |
|---|---|
| Provider = Claude, send message | ✅ routes to `api.anthropic.com` (`stream-chat.js:1195`) |
| Response generated through Claude | ✅ `done.source = "anthropic"`, `receipt.provider = "anthropic"` |
| Auto mode on a substantive turn | ✅ Σ₀ gate escalates → router picks anthropic → Claude answers (Ollama/Gemini skipped) |
| No OpenAI dependency required | ✅ OpenAI is last fallback; never selected in any test |
