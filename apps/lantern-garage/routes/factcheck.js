// Personal fact-check API (#1430) — POST /api/factcheck { claim }
// → { verdict, confidence, reasoning, sources } grounded in real web sources.
const { factCheck } = require("../lib/factcheck");

module.exports = async function factcheckRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  if (url.pathname === "/api/factcheck" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const claim = String(body.claim || "").trim();
      if (!claim) { sendJson(res, { ok: false, error: "claim is required" }, 400); return true; }
      const result = await factCheck(claim, { maxResults: 6 });
      sendJson(res, result, result.ok ? 200 : 400);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
