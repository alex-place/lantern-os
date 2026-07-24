/**
 * Agent Performance Endpoints
 * HTTP API for querying performance leaderboard and recording agent calls
 * Used by Convergence IO (Python) and stream-chat (Node.js)
 */

const { getTopAgentsForTask, recordAgentCallFromConvergenceReceipt, retireAgent } = require("../lib/agent-performance");

module.exports = async function agentPerformanceRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  // GET /api/agent-performance/leaderboard?taskType=coding&topN=3
  if (url.pathname === "/api/agent-performance/leaderboard" && req.method === "GET") {
    try {
      const taskType = url.searchParams.get("taskType") || "default";
      const topN = parseInt(url.searchParams.get("topN") || "3", 10);
      const lookbackDays = parseInt(url.searchParams.get("lookbackDays") || "7", 10);

      const agents = await getTopAgentsForTask(taskType, lookbackDays, topN);
      sendJson(res, { agents, taskType, topN, lookbackDays }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // POST /api/agent-performance/record
  // Called by Convergence IO after each phase completes
  if (url.pathname === "/api/agent-performance/record" && req.method === "POST") {
    try {
      const body = await deps.collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};

      await recordAgentCallFromConvergenceReceipt(
        { step: payload.convergenceStep, stepName: payload.convergenceStepName },
        payload.agentId,
        payload.taskType,
        payload.success,
        payload.latencyMs,
        payload.costUsd || 0
      );

      sendJson(res, { ok: true, recorded: payload.agentId }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // POST /api/agent-performance/retire
  // Mark agent as retired when beaten by newer model
  if (url.pathname === "/api/agent-performance/retire" && req.method === "POST") {
    try {
      const body = await deps.collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};

      await retireAgent(payload.agentId, payload.taskType, payload.reason);
      sendJson(res, { ok: true, retired: payload.agentId }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // GET /api/agent-performance/provider-health
  // Get current provider health status for dashboard
  if (url.pathname === "/api/agent-performance/provider-health" && req.method === "GET") {
    try {
      let providerStatus = {};
      try {
        const providerRouter = require("../lib/provider-router");
        providerStatus = providerRouter.getProviderStatus();
      } catch (err) {
        // Provider router not available, return empty
      }

      // Format for dashboard display
      const providers = {};
      const allProviders = ["anthropic", "openai", "gemini", "ollama", "mistral", "deepseek", "cohere"];

      for (const provider of allProviders) {
        const state = providerStatus[provider] || {};
        providers[provider] = {
          healthy: state.noKey ? false : state.blockedUntil ? false : true,
          noKey: state.noKey || false,
          blocked: state.blockedUntil && Date.now() < state.blockedUntil,
          lastSuccess: state.lastSuccess,
          lastError: state.lastError,
          consecutiveFailures: state.consecutiveFailures || 0,
        };
      }

      sendJson(res, { providers }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  return false;
};
