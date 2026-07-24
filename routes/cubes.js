// Cube Network API — private, shared, and ally cube endpoints.
module.exports = async function cubeRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;
  const {
    loadManifest,
    appendPrivateCubeDelta,
    readPrivateCubeSummary,
    appendSharedCubeClaim,
    readSharedCubeSummary,
    readSharedCubeClaims,
    listAllies,
    addAlly,
  } = require("../lib/cube-store");
  const {
    canExportClaim,
    loadPacket,
    approvePacket,
  } = require("../lib/consent-gate");

  // ── GET /api/cubes/local ── Alex private cube summary
  if (url.pathname === "/api/cubes/local" && req.method === "GET") {
    const summary = readPrivateCubeSummary(repoRoot, "cube:alex.private");
    sendJson(res, summary);
    return true;
  }

  // ── GET /api/cubes/shared ── shared world cube summary
  if (url.pathname === "/api/cubes/shared" && req.method === "GET") {
    const summary = readSharedCubeSummary(repoRoot, "cube:shared.world");
    sendJson(res, summary);
    return true;
  }

  // ── GET /api/cubes/allies ── list ally nodes
  if (url.pathname === "/api/cubes/allies" && req.method === "GET") {
    sendJson(res, { allies: listAllies(repoRoot) });
    return true;
  }

  // ── POST /api/cubes/alex/delta ── write private cube event
  if (url.pathname === "/api/cubes/alex/delta" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      const record = await appendPrivateCubeDelta(repoRoot, "cube:alex.private", body);
      sendJson(res, { saved: true, delta: record });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // ── POST /api/cubes/shared/claim ── submit claim into shared cube
  if (url.pathname === "/api/cubes/shared/claim" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.packet_id) {
        sendJson(res, { error: "packet_id is required" }, 400);
        return true;
      }

      const packet = loadPacket(repoRoot, body.packet_id);
      if (!packet) {
        sendJson(res, { error: "packet_not_found" }, 404);
        return true;
      }

      if (!canExportClaim(packet)) {
        sendJson(res, { error: "packet_not_exportable", status: packet.review?.consent_gate_status }, 403);
        return true;
      }

      await appendSharedCubeClaim(repoRoot, "cube:shared.world", packet);
      sendJson(res, { saved: true, packet_id: packet.packet_id, cube: "cube:shared.world" });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // ── GET /api/cubes/shared/claims ── list claims in shared cube
  if (url.pathname === "/api/cubes/shared/claims" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const claims = readSharedCubeClaims(repoRoot, "cube:shared.world", limit);
    sendJson(res, { cube: "cube:shared.world", count: claims.length, claims });
    return true;
  }

  // ── POST /api/allies/invite ── invite an ally
  if (url.pathname === "/api/allies/invite" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      if (!body.display_name) {
        sendJson(res, { error: "display_name is required" }, 400);
        return true;
      }
      await addAlly(repoRoot, body);
      sendJson(res, { invited: true, display_name: body.display_name });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  return false;
};
