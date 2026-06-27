/**
 * Grounding routes — the mesh grounding resolver, wired to real sources.
 *
 *   GET  /api/grounding/resolve?q=…[&mesh=self][&web=0]
 *        Runs resolveGrounding() over the real rings (local memory → knowledge center →
 *        mesh peers → web) and returns the decision: an answer-grounding block with cited
 *        sources, or an honest "I don't know". `&mesh=self` adds this node as a peer over
 *        real HTTP (a federation self-loop) so the mesh ring is demonstrable with no second
 *        machine. The browser/preview-testable surface.
 *
 *   POST /api/mesh/ground   body: { query, k? }  → { evidence:[{claim,evidence,confidence}] }
 *        The federation PRIMITIVE: serve THIS node's local evidence to a peer mirror.
 *        Read-only, and DATA-not-agency — it returns grounded records, NEVER an answer or an
 *        instruction, and never re-federates (local rings only, no mesh recursion).
 *
 * Plain handler per the routes convention: (req,res,url,deps)=>bool.
 * Engine: lib/mesh-grounding.js · ring adapters: lib/grounding-rings.js.
 */

const { resolveGrounding, formatGroundingForPrompt } = require("../lib/mesh-grounding");
const { defaultRings, localServeRings } = require("../lib/grounding-rings");

module.exports = async function groundingRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  // Safe-by-default: the whole surface is OFF unless explicitly enabled. It can return this
  // node's local memory/KC evidence, so it must not be exposed implicitly. (#mesh-grounding)
  if (process.env.MESH_GROUNDING !== "1") return false;

  // ── POST /api/mesh/ground — federation primitive (serve local evidence) ──
  if (url.pathname === "/api/mesh/ground" && req.method === "POST") {
    // Shared-secret gate for peer serving: when MESH_GROUND_SECRET is set, a peer must
    // present it. Without it set, the endpoint stays loopback-only (self-loop demo) — a
    // public deployment MUST set the secret before federating, or it leaks local evidence.
    const secret = process.env.MESH_GROUND_SECRET;
    if (secret && req.headers["x-mesh-secret"] !== secret) {
      sendJson(res, { error: "forbidden" }, 403);
      return true;
    }
    let body = {};
    try {
      body = JSON.parse((await collectRequestBody(req)) || "{}");
    } catch {
      sendJson(res, { error: "invalid JSON body" }, 400);
      return true;
    }
    const query = String(body.query || "").slice(0, 2000).trim();
    const k = Math.min(20, Math.max(1, Number(body.k) || 5));
    if (!query) {
      sendJson(res, { evidence: [] }, 200);
      return true;
    }
    // Local rings only; threshold 0 + no short-circuit so we return all local evidence and
    // let the ASKING node decide relevance. Never include the mesh ring (no recursion).
    const result = await resolveGrounding(query, {
      rings: localServeRings(),
      threshold: 0,
      stopConfidence: 1.1,
      k,
    });
    sendJson(
      res,
      {
        evidence: result.evidence.map((e) => ({
          claim: e.claim,
          evidence: Array.isArray(e.evidence) ? e.evidence.join("; ") : e.evidence || "",
          confidence: e.confidence,
        })),
      },
      200
    );
    return true;
  }

  // ── GET /api/grounding/resolve — full ring resolution + the model's prompt block ──
  if (url.pathname === "/api/grounding/resolve" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      sendJson(res, { error: "q (question) is required" }, 400);
      return true;
    }
    const includeWeb = url.searchParams.get("web") !== "0";
    // Demonstrate the mesh ring with a real HTTP self-loop when ?mesh=self is passed. There
    // are no live peer-backend mirrors yet, so multi-peer federation stays inert until a peer
    // registry + transport is decided (ADR) — this proves the transport works meanwhile.
    let peers = [];
    if (url.searchParams.get("mesh") === "self" && req.headers.host) {
      peers = [{ id: "self", url: `http://${req.headers.host}/api/mesh/ground` }];
    }
    const result = await resolveGrounding(q, {
      rings: defaultRings({ peers, web: includeWeb }),
    });
    sendJson(res, { ...result, prompt: formatGroundingForPrompt(result) }, 200);
    return true;
  }

  return false;
};
