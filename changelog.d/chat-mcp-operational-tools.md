Give the keystone (dream) chat assistant access to the local MCP server's
operational tools, for every provider, gated to operator sessions.

Before: each provider's native tool-use loop (Ouro/Ollama, Grok, Gemini, Claude,
OpenAI, Cohere) only saw the built-in tool-runner surface (~27 tools). Now, when
isOperatorRequest(req) is true, they also get the 94 MCP-specific operational tools
(queue/task_run, research_*, the full github_* suite, local_runner, local_git_*,
convergence_run, mesh_*, mcp_capability_status).

Implementation: lib/stream-chat/mcp-tools.js exposes augment(toolRunner) — a thin
wrapper that appends the MCP tools to anthropicTools/openaiTools/geminiTools and
renderToolPreamble (only when {operator:true}) and routes runTool(name,...) for
those names to the MCP server's JSON-RPC /messages tools/call endpoint. Every
provider block in stream-chat.js adopts it via a one-line require swap. Built-in
tools remain on the canonical local executor; guests are unchanged; non-operator
execution of an MCP tool is denied in depth.

Descriptors are discovered from the live server (tools/list filtered to
mcp_specific_operational) and warm-started from data/mcp/operational-tools.json.
Note: lib/mcp-client.js posts to /tool/<name>, which the server does not expose
(404) — this path uses the working /messages endpoint instead.
