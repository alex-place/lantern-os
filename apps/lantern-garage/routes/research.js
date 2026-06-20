// Open-video research flywheel — read-only status for the Creator Dashboard.
const { getResearchStatus } = require("../lib/research-status");

module.exports = async function researchRoutes(req, res, url, deps) {
  if (url.pathname === "/api/research/status") {
    try {
      deps.sendJson(res, getResearchStatus(deps.repoRoot));
    } catch (e) {
      deps.sendJson(res, { ok: false, error: e.message }, 500);
    }
    return true;
  }
};
