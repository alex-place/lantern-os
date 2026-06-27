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
  for (const r of results.slice(0, 5)) {
    lines.push(`[${r.rank}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.snippet) lines.push(`    Snippet: ${r.snippet}`);
    lines.push("");
  }
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
function _stripTags(s) { return _decodeEntities(String(s || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(); }

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
            const push = (title, url, snippet) => {
              title = _stripTags(title); url = String(url || "").trim();
              if (!url || seen.has(url) || results.length >= maxResults) return;
              seen.add(url);
              results.push({ title: title || url, url, snippet: _stripTags(snippet || title) });
            };
            // 1) Topic abstract (e.g. the Wikipedia summary) — the strongest single result.
            if (j.AbstractText && j.AbstractURL) push(j.Heading || j.AbstractSource || j.AbstractText, j.AbstractURL, j.AbstractText);
            // 2) Direct external results (rare but high quality).
            for (const r of (j.Results || [])) push(r.Text, r.FirstURL, r.Text);
            // 3) Related topics — flatten one level of grouping.
            const flat = [];
            for (const t of (j.RelatedTopics || [])) {
              if (t && Array.isArray(t.Topics)) flat.push(...t.Topics);
              else if (t) flat.push(t);
            }
            for (const t of flat) if (t.FirstURL && t.Text) push(t.Text.split(" - ")[0], t.FirstURL, t.Text);
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

/**
 * Dependable web search for the chat tool loop (#1212): try the MCP path with a
 * bounded per-call timeout + 1 retry, then fall back to a keyless direct DuckDuckGo
 * search. Returns a normalized {success, results, error, source}. On total failure
 * the caller gets an explicit error (so the model says "search unavailable" instead
 * of silently answering from memory).
 */
async function webSearch(query, maxResults = 5, opts = {}) {
  const mcpTimeout = opts.mcpTimeoutMs || MCP_ATTEMPT_TIMEOUT;
  const retries = opts.retries == null ? 1 : opts.retries;
  let lastErr = "search failed";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await webSearchMcp(query, maxResults, mcpTimeout);
      const norm = _unwrapSearch(raw);
      if (norm.success) return { ...norm, source: "mcp" };
      lastErr = norm.error || lastErr;
    } catch (e) { lastErr = e.message || lastErr; }
  }
  // MCP slow/down/empty → keyless fallbacks: DDG instant answer, then Wikipedia.
  for (const fb of [webSearchDirect, webSearchWiki]) {
    try {
      const r = await fb(query, maxResults);
      if (r.success) return r;
      lastErr = r.error || lastErr;
    } catch (e) { lastErr = e.message || lastErr; }
  }
  return { success: false, results: [], error: lastErr, source: "none" };
}

module.exports = {
  webSearchMcp,
  webSearchDirect,
  webSearchWiki,
  webSearch,
  _httpFallbackError,
  formatGroundingContext,
  needsGrounding,
  extractSearchQuery,
};
