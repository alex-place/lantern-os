/**
 * lib/mcp-bridge.js
 *
 * Bridge between keystone-context and mcp-client.
 * Wraps MCP tool calls with graceful offline handling.
 *
 * Usage:
 *   const { callMcpTool } = require('./mcp-bridge');
 *   const result = await callMcpTool('github_list_issues', { repo: 'foo/bar' });
 *   // Returns null if MCP is offline (graceful degradation)
 */

const mcpClient = require("./mcp-client");

/**
 * Call an MCP tool with graceful fallback.
 * If MCP server is offline or the call fails, returns null (degraded mode).
 *
 * @param {string} toolName - MCP tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<any|null>} Tool result, or null if MCP unavailable
 */
async function callMcpTool(toolName, args = {}, timeoutMs = 30000) {
  try {
    // Check if MCP is available
    const available = await mcpClient.isAvailable();
    if (!available) {
      console.debug(`[mcp-bridge] MCP server offline, skipping ${toolName}`);
      return null;
    }

    // Call the tool. Forward the caller's timeout so a hung MCP can't stall the
    // chat turn (keystone-context passes 6000ms; the default stays 30s).
    const result = await mcpClient.callTool(toolName, args, timeoutMs);

    // If result is an error, return null instead of the error object
    // (keystone-context expects null for graceful degradation)
    if (result && result.status === "error") {
      console.debug(`[mcp-bridge] Tool ${toolName} failed: ${result.error}`);
      return null;
    }

    // If result is unavailable, return null
    if (result && result.status === "unavailable") {
      console.debug(`[mcp-bridge] Tool ${toolName} unavailable: ${result.error}`);
      return null;
    }

    // Success: return the tool output/result
    return result;
  } catch (err) {
    // Any unexpected error: log and return null
    console.debug(`[mcp-bridge] Unexpected error calling ${toolName}: ${err.message}`);
    return null;
  }
}

/**
 * Check MCP server health (for diagnostics).
 * Returns true if MCP is available and responding.
 *
 * @returns {Promise<boolean>}
 */
async function isMcpAvailable() {
  try {
    return await mcpClient.isAvailable();
  } catch (err) {
    return false;
  }
}

module.exports = {
  callMcpTool,
  isMcpAvailable,
};
