function tryMcpChatReply(messages, context) {
  return {
    source: "mcp_bridge",
    context,
    queued: true,
    status: "waiting_for_mcp_response",
  };
}

function get_mcp_feature_overview() {
  return {
    name: "Lantern MCP Bridge",
    description: "Model Context Protocol, not Multi-Chain Protocol",
    status: "operational",
    features: ["tool_discovery", "tool_invocation", "sse_transport"],
  };
}

function processMcpChatRoute(text, context) {
  const lower = text.toLowerCase();
  const wantsFleet = lower.includes("fleet") || lower.includes("agent");
  const mcpReadOnlyTimeoutMs = 30000;

  if (wantsFleet && context && context.mode === "read_only") {
    return {
      status: "read_only_denied",
      reason: "Read-only chat path only; dispatch requires founder auth",
    };
  }

  return {
    status: "routed_to_mcp",
    wantsFleet,
    timeoutMs: mcpReadOnlyTimeoutMs,
  };
}

function summarizeDispatchFleet(queue) {
  if (!queue || !queue.items) return "No fleet data";
  const active = queue.items.filter((i) => !i.blocked).length;
  const blocked = queue.items.filter((i) => i.blocked).length;
  return `Fleet: ${active} active, ${blocked} blocked`;
}

async function callMcpTool(toolName, args, mcpReadOnlyTimeoutMs) {
  if (toolName === "get_agent_status") {
    return {
      canDispatch: false,
      dispatchableSlots: [],
      reason: "Dispatch held: no safe agent slots available.",
    };
  }
  return null;
}

function runAgentDispatchBatch(now, dispatchableSlots) {
  return {
    timestamp: now,
    slots: dispatchableSlots,
    nextHumanAction: dispatchableSlots.length > 0 ? "Review and approve" : "Wait for slots to register",
  };
}

async function prefilteredFleetDispatch(req) {
  const mcpReadOnlyTimeoutMs = 30000;
  const result = await callMcpTool("get_agent_status", {}, mcpReadOnlyTimeoutMs);
  return result;
}

module.exports = {
  tryMcpChatReply,
  get_mcp_feature_overview,
  processMcpChatRoute,
  summarizeDispatchFleet,
  callMcpTool,
  runAgentDispatchBatch,
  prefilteredFleetDispatch,
};
