// Convergence Replay API (#1419) — GET /api/replay[?reasoner=X]
// Builds a step-by-step reasoning timeline (with regressions) from the convergence records.
const rp = require("../lib/replay");

module.exports = async function replayRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps;

  if (url.pathname === "/api/replay" && req.method === "GET") {
    try {
      const records = rp.readRecords(repoRoot);
      const reasoner = url.searchParams.get("reasoner") || undefined;
      const timeline = rp.buildTimeline(records, { reasoner });
      const allRegressions = rp.findRegressions(timeline);
      sendJson(res, {
        ok: true,
        count: timeline.length,
        reasoners: rp.reasoners(rp.buildTimeline(records)),
        regressionsTotal: allRegressions.length,
        regressions: allRegressions.slice(0, 50),   // cap the list; full count in regressionsTotal
        timeline,
      }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
