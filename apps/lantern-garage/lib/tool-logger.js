/**
 * lib/tool-logger.js
 *
 * Structured logging for every tool execution.
 * Logs to data/tool-logs/YYYY-MM-DD.jsonl for analysis and debugging.
 *
 * Usage:
 *   const logger = require('./tool-logger');
 *   await logger.log({
 *     tool: 'Read',
 *     input: { file_path: 'foo.js', limit: 10 },
 *     status: 'executed',
 *     output_length: 500,
 *     duration_ms: 45,
 *     operator: true,
 *     provider: 'anthropic',
 *     error_code: null,
 *   });
 */

const fs = require("fs");
const path = require("path");
const { appendFile } = require("fs").promises;

const REPO = path.resolve(__dirname, "..", "..", "..");
const LOGS_DIR = path.join(REPO, "data", "tool-logs");

// Ensure logs directory exists
function _ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Get today's log file path (YYYY-MM-DD.jsonl)
 */
function _getTodayLogPath() {
  const now = new Date();
  const date = now.toISOString().split("T")[0]; // YYYY-MM-DD
  return path.join(LOGS_DIR, `${date}.jsonl`);
}

/**
 * Log a tool execution.
 *
 * @param {Object} entry - Execution details
 * @param {string} entry.tool - Tool name (e.g., 'Read', 'Bash', 'web_search')
 * @param {Object} entry.input - Tool input object
 * @param {string} entry.status - 'executed' | 'denied' | 'blocked' | 'timeout' | 'error'
 * @param {string} [entry.error_code] - Error code if status !== 'executed'
 * @param {string} [entry.error_message] - Human-readable error message
 * @param {number} [entry.output_length] - Length of output (chars or bytes)
 * @param {number} [entry.duration_ms] - Time taken (milliseconds)
 * @param {boolean} [entry.operator] - Was this called by an operator?
 * @param {string} [entry.provider] - Which provider called this (e.g., 'anthropic', 'openai')
 * @param {string} [entry.session_id] - Chat session ID
 * @param {string} [entry.user] - User identifier
 * @returns {Promise<void>}
 */
async function log(entry) {
  _ensureLogsDir();

  const logEntry = {
    timestamp: new Date().toISOString(),
    tool: entry.tool,
    input: _sanitizeInput(entry.input),
    status: entry.status || "unknown",
    error_code: entry.error_code || null,
    error_message: entry.error_message || null,
    output_length: entry.output_length || null,
    duration_ms: entry.duration_ms || null,
    operator: entry.operator ?? false,
    provider: entry.provider || null,
    session_id: entry.session_id || null,
    user: entry.user || null,
  };

  try {
    const logPath = _getTodayLogPath();
    const line = JSON.stringify(logEntry) + "\n";
    await appendFile(logPath, line, "utf-8");
  } catch (err) {
    // Logging failures should not crash the app
    console.warn(`[ToolLogger] Failed to write log: ${err.message}`);
  }
}

/**
 * Sanitize input for logging (remove sensitive data like API keys).
 */
function _sanitizeInput(input) {
  if (!input || typeof input !== "object") return input;

  const sanitized = { ...input };
  const sensitiveKeys = ["api_key", "token", "password", "secret", "auth"];

  for (const [key, value] of Object.entries(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      sanitized[key] = "[REDACTED]";
    }
  }

  return sanitized;
}

/**
 * Query tool logs.
 *
 * @param {Object} options - Query options
 * @param {string} [options.tool] - Filter by tool name
 * @param {string} [options.status] - Filter by status ('executed', 'denied', etc.)
 * @param {number} [options.limit] - Max entries to return (default 1000)
 * @param {string} [options.date] - Specific date to query (YYYY-MM-DD, default today)
 * @returns {Promise<Array>} Array of log entries
 */
async function query(options = {}) {
  _ensureLogsDir();

  const { tool, status, limit = 1000, date } = options;

  // Determine which log file(s) to read
  let logPath;
  if (date) {
    logPath = path.join(LOGS_DIR, `${date}.jsonl`);
  } else {
    logPath = _getTodayLogPath();
  }

  if (!fs.existsSync(logPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);

    let entries = lines.map((line) => JSON.parse(line));

    // Filter
    if (tool) {
      entries = entries.filter((e) => e.tool === tool);
    }
    if (status) {
      entries = entries.filter((e) => e.status === status);
    }

    // Limit
    entries = entries.slice(-limit);

    return entries;
  } catch (err) {
    console.warn(`[ToolLogger] Failed to query logs: ${err.message}`);
    return [];
  }
}

/**
 * Get summary statistics for tool usage.
 *
 * @param {Object} options - Query options (same as query())
 * @returns {Promise<Object>} Statistics object
 */
async function stats(options = {}) {
  const entries = await query({ ...options, limit: 10000 });

  if (!entries.length) {
    return {
      total: 0,
      by_tool: {},
      by_status: {},
      by_provider: {},
      avg_duration_ms: 0,
    };
  }

  const byTool = {};
  const byStatus = {};
  const byProvider = {};
  let totalDuration = 0;
  let durationCount = 0;

  entries.forEach((e) => {
    byTool[e.tool] = (byTool[e.tool] || 0) + 1;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    if (e.provider) {
      byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    }
    if (e.duration_ms) {
      totalDuration += e.duration_ms;
      durationCount += 1;
    }
  });

  return {
    total: entries.length,
    by_tool: byTool,
    by_status: byStatus,
    by_provider: byProvider,
    avg_duration_ms: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  };
}

/**
 * Get recent tool execution failures.
 *
 * @param {number} [limit] - Max failures to return (default 100)
 * @returns {Promise<Array>} Recent failures
 */
async function getRecentFailures(limit = 100) {
  return query({ status: "error", limit });
}

module.exports = {
  log,
  query,
  stats,
  getRecentFailures,
  _sanitizeInput, // Exported for testing
};
