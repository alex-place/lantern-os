/**
 * Discover route — a small, curated discovery rail for the Explore page.
 *
 *   GET /api/feeds/discover
 *     → { sources:[{name,url}], count, items:[{title,link,source,date}] }
 *
 * Fetches a few on-theme RSS/Atom feeds (AI, local-first, building) server-side,
 * parses them without a dependency, merges + sorts by date, caches ~30 min, and
 * skips any source that fails (per-source resilience). Falls back to a baked set
 * if everything is unreachable, so Explore always renders. Mirrors youtube.js.
 *
 * To curate: edit SOURCES below. Keep it short — this is a taste-maker rail, not
 * a firehose.
 */

const https = require("https");
const http = require("http");

// On-theme defaults. Swap freely — each must expose an RSS or Atom feed.
const SOURCES = [
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/" }, // AI + local-first
  { name: "Hacker News", url: "https://hnrss.org/frontpage?points=150" },        // top tech
  { name: "MIT Tech Review", url: "https://www.technologyreview.com/feed/" },     // AI / research
];

const MAX_PER_SOURCE = 5;
const MAX_TOTAL = 12;
const CACHE_TTL_MS = 30 * 60 * 1000;

const FALLBACK = {
  sources: SOURCES.map((s) => ({ name: s.name, url: s.url })),
  items: [
    { title: "Explore feeds are loading — check back shortly.", link: "/explore.html", source: "Keystone OS", date: null },
  ],
};

let cache = { at: 0, data: null };

function httpGet(target, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error("too many redirects"));
    const lib = target.startsWith("http://") ? http : https;
    const req = lib.get(target, { headers: { "User-Agent": "lantern-os-explore", Accept: "application/rss+xml, application/atom+xml, text/xml, */*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target).href;
        return httpGet(next, depth + 1).then(resolve, reject);
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(7000, () => req.destroy(new Error("timeout")));
  });
}

function decodeEntities(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// Parse both RSS (<item>) and Atom (<entry>); return [{title,link,date}].
function parseFeed(xml) {
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = decodeEntities(tag(b, "title"));
    let link = "";
    if (isAtom) {
      const lm = b.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
      link = lm ? lm[1] : "";
    } else {
      link = decodeEntities(tag(b, "link"));
    }
    const date = decodeEntities(tag(b, isAtom ? "updated" : "pubDate")) || decodeEntities(tag(b, "published"));
    if (title && link) out.push({ title, link, date: date || null });
  }
  return out;
}

async function fetchSource(src) {
  const r = await httpGet(src.url);
  if (r.status !== 200) throw new Error(src.name + " " + r.status);
  return parseFeed(r.body)
    .slice(0, MAX_PER_SOURCE)
    .map((it) => ({ ...it, source: src.name }));
}

function ts(d) {
  if (!d) return 0;
  const t = Date.parse(d);
  return Number.isNaN(t) ? 0 : t;
}

module.exports = async function discoverFeedsRoute(req, res, url, deps) {
  const { sendJson } = deps;
  if (url.pathname !== "/api/feeds/discover" || req.method !== "GET") return false;

  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    sendJson(res, cache.data, 200);
    return true;
  }

  const settled = await Promise.allSettled(SOURCES.map(fetchSource));
  let items = settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value);

  if (items.length) {
    items.sort((a, b) => ts(b.date) - ts(a.date));
    items = items.slice(0, MAX_TOTAL);
  } else {
    items = FALLBACK.items;
  }

  const data = {
    sources: SOURCES.map((s) => ({ name: s.name, url: s.url })),
    count: items.length,
    items,
    fetchedAt: new Date(now).toISOString(),
  };
  cache = { at: now, data };
  sendJson(res, data, 200);
  return true;
};
