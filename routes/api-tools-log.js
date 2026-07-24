/**
 * routes/api-tools-log.js
 *
 * REST API for tool execution logs.
 *
 * Endpoints:
 *   GET /api/tools/log/query?tool=Read&status=executed&limit=100
 *   GET /api/tools/log/stats
 *   GET /api/tools/log/failures?limit=50
 *   GET /api/tools/log/health
 *
 * Follows the project's plain-handler convention:
 *   module.exports = async (req, res, url, deps) => boolean
 * Returns true once it has handled (and responded to) the request, false to
 * let the next handler in server.js's `routes` array try. This file previously
 * exported an express.Router() instance — incompatible with this server's
 * dispatcher, which calls handlers as (req, res, url, deps). The mismatch made
 * the router treat `url` as `next`, throwing "fn.apply is not a function" and
 * 500-ing every request that reached it (it sits before convergence-dispatch),
 * which broke the /api/convergence/health deploy gate and pinned stable on an
 * old commit.
 */

const logger = require("../lib/tool-logger");

module.exports = async function apiToolsLogRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  if (!url.pathname.startsWith("/api/tools/log/")) return false;
  if (req.method !== "GET") return false;

  const q = url.searchParams;

  // GET /api/tools/log/query — query tool execution logs
  if (url.pathname === "/api/tools/log/query") {
    try {
      const limit = Math.min(parseInt(q.get("limit"), 10) || 100, 10000);
      const entries = await logger.query({
        tool: q.get("tool") || undefined,
        status: q.get("status") || undefined,
        limit,
        date: q.get("date") || undefined,
      });
      sendJson(res, { count: entries.length, entries }, 200);
    } catch (err) {
      sendJson(res, { error: "failed_to_query_logs", message: err.message }, 500);
    }
    return true;
  }

  // GET /api/tools/log/stats — usage statistics
  if (url.pathname === "/api/tools/log/stats") {
    try {
      const stats = await logger.stats({
        tool: q.get("tool") || undefined,
        status: q.get("status") || undefined,
        date: q.get("date") || undefined,
      });
      sendJson(res, stats, 200);
    } catch (err) {
      sendJson(res, { error: "failed_to_compute_stats", message: err.message }, 500);
    }
    return true;
  }

  // GET /api/tools/log/failures — recent execution failures
  if (url.pathname === "/api/tools/log/failures") {
    try {
      const limit = Math.min(parseInt(q.get("limit"), 10) || 50, 500);
      const failures = await logger.getRecentFailures(limit);
      sendJson(res, { count: failures.length, failures }, 200);
    } catch (err) {
      sendJson(res, { error: "failed_to_query_failures", message: err.message }, 500);
    }
    return true;
  }

  // GET /api/tools/log/health — quick logger health check
  if (url.pathname === "/api/tools/log/health") {
    try {
      const entries = await logger.query({ limit: 1 });
      sendJson(res, {
        status: "ok",
        logger_available: true,
        latest_log_exists: entries.length > 0,
      }, 200);
    } catch (err) {
      sendJson(res, { status: "error", logger_available: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
