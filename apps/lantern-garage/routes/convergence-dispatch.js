/**
 * Convergence Dispatch Route — Token-Efficient Router Integration
 *
 * Integrates ConvergenceRouter into the request pipeline to:
 * - Route 90% of requests locally (no external API calls)
 * - Cache patterns for >70% hit rate
 * - Measure token efficiency metrics
 *
 * Maps to: /api/convergence/* endpoints
 */

const { getRouter } = require("../lib/convergence-router");
const { sendJson } = require("../lib/http-utils");

module.exports = async (req, res, url, deps) => {
  const router = getRouter();
  const pathname = url.pathname;

  // GET /api/convergence/stats — Router statistics
  if (pathname === "/api/convergence/stats" && req.method === "GET") {
    const stats = router.getStats();
    sendJson(res, {
      ...stats,
      description: "Convergence router pattern cache statistics",
      targets: {
        localRoutingPercent: 90,
        cacheHitRatePercent: 70
      }
    }, 200);
    return true;
  }

  // POST /api/convergence/route-intent — Route a message intent
  if (pathname === "/api/convergence/route-intent" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { message, context } = JSON.parse(body);
        if (!message) {
          sendJson(res, { error: "message required" }, 400);
          return;
        }

        const result = await router.routeIntent(message, context);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.cacheHit ? 15 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/route-task — Route a task
  if (pathname === "/api/convergence/route-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { taskType, payload } = JSON.parse(body);
        if (!taskType) {
          sendJson(res, { error: "taskType required" }, 400);
          return;
        }

        const result = await router.routeTask(taskType, payload);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.source === "deterministic_route" ? 20 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/route-market — Route market search
  if (pathname === "/api/convergence/route-market" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { ticker } = JSON.parse(body);
        if (!ticker) {
          sendJson(res, { error: "ticker required" }, 400);
          return;
        }

        const result = await router.routeMarketSearch(ticker);
        sendJson(res, {
          success: true,
          ...result,
          tokensSaved: result.source === "cache" ? 25 : 0
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/convergence/route-code — Route code generation
  if (pathname === "/api/convergence/route-code" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { fileType, scope, keywords } = JSON.parse(body);
        if (!fileType || !scope) {
          sendJson(res, { error: "fileType and scope required" }, 400);
          return;
        }

        const result = await router.routeCodeGeneration(fileType, scope, keywords);
        sendJson(res, {
          success: true,
          ...result
        }, 200);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // GET /api/convergence/health — Health check
  if (pathname === "/api/convergence/health" && req.method === "GET") {
    const stats = router.getStats();
    sendJson(res, {
      status: "ok",
      router: "ConvergenceRouter",
      cacheSize: stats.totalCachedRoutes,
      healthy: stats.totalCachedRoutes > 0
    }, 200);
    return true;
  }

  return false;
};
