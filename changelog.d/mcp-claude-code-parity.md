Connect Claude Code to the Lantern OS MCP server with full keystone-chat tool parity.

- Add project-scoped `.mcp.json` registering the `lantern-os` stdio bridge for Claude Code.
- Fix `scripts/mcp_stdio_bridge.py` JSON-RPC correctness: echo the client's request id
  (was hardcoded to 1), stay silent on notifications, drop the unsolicited initialize
  response, and force `CHAT_TOOL_EXEC=1` + `MCP_SHARED_TOOL_OPERATOR=1` on the spawned
  server so the canonical shared tools execute with operator rights.
- Fix `src/agent_tool_hooks.py` CSF result cache: never store or replay denied/failed
  results (was poisoning later operator calls) and never cache live filesystem/shell
  tools (was serving stale file contents), so the MCP surface matches keystone chat,
  which calls tool-runner.js directly with no result cache.
