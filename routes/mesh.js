/**
 * Mesh Hub Routes — n-user contributor mesh.
 *
 * GET  /api/mesh/members   — registry + presence (online, lastSeen, agents)
 * POST /api/mesh/heartbeat — member machine reports in
 * GET  /api/mesh/status    — compact aggregate for dashboards
 *
 * Joining the mesh is git-native: PR yourself into config/mesh-members.json.
 * There is deliberately no registration endpoint — unknown members are rejected.
 */

const { recordHeartbeat, getMeshStatus } = require("../lib/mesh-hub");

module.exports = async function meshRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  if (url.pathname === "/api/mesh/members" && req.method === "GET") {
    sendJson(res, getMeshStatus(), 200);
    return true;
  }

  if (url.pathname === "/api/mesh/status" && req.method === "GET") {
    const status = getMeshStatus();
    sendJson(res, {
      memberCount: status.memberCount,
      onlineCount: status.onlineCount,
      online: status.members.filter((m) => m.online).map((m) => m.id),
      generatedAt: status.generatedAt,
    }, 200);
    return true;
  }

  if (url.pathname === "/api/mesh/heartbeat" && req.method === "POST") {
    let body = {};
    try {
      body = JSON.parse((await collectRequestBody(req)) || "{}");
    } catch {
      sendJson(res, { ok: false, error: "invalid JSON body" }, 400);
      return true;
    }
    const result = await recordHeartbeat(body);
    if (!result.ok) {
      sendJson(res, result, 400);
      return true;
    }
    sendJson(res, { ok: true, heartbeat: result.heartbeat, mesh: getMeshStatus() }, 200);
    return true;
  }

  return false;
};
