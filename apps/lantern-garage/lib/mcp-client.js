/**
 * lib/mcp-client.js
 *
 * MCP server health check and tool routing.
 * If MCP (port 8771) is down, gracefully fall back to local tool execution.
 *
 * Usage:
 *   const mcp = require('./mcp-client');
 *   const available = await mcp.isAvailable();
 *   if (available) {
 *     const result = await mcp.callTool('github_list_issues', { repo: 'foo/bar' });
 *   }
 */

const http = require("http");

// Host/port are configurable (#2759) so a non-default MCP sidecar is reachable.
const MCP_URL = `http://${process.env.MCP_HOST || "127.0.0.1"}:${Number(process.env.MCP_PORT) || 8771}`;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const CACHE_DURATION_MS = 5000; // Cache availability for 5s to avoid hammering

let lastHealthCheck = 0;
let lastAvailability = false;

/**
 * Check if MCP server is running and healthy.
 * Results are cached for CACHE_DURATION_MS.
 */
async function isAvailable() {
  const now = Date.now();
  if (now - lastHealthCheck < CACHE_DURATION_MS) {
    return lastAvailability;
  }

  try {
    const response = await _fetchWithTimeout(`${MCP_URL}/health`, {
      method: "GET",
      timeout: HEALTH_CHECK_TIMEOUT_MS,
    });

    lastAvailability = response.ok;
  } catch (err) {
    lastAvailability = false;
  }

  lastHealthCheck = now;
  return lastAvailability;
}

/**
 * Call a tool via the MCP server (only if available).
 *
 * Uses the server's JSON-RPC `tools/call` over `/messages` — the SAME endpoint the
 * stdio bridge and lib/stream-chat/mcp-tools.js use. The old `/tool/<name>` route
 * this posted to is not exposed by the server (it 404s), so every call errored and
 * mcp-tools.js had to route around this client entirely (#2760). Now fixed, so there
 * is one correct MCP client path.
 *
 * @param {string} toolName - Tool name (e.g., 'github_list_issues')
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} The tool's own payload on success (JSON parsed when the
 *   result is a JSON string), or a standardized { status, reason_code, error } on
 *   offline / RPC error / tool error.
 */
async function callTool(toolName, args = {}, timeoutMs = 30000) {
  if (!(await isAvailable())) {
    return {
      status: "unavailable",
      reason_code: "mcp_server_offline",
      error: "MCP server (port 8771) is not responding",
    };
  }

  try {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: toolName, arguments: args || {} },
    });
    const response = await _fetchWithTimeout(`${MCP_URL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeout: timeoutMs,
    });

    if (!response.ok) {
      return {
        status: "error",
        reason_code: "mcp_tool_error",
        error: `MCP returned ${response.statusCode}: ${response.statusText}`,
      };
    }

    const rpc = response.json();
    if (rpc && rpc.error) {
      return { status: "error", reason_code: "mcp_tool_error", error: rpc.error.message || "mcp error" };
    }
    // JSON-RPC result for tools/call: { content: [{ type:'text', text }], isError }.
    const result = (rpc && rpc.result) || {};
    const text = result.content && result.content[0] && result.content[0].text != null
      ? String(result.content[0].text) : "";
    if (result.isError) {
      return { status: "error", reason_code: "mcp_tool_error", error: text || "tool reported isError" };
    }
    // Surface the tool's own payload: parse the text (usually a JSON string) so callers
    // can read fields directly (e.g. list_skills → .skills); fall back to raw text.
    if (text) { try { return JSON.parse(text); } catch { return { text }; } }
    return result;
  } catch (err) {
    return {
      status: "error",
      reason_code: "mcp_call_failed",
      error: err.message,
    };
  }
}

/**
 * Fetch with timeout (since http.request doesn't have built-in timeout support).
 */
function _fetchWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 5000;
    // http.request()'s callback yields a raw IncomingMessage — NOT a fetch()
    // Response. It exposes `.statusCode` (not `.status`), has no `.ok`, and no
    // `.json()`. Reading `.status`/`.ok`/`.json()` off it (as this file used to)
    // silently made isAvailable() ALWAYS false and callTool() ALWAYS error, even
    // when the MCP server was healthy and returning 200. Buffer the body and
    // resolve a small fetch-like shape so callers can use `.ok`/`.statusCode`/
    // `.json()` correctly.
    const req = http.request(
      url,
      { method: options.method || "GET", headers: options.headers || {} },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          resolve({
            statusCode,
            ok: statusCode >= 200 && statusCode < 300,
            statusText: res.statusMessage || "",
            text: () => data,
            json: () => JSON.parse(data),
          });
        });
        res.on("error", reject);
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`HTTP request timeout after ${timeout}ms`));
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

/**
 * Reset the cache (useful for testing).
 */
function _resetCache() {
  lastHealthCheck = 0;
  lastAvailability = false;
}

module.exports = {
  isAvailable,
  callTool,
  MCP_URL,
  _resetCache, // Exported for testing
};
