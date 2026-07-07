Add a self-diagnosing `mcp_capability_status` tool to the Lantern OS MCP server.

Ported from the gm-agent-orchestrator MCP (`get_mcp_capability_status`) after an
audit comparing the two servers. Lantern was ahead on transport, tool count, and
convergence receipts; the orchestrator's one clear edge was a capability map that
reports, per capability, whether it is available, the blocker, and the next action.

The new tool reads live process state (env flags, module-import success, the Node
runtime) — never fabricated — for: node_tool_bridge, shared_tool_execution
(CHAT_TOOL_EXEC), operator_tools (MCP_SHARED_TOOL_OPERATOR), github_write,
local_runner, and the opt-in sandboxed_executor. Opt-in capabilities are excluded
from known_gaps, and a keystone_parity boolean says whether the shared toolset will
execute like keystone chat. Improves Observe/Verify.
