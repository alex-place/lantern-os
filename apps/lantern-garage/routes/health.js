// Health / symptom journal API (#1435). Local-only; cite-or-abstain, never diagnoses.
//   GET  /api/symptoms           → { entries, patterns, summary }
//   POST /api/symptoms           { symptom, severity, factors:[...], note?, date? } → entry
const hj = require("../lib/health-journal");

module.exports = async function healthRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/symptoms" && req.method === "GET") {
    const entries = hj.readEntries(repoRoot);
    sendJson(res, { ok: true, entries, patterns: hj.findPatterns(entries), summary: hj.summary(entries) }, 200);
    return true;
  }

  if (url.pathname === "/api/symptoms" && req.method === "POST") {
    try {
      const entry = hj.logEntry(repoRoot, JSON.parse((await collectRequestBody(req)) || "{}"), new Date().toISOString());
      sendJson(res, { ok: true, entry }, 201);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  return false;
};
