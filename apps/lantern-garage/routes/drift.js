// Drift observability API (#1428) — GET /api/drift[?windowHours=24]
// Aggregates the passive canary event stream into a drift assessment.
const { assessDrift, readCanaryEvents } = require("../lib/drift-monitor");

module.exports = async function driftRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps;

  if (url.pathname === "/api/drift" && req.method === "GET") {
    try {
      const windowHours = Math.min(720, Math.max(1, parseInt(url.searchParams.get("windowHours") || "24", 10) || 24));
      const drift = assessDrift(readCanaryEvents(repoRoot), { windowMs: windowHours * 3_600_000 });
      sendJson(res, { ok: true, drift }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
