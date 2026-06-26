// Human Flourishing Frameworks — direct Node.js integration
// Serves the HFF dashboard and reads world-model snapshots from local JSON files.
// The Python world_model can write a snapshot to integrations/hff/data/snapshot.json;
// if absent, the API returns an empty-but-valid structure so the dashboard degrades
// gracefully instead of crashing.

const path = require("path");
const fs = require("fs");
const https = require("https");
const feeds = require("../lib/flourishing-feeds");

// ── Live world-news feed (RSS, no API keys) ──
const NEWS_FEEDS = [
  { source: "UN News", topic: "humanity", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml" },
  { source: "WHO", topic: "health", url: "https://www.who.int/rss-feeds/news-english.xml" },
  { source: "Mongabay", topic: "ecosystems", url: "https://news.mongabay.com/feed/" },
  { source: "Our World in Data", topic: "data", url: "https://ourworldindata.org/atom.xml" },
];
const NEWS_CACHE_MS = 10 * 60 * 1000;
let newsCache = { at: 0, items: [] };

function fetchFeed(feed) {
  return new Promise((resolve) => {
    const req = https.get(feed.url, { headers: { "User-Agent": "LanternOS-Flourishing/1.0" } }, (resp) => {
      // Follow one redirect hop if present
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        https.get(resp.headers.location, { headers: { "User-Agent": "LanternOS-Flourishing/1.0" } }, (r2) => {
          let body = "";
          r2.on("data", (c) => (body += c));
          r2.on("end", () => resolve(parseFeed(body, feed)));
        }).on("error", () => resolve([]));
        return;
      }
      let body = "";
      resp.on("data", (c) => (body += c));
      resp.on("end", () => resolve(parseFeed(body, feed)));
    });
    req.on("error", () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
  });
}

function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) || [];
  for (const block of blocks.slice(0, 6)) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "";
    let link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] ||
               (block.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || "";
    const date = (block.match(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published)>/) || [])[1] || "";
    const clean = (s) => s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
      .trim();
    if (clean(title) && clean(link)) {
      items.push({ source: feed.source, topic: feed.topic, title: clean(title), link: clean(link), published: clean(date) });
    }
  }
  return items;
}

async function getWorldNews() {
  if (Date.now() - newsCache.at < NEWS_CACHE_MS && newsCache.items.length) return newsCache;
  const results = await Promise.all(NEWS_FEEDS.map(fetchFeed));
  const items = results.flat();
  if (items.length) newsCache = { at: Date.now(), items };
  return newsCache.items.length ? newsCache : { at: Date.now(), items: [] };
}

const HFF_DATA_DIR = path.resolve(__dirname, "../../../integrations/human-flourishing-frameworks/data");
const SNAPSHOT_PATH = path.join(HFF_DATA_DIR, "snapshot.json");
const WORLD_DB_PATH = path.join(HFF_DATA_DIR, "world_model.db");

function readSnapshot() {
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")); } catch (_) {}
  }
  return null;
}

function emptyWorldStatus() {
  return {
    ok: true, source: "local", mode: "direct",
    belief_count: 0, sensor_count: 0, flourishing: null,
    db_exists: fs.existsSync(WORLD_DB_PATH),
    snapshot_exists: fs.existsSync(SNAPSHOT_PATH),
    message: "HFF world model not yet seeded — run integrations/human-flourishing-frameworks/seed_data.py to populate.",
  };
}

module.exports = async function flourishingRoutes(req, res, url, deps) {
  const { sendJson, sendFile, publicRoot } = deps;

  // Dashboard page
  if (url.pathname === "/flourishing" || url.pathname === "/flourishing/") {
    sendFile(res, path.resolve(publicRoot, "flourishing.html"));
    return true;
  }

  if (!url.pathname.startsWith("/api/flourishing/")) return false;

  const snap = readSnapshot();

  if (url.pathname === "/api/flourishing/world/status") {
    if (snap?.world) {
      sendJson(res, { ok: true, source: "snapshot", mode: "direct", ...snap.world });
    } else {
      sendJson(res, emptyWorldStatus());
    }
    return true;
  }

  if (url.pathname === "/api/flourishing/world/flourishing") {
    sendJson(res, { ok: true, source: snap ? "snapshot" : "empty", by_scope: snap?.flourishing?.by_scope ?? {} });
    return true;
  }

  if (url.pathname === "/api/flourishing/world/beliefs") {
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    sendJson(res, { ok: true, source: snap ? "snapshot" : "empty", beliefs: (snap?.beliefs ?? []).slice(0, limit) });
    return true;
  }

  if (url.pathname === "/api/flourishing/violations") {
    sendJson(res, { ok: true, source: snap ? "snapshot" : "empty", violations: snap?.violations ?? [], count: (snap?.violations ?? []).length });
    return true;
  }

  if (url.pathname === "/api/flourishing/autonomous/status") {
    sendJson(res, { ok: true, source: snap ? "snapshot" : "empty", agents: snap?.agents ?? [], escalation_queue: 0, rules: snap?.immutable_rules ?? 0 });
    return true;
  }

  if (url.pathname === "/api/flourishing/news") {
    const news = await getWorldNews();
    sendJson(res, { ok: true, updated_at: new Date(news.at).toISOString(), items: news.items });
    return true;
  }

  if (url.pathname === "/api/flourishing/adoption/stats") {
    sendJson(res, { ok: true, source: snap ? "snapshot" : "empty", ...(snap?.adoption ?? { verified_nodes: 0, active_nodes: 0, total_nodes: 0 }) });
    return true;
  }

  // ── Live grounding from real yearly feeds (World Bank world aggregates) ──
  // The beliefs here are GROUNDED, not seeded: each carries a posterior, an
  // uncertainty, a source URL, and the data year. The Question Machine ranks
  // which belief to ground next (uncertainty × leverage). `?refresh=1` bypasses
  // the 24h cache (the data is annual, so polling more often is pointless).
  if (url.pathname === "/api/flourishing/feeds" || url.pathname === "/api/flourishing/panel") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const p = await feeds.panel(force);
      sendJson(res, p);
    } catch (e) {
      sendJson(res, { ok: false, error: String(e && e.message || e), domains: [], questions: [], beliefs: [] });
    }
    return true;
  }

  // ── Cross-domain correlations — REAL patterns, not "this fraction isn't 0.5".
  // Pearson-correlates flourishing-relevant indicator pairs ACROSS ~200 real
  // countries (aggregates filtered). Replaces the source dashboard's trivial outliers.
  if (url.pathname === "/api/flourishing/correlations") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const items = await feeds.correlations(force);
      sendJson(res, { ok: items.length > 0, count: items.length, correlations: items,
        note: "Pearson r across real countries (World Bank, most-recent year). Correlation, not causation." });
    } catch (e) {
      sendJson(res, { ok: false, error: String(e && e.message || e), correlations: [] });
    }
    return true;
  }

  return false;
};
