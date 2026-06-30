// Personal preference model API (#1426).
//   GET  /api/preferences                → { decisions, weights, profile }
//   POST /api/preferences/decide         { item, features:[...], accepted } → decision
//   POST /api/preferences/rank           { candidates:[{id,features}] } → ranked (by taste)
const pm = require("../lib/preference-model");

module.exports = async function preferencesRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/preferences" && req.method === "GET") {
    const decisions = pm.readDecisions(repoRoot);
    const weights = pm.learnWeights(decisions);
    sendJson(res, { ok: true, count: decisions.length, weights, profile: pm.tasteProfile(weights) }, 200);
    return true;
  }

  if (url.pathname === "/api/preferences/decide" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const decision = pm.recordDecision(repoRoot, body, new Date().toISOString());
      sendJson(res, { ok: true, decision, profile: pm.tasteProfile(pm.learnWeights(pm.readDecisions(repoRoot))) }, 201);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  if (url.pathname === "/api/preferences/rank" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const weights = pm.learnWeights(pm.readDecisions(repoRoot));
      sendJson(res, { ok: true, ranked: pm.rankItems(body.candidates || [], weights) }, 200);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  return false;
};
