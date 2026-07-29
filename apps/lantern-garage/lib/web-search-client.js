// Web Search Client — calls MCP web_search tool for real-time grounding
// Uses DuckDuckGo lite via local MCP server (no API key required)

const http = require("http");

const MCP_HOST = process.env.MCP_SERVER_HOST || "127.0.0.1";
const MCP_PORT = parseInt(process.env.MCP_SERVER_PORT || "8771", 10);
const MCP_TIMEOUT = parseInt(process.env.MCP_CLIENT_TIMEOUT || "8000", 10);

/**
 * Call the MCP web_search tool.
 * @param {string} query - Search query
 * @param {number} maxResults - Max results (default 5)
 * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
 */
async function webSearchMcp(query, maxResults = 5, timeoutMs = MCP_TIMEOUT) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { query, max_results: maxResults },
      },
    });

    const req = http.request(
      {
        hostname: MCP_HOST,
        port: MCP_PORT,
        path: "/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.result) {
              resolve(parsed.result);
            } else if (parsed.error) {
              resolve({ success: false, error: parsed.error.message || String(parsed.error) });
            } else {
              resolve({ success: false, error: "Unexpected MCP response" });
            }
          } catch (e) {
            resolve({ success: false, error: `Parse error: ${e.message}` });
          }
        });
      }
    );

    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "Timeout" }); });
    req.write(payload);
    req.end();
  });
}

/**
 * Format web search results into a grounding context string for prompts.
 * @param {Array} results - Search results from webSearchMcp
 * @param {string} query - Original query
 * @returns {string}
 */
function formatGroundingContext(results, query) {
  if (!results || results.length === 0) {
    return "";
  }
  const lines = [
    `--- Web Search Grounding (query: "${query}") ---`,
    "Use the following real-time search results to ground your response. Do not hallucinate beyond what is supported.",
    "",
  ];
  results.slice(0, 5).forEach((r, i) => {
    // News results carry no `rank` (they come from the RSS feed) — fall back to the
    // list position so the citation index is never "[undefined]".
    lines.push(`[${r.rank != null ? r.rank : i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.published) lines.push(`    Published: ${r.published}`);
    if (r.snippet) lines.push(`    Snippet: ${r.snippet}`);
    lines.push("");
  });
  lines.push("--- End grounding ---");
  return lines.join("\n");
}

/**
 * Detect if a message likely needs web search grounding.
 * Simple heuristic: factual questions, current events, "what is", "how to", etc.
 * @param {string} message
 * @returns {boolean}
 */
function needsGrounding(message) {
  const lower = String(message || "").toLowerCase();
  // Skip if it's a personal reflection, greeting, or command
  const skipPatterns = [
    /^!\w+/,                     // bang commands
    /^(hi|hello|hey|yo)\b/,      // greetings
    /^(i feel|i think|i had|i dreamt|i dreamed|today i|yesterday i)\b/, // personal
    /^(thank|thanks|ok|okay|bye|goodbye)\b/, // social
  ];
  for (const p of skipPatterns) {
    if (p.test(lower)) return false;
  }
  // Factual patterns that benefit from grounding
  const needsPatterns = [
    /\b(what is|who is|where is|when is|how to|why does|what are|who are|where are)\b/,
    /\b(news|current|latest|recent|today|this week|this month|202[4-9]|2025)\b/,
    /\b(define|explain|compare|difference between)\b/,
    /\?(\s|$)/,                   // ends with question mark
    /\b(weather|stock|price|cost|rate|score|status of)\b/,
    // #2193 — sports / stats / entity-lookup domains. A bare lookup like "Brandon Singer
    // PGA" or "LeBron James stats" carries no question word, so it fell through and the
    // model answered from memory (hedging or asking the user to clarify) instead of
    // searching. These domain words are strong "go look this up" signals: player/team
    // stats, rankings, schedules, and rosters are exactly the current-facts the model
    // should not improvise. (Kept domain-specific so ordinary prose isn't over-grounded.)
    /\b(pga|lpga|nba|wnba|nfl|mlb|nhl|mls|atp|wta|fifa|uefa|ncaa|f1|formula 1|olympics?|premier league|la liga)\b/,
    /\b(stats|statistics|standings?|rankings?|leaderboard|roster|lineup|schedule|scores?|box score|batting|scoring average|handicap|world ranking)\b/,
  ];
  return needsPatterns.some((p) => p.test(lower));
}

/**
 * Extract a concise search query from a user's message.
 * @param {string} message
 * @returns {string|null}
 */
function extractSearchQuery(message) {
  const lower = String(message || "").toLowerCase();
  // Remove personal prefixes
  let query = message
    .replace(/^\s*\!?\s*(?:search|lookup|find|google)\s+(for\s+)?/i, "")
    .replace(/\b(in\s+lantern\s+os|in\s+the\s+journal)\b/gi, "")
    .trim();
  if (query.length < 3) return null;
  // If it's a question, use the whole thing; otherwise just the first sentence
  if (lower.includes("?")) {
    return query.split("?")[0] + "?";
  }
  return query.split(/[.!?]/)[0].trim();
}

// Minimal HTML-entity decode for titles/snippets pulled from DDG HTML.
function _decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ");
}
// Strip markup from a snippet. ORDER MATTERS: decode entities FIRST, then remove tags.
// This used to strip-then-decode, which silently failed on any feed that entity-encodes its
// HTML (Google News encodes descriptions as `&lt;a href=…&gt;`): the tag regex saw no literal
// `<`, removed nothing, and the decode step then RE-CREATED live markup. Snippets reached the
// model as ~400 chars of `<a href="…base64…">` + `<font>` noise wrapping a headline it already
// had in `title` — i.e. almost no usable content, which is how a grounded search turn still
// produced a vague, made-up answer. Decoding first means encoded and literal markup both get
// stripped; the trailing decode handles ordinary text entities (&amp;, &#39;) left behind.
function _stripTags(s) {
  const decoded = _decodeEntities(String(s || ""));
  return _decodeEntities(decoded.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Wikimedia/DDG-friendly User-Agent. Wikimedia's User-Agent policy
// (https://meta.wikimedia.org/wiki/User-Agent_policy) requires a descriptive
// agent string with a means of contact; a generic UA gets rate-limited or blocked
// more aggressively.
const GROUNDING_UA = "KeystoneOS-grounding/1.0 (+https://lantern-os.net; founder@lantern-os.net)";

// Guard a keyless fallback response: returns a clean, honest error string for any
// non-2xx status (so a 429 rate-limit body like "You are making too many requests…"
// is reported as such instead of crashing JSON.parse with a cryptic "Unexpected
// token" — #web-search-429). Returns null when the response is OK to parse.
function _httpFallbackError(source, res, body) {
  const code = res.statusCode || 0;
  if (code >= 200 && code < 300) return null;
  if (code === 429) {
    const retry = res.headers && res.headers["retry-after"];
    return `${source} rate-limited (HTTP 429${retry ? `, retry-after ${retry}s` : ""})`;
  }
  const snippet = String(body || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${source} HTTP ${code}${snippet ? ` — ${snippet}` : ""}`;
}

const DIRECT_TIMEOUT = parseInt(process.env.WEB_SEARCH_DIRECT_TIMEOUT || "6000", 10);

/**
 * Keyless fallback search: hit DuckDuckGo's Instant Answer API directly (no MCP,
 * no key). Used when the MCP search path is slow/down (#1212). The DDG HTML
 * endpoint now serves a bot-challenge page (HTTP 202, no results), so we use the
 * JSON API, which returns a topic Abstract + RelatedTopics reliably. Best for
 * entity/factual queries; returns no results (honest failure) for queries with no
 * instant answer, rather than fabricating.
 * @returns {Promise<{success: boolean, results?: Array, error?: string, source: string}>}
 */
async function webSearchDirect(query, maxResults = 5, timeoutMs = DIRECT_TIMEOUT) {
  const https = require("https");
  return new Promise((resolve) => {
    const q = encodeURIComponent(query);
    const path = `/?q=${q}&format=json&no_html=1&no_redirect=1&skip_disambig=1&t=keystone`;
    const req = https.request(
      {
        hostname: "api.duckduckgo.com",
        path,
        method: "GET",
        headers: { "User-Agent": GROUNDING_UA, "Accept": "application/json" },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; if (data.length > 800000) req.destroy(); });
        res.on("end", () => {
          const httpErr = _httpFallbackError("direct", res, data);
          if (httpErr) { resolve({ success: false, error: httpErr, source: "direct" }); return; }
          try {
            const j = JSON.parse(data);
            const results = [];
            const seen = new Set();
            // DuckDuckGo returns an image and a named source alongside the text, but both
            // were being dropped — so a result the model could have illustrated and
            // attributed arrived as bare text. Image paths come back site-relative
            // ("/i/xxx.png"); make them absolute so the URL is actually usable.
            const absImg = (u) => {
              const s = String(u || "").trim();
              if (!s) return null;
              if (/^https?:\/\//i.test(s)) return s;
              return "https://duckduckgo.com" + (s.startsWith("/") ? s : "/" + s);
            };
            const push = (title, url, snippet, extra = {}) => {
              title = _stripTags(title); url = String(url || "").trim();
              if (!url || seen.has(url) || results.length >= maxResults) return;
              seen.add(url);
              const row = { title: title || url, url, snippet: _stripTags(snippet || title) };
              if (extra.image) row.image = extra.image;
              if (extra.publisher) row.publisher = _stripTags(extra.publisher);
              results.push(row);
            };
            // 1) Topic abstract (e.g. the Wikipedia summary) — the strongest single result.
            if (j.AbstractText && j.AbstractURL) {
              push(j.Heading || j.AbstractSource || j.AbstractText, j.AbstractURL, j.AbstractText,
                { image: absImg(j.Image), publisher: j.AbstractSource });
            }
            // 2) Direct external results (rare but high quality).
            for (const r of (j.Results || [])) push(r.Text, r.FirstURL, r.Text, { image: absImg(r.Icon && r.Icon.URL) });
            // 3) Related topics — flatten one level of grouping.
            const flat = [];
            for (const t of (j.RelatedTopics || [])) {
              if (t && Array.isArray(t.Topics)) flat.push(...t.Topics);
              else if (t) flat.push(t);
            }
            for (const t of flat) if (t.FirstURL && t.Text) push(t.Text.split(" - ")[0], t.FirstURL, t.Text, { image: absImg(t.Icon && t.Icon.URL) });
            if (!results.length) { resolve({ success: false, error: "no instant-answer results (direct)", source: "direct" }); return; }
            resolve({ success: true, results, source: "direct" });
          } catch (e) {
            const snippet = String(data || "").replace(/\s+/g, " ").trim().slice(0, 80);
            resolve({ success: false, error: `direct non-JSON response${snippet ? ` — ${snippet}` : ""}`, source: "direct" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ success: false, error: `direct: ${err.message}`, source: "direct" }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "direct timeout", source: "direct" }); });
    req.end();
  });
}

/**
 * Keyless fallback #2: Wikipedia search API (no key, returns HTTP 200 JSON with
 * real results for natural-language factual queries — where the DDG Instant Answer
 * API returns nothing). Used after MCP and DDG both fail (#1212).
 */
async function webSearchWiki(query, maxResults = 5, timeoutMs = DIRECT_TIMEOUT) {
  const https = require("https");
  return new Promise((resolve) => {
    const q = encodeURIComponent(query);
    const path = `/w/api.php?action=query&list=search&srsearch=${q}&srlimit=${Math.min(10, maxResults)}&format=json`;
    const req = https.request(
      {
        hostname: "en.wikipedia.org",
        path,
        method: "GET",
        headers: { "User-Agent": GROUNDING_UA, "Accept": "application/json" },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; if (data.length > 800000) req.destroy(); });
        res.on("end", () => {
          const httpErr = _httpFallbackError("wiki", res, data);
          if (httpErr) { resolve({ success: false, error: httpErr, source: "wiki" }); return; }
          try {
            const j = JSON.parse(data);
            const hits = (j.query && j.query.search) || [];
            const results = hits.slice(0, maxResults).map((h) => ({
              title: h.title,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, "_"))}`,
              snippet: _stripTags(h.snippet),
            }));
            if (!results.length) { resolve({ success: false, error: "no results (wiki)", source: "wiki" }); return; }
            resolve({ success: true, results, source: "wiki" });
          } catch (e) {
            const snippet = String(data || "").replace(/\s+/g, " ").trim().slice(0, 80);
            resolve({ success: false, error: `wiki non-JSON response${snippet ? ` — ${snippet}` : ""}`, source: "wiki" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ success: false, error: `wiki: ${err.message}`, source: "wiki" }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "wiki timeout", source: "wiki" }); });
    req.end();
  });
}

// #2276 — current-events / geopolitical / "latest news" queries were answered with
// historical, encyclopedic Wikipedia pages, because every source in the chain (DDG
// instant-answer, then the Wikipedia API fallback) returns reference content, not
// dated news. A "recent geopolitical news strait of hormuz oil prices" turn wants
// timely articles, not the Strait of Hormuz Wikipedia article.
//
// This is a FRESHNESS-first source: Google News' keyless RSS search endpoint returns
// recent, dated articles for an arbitrary query. It is tried BEFORE the encyclopedic
// sources for news-intent queries (see _webSearchUncached), so current-events turns
// ground on real news instead of reference pages — and it fails gracefully (no key,
// bounded timeout, honest empty result) so a blip just falls through to the old chain.
async function webSearchNews(query, maxResults = 5, timeoutMs = DIRECT_TIMEOUT) {
  const https = require("https");
  return new Promise((resolve) => {
    const q = encodeURIComponent(query);
    const path = `/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const req = https.request(
      {
        hostname: "news.google.com",
        path,
        method: "GET",
        headers: { "User-Agent": GROUNDING_UA, "Accept": "application/rss+xml, application/xml, text/xml" },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; if (data.length > 1600000) req.destroy(); });
        res.on("end", () => {
          const httpErr = _httpFallbackError("news", res, data);
          if (httpErr) { resolve({ success: false, error: httpErr, source: "news" }); return; }
          try {
            const results = _parseNewsRss(data, maxResults);
            if (!results.length) { resolve({ success: false, error: "no results (news)", source: "news" }); return; }
            resolve({ success: true, results, source: "news" });
          } catch (e) {
            resolve({ success: false, error: `news parse: ${e.message}`, source: "news" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ success: false, error: `news: ${err.message}`, source: "news" }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "news timeout", source: "news" }); });
    req.end();
  });
}

// Dependency-free RSS parse for the Google News feed. Each <item> carries a title
// ("Headline - Source"), a link, a pubDate, and a <source> — we surface the pubDate +
// source in the snippet so the model can SEE the article is recent and cite it.
const _NEWS_ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
function _rssPick(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}
function _cdata(s) {
  return String(s || "").replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}
function _parseNewsRss(xml, maxResults = 5) {
  const results = [];
  const seen = new Set();
  let m;
  _NEWS_ITEM_RE.lastIndex = 0;
  while ((m = _NEWS_ITEM_RE.exec(xml)) && results.length < maxResults) {
    const block = m[1];
    const title = _stripTags(_cdata(_rssPick(block, "title")));
    const url = _decodeEntities(_cdata(_rssPick(block, "link"))).trim();
    const pubDate = _stripTags(_cdata(_rssPick(block, "pubDate")));
    const source = _stripTags(_cdata(_rssPick(block, "source")));
    const desc = _stripTags(_cdata(_rssPick(block, "description")));
    // Google News' <link> is an opaque base64 redirect (news.google.com/rss/articles/CBMi…),
    // so the model has no real domain to cite — it ends up saying "per USA Today" with no
    // usable link. The publisher's actual site IS available as the <source> url attribute.
    const publisherUrl = _decodeEntities(((block.match(/<source\b[^>]*\burl\s*=\s*"([^"]+)"/i) || [])[1] || "")).trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const meta = [pubDate, source].filter(Boolean).join(" · ");
    // Google News' <description> is just the headline (+ source) again, so once the markup
    // is stripped it merely repeats `title`. Drop it when it adds nothing, rather than
    // spending the model's context on the same sentence twice.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const descAddsInfo = desc && !norm(title).includes(norm(desc)) && !norm(desc).includes(norm(title));
    const snippet = [meta, descAddsInfo ? desc : ""].filter(Boolean).join(" — ") || title;
    results.push({
      title: title || url, url, snippet,
      published: pubDate || null,
      source: source || null,
      publisher: source || null,
      publisherUrl: publisherUrl || null,
    });
  }
  return results;
}

// ── og:image enrichment for news results ─────────────────────────────────────
// Google News' RSS carries no media:/enclosure element, so news results have no image of
// their own — the article page does, in its og:image meta tag. Fetching it costs one extra
// request per result, so this is deliberately bounded: only the top few results, in
// parallel, with a short timeout, and the connection is dropped as soon as </head> is seen
// (og:image lives in the head — no reason to download a whole article page). Entirely
// best-effort: any failure just means that result has no image, never a failed search.
// Tune with SEARCH_OG_IMAGE_LIMIT (0 disables).
const OG_IMAGE_LIMIT = () => {
  const v = Number(process.env.SEARCH_OG_IMAGE_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : 3;
};
const OG_FETCH_TIMEOUT_MS = 2500;
const OG_MAX_BYTES = 96 * 1024;

// Never let a search result URL point the fetcher at the local network (SSRF): these URLs
// come from an external feed, so treat them as untrusted input.
function _isPrivateHostname(h) {
  const host = String(h || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function _fetchOgImage(url, redirectsLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return resolve(null);
    if (_isPrivateHostname(u.hostname)) return resolve(null);
    // One-shot settle: several paths (end / close / our own destroy / timeout) can fire.
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    let finish = () => settle(null);   // replaced once a 200 response starts streaming
    const mod = u.protocol === "https:" ? require("https") : require("http");
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: (u.pathname || "/") + (u.search || ""),
        method: "GET",
        headers: { "User-Agent": GROUNDING_UA, "Accept": "text/html,application/xhtml+xml" },
        timeout: OG_FETCH_TIMEOUT_MS,
      },
      (res) => {
        // Google News links are redirects to the publisher — follow them to reach the page
        // that actually has the og:image.
        const loc = res.headers && res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirectsLeft > 0) {
          res.resume();
          let next;
          try { next = new URL(loc, u).toString(); } catch { return resolve(null); }
          return resolve(_fetchOgImage(next, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let html = "";
        let aborted = false;
        res.on("data", (c) => {
          html += c;
          // Stop as soon as the head is complete or the cap is hit — never pull a full page.
          if (!aborted && (html.length > OG_MAX_BYTES || /<\/head>/i.test(html))) {
            aborted = true;
            req.destroy();
          }
        });
        // Parse whatever we collected. Also the handler for our OWN abort: destroying the
        // request emits an error on it, so a naive `error -> resolve(null)` would race this
        // and throw away a perfectly good <head> we had already read.
        finish = () => {
          const m = html.match(/<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i);
          if (!m) return settle(null);
          const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i);
          if (!c) return settle(null);
          let img;
          try { img = new URL(_decodeEntities(c[1]).trim(), u).toString(); } catch { return settle(null); }
          settle(/^https?:\/\//i.test(img) ? img : null);
        };
        res.on("end", finish);
        res.on("close", finish);     // fires when we destroy early on </head>
        res.on("error", finish);
      }
    );
    req.on("error", () => finish());          // includes our own destroy()
    req.on("timeout", () => { req.destroy(); finish(); });
    req.end();
  });
}

/** Attach og:image to the first `limit` results that lack one. Mutates and returns results. */
async function _enrichWithOgImages(results, limit = OG_IMAGE_LIMIT()) {
  if (!Array.isArray(results) || !results.length || limit <= 0) return results;
  const targets = results.filter((r) => r && r.url && !r.image).slice(0, limit);
  if (!targets.length) return results;
  await Promise.all(targets.map(async (r) => {
    const img = await _fetchOgImage(r.url);
    if (img) r.image = img;
  }));
  return results;
}

// Does this query want fresh news rather than a reference page? Deliberately tighter
// than needsGrounding(): an explicit news word (news/headlines/breaking/geopolitical/
// election/war/…) OR a recency word (latest/recent/today/this week/right now) paired
// with events framing. "current node version" / "how to" stay false so ordinary
// factual grounding is unchanged.
const _NEWS_WORDS = /\b(news|headlines?|breaking|geopolitic\w*|election|elections|ceasefire|sanctions?|invasion|conflict|war|outbreak|earthquake|hurricane|wildfire|shooting|protests?)\b/i;
// Recent-PAST markers matter as much as "today": "who won the game last night" and "what
// happened yesterday" want dated articles, but neither matched before, so they fell through
// to the encyclopedic chain and got a reference page about the team/topic instead.
const _RECENCY_WORDS = /\b(latest|recent(?:ly)?|today|tonight|yesterday|last night|this week|last week|this weekend|past (?:few )?days?|this morning|right now|happening|current events?|breaking)\b/i;
function _isNewsQuery(query) {
  const q = String(query || "");
  if (!q.trim()) return false;
  if (_NEWS_WORDS.test(q)) return true;
  // recency word alone only counts when the query is not obviously a how-to/definition
  if (_RECENCY_WORDS.test(q) && !/\b(how to|what is|define|explain|version|install|error|code|function)\b/i.test(q)) {
    return true;
  }
  return false;
}

// Normalize either MCP envelope or a direct result into {success, results, error}.
function _unwrapSearch(raw) {
  let payload = raw;
  if (raw && Array.isArray(raw.content)) {
    const t = raw.content.find((c) => c && c.type === "text");
    try { payload = t ? JSON.parse(t.text) : raw; } catch { payload = raw; }
  }
  if (raw && raw.isError) return { success: false, error: (payload && payload.error) || "search failed" };
  if (payload && payload.success === false) return { success: false, error: payload.error || "search failed" };
  const results = (payload && payload.results) || [];
  return { success: results.length > 0, results, error: results.length ? null : "no results" };
}

const MCP_ATTEMPT_TIMEOUT = parseInt(process.env.WEB_SEARCH_MCP_TIMEOUT || "6000", 10);

// #1529 — keyless-search throttling causes real 0-source variance: the same query
// returns 4-8 sources one minute and 0 the next, with nothing about the query
// itself changing. The source is transient rate-limiting on the keyless fallbacks,
// not query difficulty. Two mitigations, both self-contained (no new credentials):
//
//   1. Short-TTL SUCCESS cache. A throttled retry within the window still returns
//      the good result from moments ago instead of an honest-but-unlucky zero.
//      Failures are never cached — a failed attempt should keep retrying, not get
//      stuck replaying its own failure.
//   2. One backoff+retry specifically on a detected 429, before falling through to
//      the next provider in the chain. Most keyless throttling clears within a few
//      hundred ms; retrying once beats losing the source entirely to a blip.
const SEARCH_CACHE_TTL_MS = parseInt(process.env.WEB_SEARCH_CACHE_TTL_MS || "300000", 10); // 5 min
const KEYLESS_RETRY_BACKOFF_MS = parseInt(process.env.WEB_SEARCH_RETRY_BACKOFF_MS || "400", 10);
const SEARCH_CACHE_MAX_ENTRIES = 500; // bound growth on a long-running server
const _searchCache = new Map(); // key -> { result, expiresAt }

function _cacheKey(query, maxResults) {
  return `${maxResults}::${String(query || "").trim().toLowerCase()}`;
}
function _cacheGet(key) {
  const hit = _searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _searchCache.delete(key); return null; }
  return hit.result;
}
function _cacheSet(key, result) {
  if (_searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = _searchCache.keys().next().value;
    if (oldest !== undefined) _searchCache.delete(oldest);
  }
  _searchCache.set(key, { result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
}
// Test-only: reset cache state between test cases without waiting out the TTL.
function _clearSearchCache() { _searchCache.clear(); }

function _isRateLimited(err) {
  return /rate-limited|429/i.test(String(err || ""));
}

async function _webSearchUncached(query, maxResults, opts) {
  const mcpTimeout = opts.mcpTimeoutMs || MCP_ATTEMPT_TIMEOUT;
  const retries = opts.retries == null ? 1 : opts.retries;
  const mcpImpl = opts._mcpImpl || webSearchMcp;
  const fallbackImpls = opts._fallbackImpls || [webSearchDirect, webSearchWiki];
  const newsImpl = opts._newsImpl || webSearchNews;
  const backoffMs = opts._retryBackoffMs == null ? KEYLESS_RETRY_BACKOFF_MS : opts._retryBackoffMs;
  let lastErr = "search failed";

  // #2276 — for a current-events / news query, try the freshness-first news source
  // BEFORE the MCP + encyclopedic chain, so timely articles win over reference pages
  // (Wikipedia). Non-news queries skip this entirely (behavior unchanged). Falls
  // through on any failure, so a news blip still gets the old chain's answer.
  const isNews = opts.news != null ? opts.news : _isNewsQuery(query);
  if (isNews) {
    try {
      let r = await newsImpl(query, maxResults);
      // NOT og:image-enriched, deliberately. Measured: a Google News <link> is an opaque
      // base64 token that 302s to a Google JS interstitial — not the publisher's article —
      // so there is no og:image to read, and the token no longer decodes to the real URL.
      // Enriching here would spend one wasted request per result (~1.5s) for zero images.
      // Per-article news images need a source that returns them (a keyed news API).
      if (r.success) return r;
      if (_isRateLimited(r.error) && backoffMs > 0) {
        await new Promise((res) => setTimeout(res, backoffMs));
        r = await newsImpl(query, maxResults);
        if (r.success) return r;
      }
      lastErr = r.error || lastErr;
    } catch (e) { lastErr = e.message || lastErr; }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await mcpImpl(query, maxResults, mcpTimeout);
      const norm = _unwrapSearch(raw);
      if (norm.success) return { ...norm, source: "mcp" };
      lastErr = norm.error || lastErr;
    } catch (e) { lastErr = e.message || lastErr; }
  }
  // MCP slow/down/empty → keyless fallbacks: DDG instant answer, then Wikipedia.
  for (const fb of fallbackImpls) {
    try {
      let r = await fb(query, maxResults);
      // These sources DO hand back real article/page URLs (en.wikipedia.org/…, publisher
      // sites), so og:image is actually fetchable here — bounded + parallel + best-effort,
      // and skipped for any result that already carries an image from the API itself.
      if (r.success) return { ...r, results: await _enrichWithOgImages(r.results, opts.ogImageLimit) };
      if (_isRateLimited(r.error) && backoffMs > 0) {
        await new Promise((res) => setTimeout(res, backoffMs));
        r = await fb(query, maxResults);
        if (r.success) return { ...r, results: await _enrichWithOgImages(r.results, opts.ogImageLimit) };
      }
      lastErr = r.error || lastErr;
    } catch (e) { lastErr = e.message || lastErr; }
  }
  return { success: false, results: [], error: lastErr, source: "none" };
}

/**
 * Dependable web search for the chat tool loop (#1212): try the MCP path with a
 * bounded per-call timeout + 1 retry, then fall back to a keyless direct DuckDuckGo
 * search, retrying once on a detected rate-limit before moving to the next provider
 * (#1529). Successful results are cached for WEB_SEARCH_CACHE_TTL_MS (default 5 min,
 * keyed by query+maxResults) so throttling variance can't turn a result that
 * existed moments ago into an honest-but-unlucky zero. Returns a normalized
 * {success, results, error, source}; a cache hit also carries `fromCache: true`. On
 * total failure the caller gets an explicit error (so the model says "search
 * unavailable" instead of silently answering from memory).
 */
async function webSearch(query, maxResults = 5, opts = {}) {
  const key = _cacheKey(query, maxResults);
  if (!opts.skipCache) {
    const cached = _cacheGet(key);
    if (cached) return { ...cached, fromCache: true };
  }
  const result = await _webSearchUncached(query, maxResults, opts);
  if (result.success) _cacheSet(key, result);
  return result;
}

module.exports = {
  webSearchMcp,
  webSearchDirect,
  webSearchWiki,
  webSearchNews,
  webSearch,
  _parseNewsRss,
  _isNewsQuery,
  _httpFallbackError,
  _fetchOgImage,
  _enrichWithOgImages,
  _isPrivateHostname,
  _cacheKey,
  _clearSearchCache,
  _isRateLimited,
  formatGroundingContext,
  needsGrounding,
  extractSearchQuery,
};
