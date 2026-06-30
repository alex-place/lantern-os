// Personal financial reasoning cockpit API (#1434). Local-only: the snapshot stays on disk.
//   GET  /api/finance                → { snapshot, analysis }
//   POST /api/finance/analyze        { ...profile } → { analysis } (and persists the snapshot)
//   POST /api/finance/afford         { profile, purchase } → affordability stress-test
const fc = require("../lib/financial-cockpit");

module.exports = async function financeRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/finance" && req.method === "GET") {
    const snapshot = fc.readSnapshot(repoRoot);
    sendJson(res, { ok: true, snapshot, analysis: snapshot ? fc.analyze(snapshot) : null }, 200);
    return true;
  }

  if (url.pathname === "/api/finance/analyze" && req.method === "POST") {
    try {
      const profile = JSON.parse((await collectRequestBody(req)) || "{}");
      fc.saveSnapshot(repoRoot, profile);
      sendJson(res, { ok: true, analysis: fc.analyze(profile) }, 200);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  if (url.pathname === "/api/finance/afford" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const profile = body.profile || fc.readSnapshot(repoRoot) || {};
      sendJson(res, { ok: true, affordability: fc.affordability(profile, body.purchase || {}) }, 200);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  return false;
};
