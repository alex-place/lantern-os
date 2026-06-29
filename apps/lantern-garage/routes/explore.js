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

const fs = require("fs");
const path = require("path");
const { rankedFeed, pagedFeed, embedCards } = require("../lib/explore-feed");
const { recordModelOutcome } = require("../lib/model-leaderboard");
const { renderThumb } = require("../lib/explore-thumb");

const SUCCESS_EVENTS = new Set(["click", "dwell", "like", "open"]);
// "impression" is the CTR denominator (#1221): a card was actually seen. It is logged
// for metrics but NOT fed to the leaderboard — an impression is not a failure, and
// scoring it as one would tank every surfaced source's rank.
const VALID_EVENTS = new Set([...SUCCESS_EVENTS, "dismiss", "skip", "impression"]);

// Append-only interaction log — the reproducible source for /api/explore/metrics.
const INTERACTION_LOG = path.join(__dirname, "..", "..", "..", "data", "explore", "interactions.jsonl");
function logInteraction(entry) {
  try {
    fs.mkdirSync(path.dirname(INTERACTION_LOG), { recursive: true });
    fs.appendFile(INTERACTION_LOG, JSON.stringify(entry) + "\n", () => {});
  } catch (_e) { /* metrics logging is best-effort, never blocks the response */ }
}

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

  // ── GET /api/explore/embeds ──
  // The raw interactive-embed catalog (games / radio / films) straight from
  // data/explore/embeds.json — the SAME source the feed ranks. Lets dream-chat
  // summon any embed inline by name ("play fallout radio") without a second
  // content list to keep in sync. Static + cheap; no ranking, no pagination.
  if (url.pathname === "/api/explore/embeds" && req.method === "GET") {
    try {
      const embeds = embedCards();
      sendJson(res, { ok: true, embeds, count: embeds.length }, 200);
    } catch (e) {
      sendJson(res, { ok: false, embeds: [], error: e.message }, 200);
    }
    return true;
  }

  // ── GET /api/explore/thumb.svg — generated lead thumbnail ──
  // A themed SVG cover for cards with no natural image (docs, builds, beliefs,
  // image-less reads, local games) and the onerror fallback for external covers,
  // so every card shows a real thumbnail. Params: type, title, source.
  if (url.pathname === "/api/explore/thumb.svg" && req.method === "GET") {
    const svg = renderThumb({
      type: (url.searchParams.get("type") || "").toLowerCase(),
      title: (url.searchParams.get("title") || "").slice(0, 200),
      source: (url.searchParams.get("source") || "").slice(0, 60),
    });
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(svg);
    return true;
  }

  // ── POST /api/explore/feed/page ──
  // Endless-scroll pagination. Body: { seen:[id...], limit?, type? }. Each call
  // re-ranks live (so engagement recorded since the last page steers this one),
  // drops the seen cards, and cycles when the catalog is exhausted (TikTok-style
  // infinite feed). See lib/explore-feed.js pagedFeed().
  if (url.pathname === "/api/explore/feed/page" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await collectRequestBody(req)) || "{}");
    } catch {
      sendJson(res, { cards: [], count: 0, error: "invalid JSON body" }, 200);
      return true;
    }
    const seen = Array.isArray(body.seen) ? body.seen.slice(0, 1000).map(String) : [];
    const type = body.type && body.type !== "all" ? String(body.type) : null;
    try {
      const feed = await pagedFeed({ seen, limit: body.limit, type });
      sendJson(res, feed, 200);
    } catch (e) {
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
    // Always log for CTR; only engagement/dismiss/skip shape the leaderboard.
    logInteraction({ ts: new Date().toISOString(), key, event, success, dwellMs });
    if (event !== "impression") {
      try {
        await recordModelOutcome(key, "explore", success, dwellMs, 0);
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 200);
        return true;
      }
    }
    sendJson(res, { ok: true, key, event, success }, 200);
    return true;
  }

  // ── GET /api/explore/metrics — the dogfood convergence signal (#1221) ──
  // CTR = engagements / impressions, plus exploration share (how widely the feed is
  // sampled) and dismiss rate. Reproducible purely from the interaction log.
  if (url.pathname === "/api/explore/metrics" && req.method === "GET") {
    const windowDays = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days"), 10) || 7));
    const cutoff = Date.now() - windowDays * 86400000;
    let impressions = 0, engagements = 0, dismisses = 0;
    const impressedKeys = new Set(), engagedKeys = new Set();
    try {
      const raw = fs.existsSync(INTERACTION_LOG) ? fs.readFileSync(INTERACTION_LOG, "utf8") : "";
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.ts && Date.parse(e.ts) < cutoff) continue;
        if (e.event === "impression") { impressions++; if (e.key) impressedKeys.add(e.key); }
        else if (e.event === "dismiss" || e.event === "skip") { dismisses++; }
        else if (SUCCESS_EVENTS.has(e.event)) { engagements++; if (e.key) engagedKeys.add(e.key); }
      }
    } catch (_e) { /* fall through to zeros */ }
    const ctr = impressions ? engagements / impressions : 0;
    const explorationShare = impressedKeys.size ? engagedKeys.size / impressedKeys.size : 0;
    const dismissRate = impressions ? dismisses / impressions : 0;
    sendJson(res, {
      ok: true,
      windowDays,
      impressions,
      engagements,
      dismisses,
      uniqueSeen: impressedKeys.size,
      uniqueEngaged: engagedKeys.size,
      ctr: Math.round(ctr * 1000) / 1000,
      explorationShare: Math.round(explorationShare * 1000) / 1000,
      dismissRate: Math.round(dismissRate * 1000) / 1000,
    }, 200);
    return true;
  }

  return false;
};
