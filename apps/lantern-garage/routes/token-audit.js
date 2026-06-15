const { sendJson } = require("../lib/http-utils");

module.exports = async (req, res, url, deps) => {
  const { tokenAudit } = deps;

  if (!tokenAudit) {
    sendJson(res, { error: "token-audit not initialized" }, 503);
    return true;
  }

  const pathname = url.pathname;

  // GET /api/token-audit/stats — Overall statistics
  if (pathname === "/api/token-audit/stats" && req.method === "GET") {
    const stats = tokenAudit.getStats();
    sendJson(res, stats, 200);
    return true;
  }

  // GET /api/token-audit/daily — Daily summary
  if (pathname === "/api/token-audit/daily" && req.method === "GET") {
    const daily = tokenAudit.getDailySummary();
    sendJson(res, { daily }, 200);
    return true;
  }

  // GET /api/token-audit/provider/:name — Stats for specific provider
  if (pathname.match(/^\/api\/token-audit\/provider\/[a-z]+$/i) && req.method === "GET") {
    const provider = pathname.split("/").pop();
    const stats = tokenAudit.getProviderStats(provider);
    sendJson(res, { provider, ...stats }, 200);
    return true;
  }

  // GET /api/token-audit/model/:name — Stats for specific model
  if (pathname.match(/^\/api\/token-audit\/model\/.+$/i) && req.method === "GET") {
    const model = pathname.split("/").pop();
    const stats = tokenAudit.getModelStats(model);
    sendJson(res, { model, ...stats }, 200);
    return true;
  }

  // GET /api/token-audit/agent/:name — Stats for specific agent
  if (pathname.match(/^\/api\/token-audit\/agent\/[a-z]+$/i) && req.method === "GET") {
    const agent = pathname.split("/").pop();
    const stats = tokenAudit.getAgentStats(agent);
    sendJson(res, { agent, ...stats }, 200);
    return true;
  }

  return false;
};
