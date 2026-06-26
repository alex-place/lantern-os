/**
 * Explore feed route — the single ranked content pane.
 *
 *   GET  /api/explore/feed         → { cards:[...], count, generatedAt }
 *       PCSF-ranked merged feed (lib/explore-feed.js). Cold start = editorial
 *       order from data/pcsf/explore.pcsf.json, then freshness.
 *
 *   POST /api/explore/interaction  → { ok:true }
 *       body: { key, event:"click"|"dwell"|"dismiss"|"like", dwellMs? }
 *       Records the outcome on the SAME leaderboard the feed ranks by:
 *       click/dwell/like = success, dismiss = failure, dwellMs = latency.
 *       No new store — recordModelOutcome appends to the agent-performance log.
 *
 * Plain handler per the routes convention: (req,res,url,deps)=>bool. Design:
 * docs/research/explore-content-machine.md §8.
 */

const { rankedFeed } = require("../lib/explore-feed");
const { recordModelOutcome } = require("../lib/model-leaderboard");

const SUCCESS_EVENTS = new Set(["click", "dwell", "like", "open"]);
const VALID_EVENTS = new Set([...SUCCESS_EVENTS, "dismiss", "skip"]);

module.exports = async function exploreRoute(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;

  // ── GET /api/explore/feed ──
  if (url.pathname === "/api/explore/feed" && req.method === "GET") {
    try {
      const feed = await rankedFeed();
      sendJson(res, feed, 200);
    } catch (e) {
      // Never blank the page — surface the error but keep a stable shape.
      sendJson(res, { cards: [], count: 0, error: e.message }, 200);
    }
    return true;
  }

  // ── POST /api/explore/interaction ──
  if (url.pathname === "/api/explore/interaction" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await collectRequestBody(req)) || "{}");
    } catch {
      sendJson(res, { ok: false, error: "invalid JSON body" }, 400);
      return true;
    }
    const key = String(body.key || body.cardKey || "").trim();
    const event = String(body.event || "").trim().toLowerCase();
    if (!key || !key.startsWith("source:")) {
      sendJson(res, { ok: false, error: "key required (source:<name>)" }, 400);
      return true;
    }
    if (!VALID_EVENTS.has(event)) {
      sendJson(res, { ok: false, error: "event must be one of " + [...VALID_EVENTS].join(", ") }, 400);
      return true;
    }
    const success = SUCCESS_EVENTS.has(event);
    const dwellMs = Number.isFinite(+body.dwellMs) ? Math.max(0, +body.dwellMs) : 0;
    try {
      await recordModelOutcome(key, "explore", success, dwellMs, 0);
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 200);
      return true;
    }
    sendJson(res, { ok: true, key, event, success }, 200);
    return true;
  }

  return false;
};
