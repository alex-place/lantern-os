/**
 * routes/auto-dispatch.js — runtime control + status for the autonomous auto-pull loop.
 *
 *   GET  /api/convergence/auto-dispatch/status  → truthful loop status (enabled,
 *        in-flight, last pick/result, history, guardrails, next run)
 *   POST /api/convergence/auto-dispatch/toggle  → kill switch; body { enabled: bool }
 *
 * The loop itself lives in lib/auto-dispatch.js (always armed; tick is a no-op
 * while disabled). Plain-handler convention.
 */
const auto = require("../lib/auto-dispatch");

module.exports = async function autoDispatchRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  if (url.pathname === "/api/convergence/auto-dispatch/status" && req.method === "GET") {
    try {
      sendJson(res, { ok: true, ...auto.getStatus() }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  if (url.pathname === "/api/convergence/auto-dispatch/toggle" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const { enabled } = JSON.parse(body || "{}");
      if (typeof enabled !== "boolean") {
        sendJson(res, { ok: false, error: "enabled_boolean_required" }, 400);
        return true;
      }
      const now = auto.setEnabled(enabled);
      sendJson(res, { ok: true, enabled: now, ...auto.getStatus() }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
