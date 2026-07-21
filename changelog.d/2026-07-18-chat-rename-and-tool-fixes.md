### Changed

- chat: renamed the primary page **dream-chat.html → chat.html** (page title now "Chat"). A redirect stub is kept at the old path so existing links/bookmarks still work, and every reference was updated: nav (site-chrome + per-page footers), PWA manifest `start_url`, sitemap, the server route map (`routes/pages.js`), the cloud surface allowlist (`deployment-profile.js`), auth-gate PUBLIC list, feature-flags/feature-graph nav, OAuth landing + Indeed callback redirects. Verified live: `/chat.html` serves, `/dream-chat.html` redirects, nav points to `/chat.html`, no console errors.

### Fixed

- chat(#2753): validate tool arguments against each tool's JSON schema in `runTool` before execution — a malformed call now returns a correctable `invalid_arguments` error the model can retry from, instead of silently degrading to `{}` and a mystery empty result. Applies to every provider (shared executor).

### Changed

- chat(#2755): raised the agentic tool-iteration cap (cloud 6→12, local 5→10) and made it configurable via `CHAT_MAX_TOOL_ITERS`, so deep multi-step tasks don't stop short.
- chat(#2759): made the MCP host/port configurable via `MCP_HOST` / `MCP_PORT` (was hardcoded `127.0.0.1:8771`). The GitHub default repo was already `GH_REPO`-overridable.

_Deferred from this batch (need dedicated PRs — all touch the 5 copy-pasted provider branches, verifiable only on one provider in a preview): #2752 parallel tool exec, #2756 unified provider loop, #2758 local-model native tool protocol, #2760 MCP-first-class. #2754 (real token indicator) stays open: the single-shot Gemini path was NOT the primary streaming path on the live server (the patch didn't fire), so real-usage capture needs the primary path identified first — no chars/4 estimate was shipped._
