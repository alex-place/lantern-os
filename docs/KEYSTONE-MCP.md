---
author: Alex Place
created: 2026-06-18
updated: 2026-06-20
---

# Keystone ↔ MCP / live project context

Keystone chat is linked to the project's real tools and details, so **any provider
(including Grok)** answers grounded in the live repo — not generic guesses.

## What gets injected
Before each non-roleplay chat turn, [`lib/keystone-context.js`](../apps/lantern-garage/lib/keystone-context.js)
gathers (best-effort, cached 60s) and prepends to the Keystone system prompt:
- **Open GitHub issues + PRs** (via `gh` — the reliable path).
- **MCP tool inventory + status** (via `callMcpTool` → the MCP server `/tools/*`).
  If the MCP server is offline it says so; GitHub still works via `gh`.
- **Current branch.**

Because it's injected into the system prompt, it is **provider-agnostic** — Claude,
Gemini, Grok, or the local `lantern-sigma0-coder` all answer with the same live context.

## MCP client
[`lib/mcp-bridge.js`](../apps/lantern-garage/lib/mcp-bridge.js) `callMcpTool(name, args)`
is a real client: `GET ${MCP_BASE_URL}/tools/{name}?args` → JSON. It never throws
(resolves `null` on server-down/401/timeout). Configure:
- `MCP_BASE_URL` (default `http://127.0.0.1:8771`)
- `MCP_TOKEN` (optional bearer)

Start the MCP server (for the full tool surface incl. GitHub tools):
`python src/mcp_server/server.py`

## Routing interplay
- **Live/stateful queries** ("current open issues", "status now", "what's next") are
  detected (`wantsLiveData`) and **never short-circuited** to a static KB doc — they
  go to the LLM with the live context above.
- **Static knowledge** ("what is Ouro", "how does CSF-Pack work") can still be answered
  $0 from the Knowledge Center grounding ([CSF spec §2.9](CSF-FORMAT-SPECIFICATION.md)).

Disable with `KEYSTONE_MCP=0`.

## Verified
Asking "List the current open issues and PRs" returns the real open issues/PRs
(e.g. #707, #698, #690, PR #708) via the local model — confirming live grounding.

## Gaps / next
- **Google Drive details** need a Drive connector tool in the MCP server (none today);
  the gatherer will include it once a `drive_*` MCP tool exists.
- True **tool-calling** (the LLM invoking MCP tools mid-answer) is a larger step;
  this is context-injection grounding, which covers most "what's the project state" asks.
