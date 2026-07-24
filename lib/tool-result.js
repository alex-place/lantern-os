/**
 * lib/tool-result.js
 *
 * Standardized tool result envelope: every tool returns {status, reason_code, output, ...}.
 * This ensures Claude Code can distinguish between different failure modes.
 *
 * Status codes:
 *   - 'executed'   : tool ran successfully
 *   - 'denied'     : operator permission denied
 *   - 'blocked'    : execution blocked (unsafe path, disallowed command)
 *   - 'unavailable': tool not available or execution disabled
 *   - 'timeout'    : tool execution exceeded time limit
 *   - 'error'      : execution error (network, crash, etc.)
 *
 * Reason codes:
 *   - 'ok'
 *   - 'operator_required'
 *   - 'unsafe_path'
 *   - 'command_not_allowlisted'
 *   - 'private_host_blocked' (SSRF protection)
 *   - 'execution_error'
 *   - 'timeout'
 *   - 'mcp_server_offline'
 *   - 'unknown_tool'
 *   - 'chat_tool_exec_disabled'
 */

/**
 * Create a successful execution result.
 *
 * @param {string} output - Tool output (string or serializable object)
 * @param {Object} metadata - Optional metadata ({ duration_ms, output_length, etc. })
 * @returns {Object} Standardized result
 */
function success(output, metadata = {}) {
  const str = String(output || "");
  return {
    status: "executed",
    reason_code: "ok",
    output: str,
    output_length: str.length,
    ...metadata,
  };
}

/**
 * Create a denied (permission) result.
 *
 * @param {string} message - Error message
 * @returns {Object} Standardized result
 */
function denied(message) {
  return {
    status: "denied",
    reason_code: "operator_required",
    error: String(message),
    output: null,
  };
}

/**
 * Create a blocked (safety) result.
 *
 * @param {string} reasonCode - Reason (unsafe_path, command_not_allowlisted, private_host_blocked)
 * @param {string} message - Error message
 * @returns {Object} Standardized result
 */
function blocked(reasonCode, message) {
  return {
    status: "blocked",
    reason_code: String(reasonCode),
    error: String(message),
    output: null,
  };
}

/**
 * Create an unavailable (tool not found, execution disabled) result.
 *
 * @param {string} reasonCode - Reason (unknown_tool, chat_tool_exec_disabled, mcp_server_offline)
 * @param {string} message - Error message
 * @returns {Object} Standardized result
 */
function unavailable(reasonCode, message) {
  return {
    status: "unavailable",
    reason_code: String(reasonCode),
    error: String(message),
    output: null,
  };
}

/**
 * Create a timeout result.
 *
 * @param {number} durationMs - How long it took before timeout
 * @returns {Object} Standardized result
 */
function timeout(durationMs) {
  return {
    status: "timeout",
    reason_code: "timeout",
    error: `Tool execution exceeded time limit (${durationMs}ms)`,
    output: null,
    duration_ms: durationMs,
  };
}

/**
 * Create an error (execution failed) result.
 *
 * @param {string} message - Error message
 * @param {string} [reasonCode] - Optional reason code (default: execution_error)
 * @returns {Object} Standardized result
 */
function error(message, reasonCode = "execution_error") {
  return {
    status: "error",
    reason_code: String(reasonCode),
    error: String(message),
    output: null,
  };
}

/**
 * Convert a legacy string/object result to standardized format.
 * Used for backwards compatibility during migration.
 *
 * @param {string|Object} result - Raw result from tool
 * @param {string} [status] - Status if not already set
 * @returns {Object} Standardized result
 */
function normalize(result, status = "executed") {
  if (result && typeof result === "object" && result.status) {
    // Already normalized
    return result;
  }

  // Convert string to envelope
  const str = String(result || "");
  return {
    status,
    reason_code: "ok",
    output: str,
    output_length: str.length,
  };
}

/**
 * Check if a result is a success.
 */
function isSuccess(result) {
  return result && result.status === "executed" && result.reason_code === "ok";
}

/**
 * Check if a result is a failure (not success).
 */
function isFailure(result) {
  return !isSuccess(result);
}

module.exports = {
  success,
  denied,
  blocked,
  unavailable,
  timeout,
  error,
  normalize,
  isSuccess,
  isFailure,
};
