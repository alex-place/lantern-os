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

// Flatten feed HTML (often entity-encoded, e.g. "&lt;p&gt;…") into clean text.
// decodeEntities() strips real tags BEFORE decoding entities, so encoded markup
// survives it — here we decode angle-brackets FIRST, then strip, so excerpts are
// prose, not "<blockquote cite=…>".
function htmlToText(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, " ")
    .trim();
}

// Trim a plain-text excerpt to a clean length (word-boundary, ellipsis).
function clip(s, n) {
  s = (s || "").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

// Best-effort lead image: media:thumbnail/content, an image enclosure, or the
// first <img> inside the content. Returns "" when the feed carries no image —
// the card simply renders text-only, never a broken thumbnail.
function firstImage(block) {
  let m =
    block.match(/<media:(?:thumbnail|content)[^>]*\burl="([^"]+)"/i) ||
    block.match(/<enclosure[^>]*\burl="([^"]+)"[^>]*\btype="image\//i) ||
    block.match(/<enclosure[^>]*\btype="image\/[^"]*"[^>]*\burl="([^"]+)"/i) ||
    block.match(/<img[^>]*\bsrc="([^"]+)"/i);
  const u = m ? m[1] : "";
  return /^https?:\/\//i.test(u) ? u : "";
}

// Parse both RSS (<item>) and Atom (<entry>); return
// [{title,link,date,summary,image}]. summary+image enrich the feed card so it
// reads as a real preview, not just a headline.
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
    const rawSummary = isAtom
      ? tag(b, "summary") || tag(b, "content")
      : tag(b, "description") || tag(b, "content:encoded");
    let summaryText = htmlToText(rawSummary);
    // HN's RSS "description" is link metadata ("Article URL: … Comments URL: …"),
    // not prose — drop it rather than show a noisy excerpt.
    if (/Comments URL:|Article URL:/i.test(summaryText)) summaryText = "";
    const summary = clip(summaryText, 200);
    const image = firstImage(b);
    if (title && link) out.push({ title, link, date: date || null, summary, image });
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

// Producer: cache-aware fetch of the discover rail data. Reused by the route
// below AND by the Explore feed aggregator (lib/explore-feed.js), so the single
// pane and the legacy rail draw from one cache.
async function load() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;

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
  return data;
}

module.exports = async function discoverFeedsRoute(req, res, url, deps) {
  const { sendJson } = deps;
  if (url.pathname !== "/api/feeds/discover" || req.method !== "GET") return false;
  sendJson(res, await load(), 200);
  return true;
};

module.exports.load = load;
// Exported for unit tests (pure, network-free): feed parsing + excerpt/image extraction.
module.exports.parseFeed = parseFeed;
module.exports.htmlToText = htmlToText;
module.exports.clip = clip;
module.exports.firstImage = firstImage;
