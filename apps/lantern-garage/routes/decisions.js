// Decision journal API (#1436) — log life decisions as confident hypotheses, grade the
// outcomes later, and see your calibration.
//
//   GET  /api/decisions                 → { decisions, calibration }
//   POST /api/decisions                 { title, rationale, expectedOutcome, confidence, category, decideBy } → decision
//   POST /api/decisions/:id/resolve     { outcome: good|mixed|bad, notes } → graded decision
//   GET  /api/decisions/calibration     → calibration stats
const dj = require("../lib/decision-journal");

module.exports = async function decisionsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/decisions" && req.method === "GET") {
    const decisions = dj.readDecisions(repoRoot);
    sendJson(res, { ok: true, decisions, calibration: dj.calibration(decisions) }, 200);
    return true;
  }

  if (url.pathname === "/api/decisions/calibration" && req.method === "GET") {
    sendJson(res, { ok: true, calibration: dj.calibration(dj.readDecisions(repoRoot)) }, 200);
    return true;
  }

  if (url.pathname === "/api/decisions" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const decision = dj.createDecision(repoRoot, body);
      sendJson(res, { ok: true, decision }, 201);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 400);
    }
    return true;
  }

  const resolveMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)\/resolve$/);
  if (resolveMatch && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const decision = dj.resolveDecision(repoRoot, decodeURIComponent(resolveMatch[1]), body.outcome, body.notes);
      if (!decision) { sendJson(res, { ok: false, error: "decision_not_found" }, 404); return true; }
      sendJson(res, { ok: true, decision }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 400);
    }
    return true;
  }

  return false;
};
