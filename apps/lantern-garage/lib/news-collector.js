/**
 * Market News Collector
 *
 * Fetches headlines for the trading watchlist plus broad-market indices from
 * Yahoo Finance's public RSS feeds (free, no API key) and records each item
 * into the CSF trading-news registry via trading-news.js's recordNewsItem().
 *
 * This gives /trading-news.html a continuously-growing real feed via its CSF
 * fallback path (/api/trading/news/recent), independent of the legacy AI
 * Trader dashboard (dashboard.py, port 5050) which lanternOS does not start.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const tradingNews = require("./trading-news");
const marketData = require("./market-data-client");

const WATCHLIST_PATH = path.resolve(__dirname, "..", "..", "..", "data", "lantern-garage", "trading", "watchlist.json");
const BROAD_MARKET_SYMBOLS = ["^GSPC", "^DJI", "^IXIC", "^VIX"];

// Primary source: the locally-running AI Trader dashboard (dashboard.py), whose
// /api/news-feed serves REAL Alpaca news per watchlist ticker. Plain localhost
// HTTP — no TLS so it's immune to the machine's HTTPS interception that starves
// the Yahoo RSS path. Configurable; defaults to the dashboard's port 5000.
// When the dashboard is offline the fetch degrades gracefully (records nothing).
const DASHBOARD_NEWS_URL =
  process.env.DASHBOARD_NEWS_URL || "http://127.0.0.1:5000/api/news-feed";

const HIGH_IMPACT_KEYWORDS = [
  "fed", "rate hike", "rate cut", "inflation", "cpi", "jobs report",
  "earnings", "beats", "misses", "guidance", "downgrade", "upgrade",
  "lawsuit", "recall", "fda", "merger", "acquisition", "bankruptcy",
  "crash", "plunge", "surge", "soar", "investigation", "layoffs",
];
const MED_IMPACT_KEYWORDS = [
  "launch", "partnership", "expansion", "forecast", "outlook", "dividend",
  "buyback", "split", "ipo", "contract", "deal", "stake",
];

function scoreImpact(headline) {
  const h = (headline || "").toLowerCase();
  if (HIGH_IMPACT_KEYWORDS.some((k) => h.includes(k))) return 75;
  if (MED_IMPACT_KEYWORDS.some((k) => h.includes(k))) return 55;
  return 35;
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(#39|apos);/g, "'")
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of blocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!title || !link) continue;
    const published = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
    items.push({
      headline: decodeEntities(title),
      url: decodeEntities(link),
      published,
      source: sourceMatch ? decodeEntities(sourceMatch[1]) : "Yahoo Finance",
    });
  }
  return items;
}

function fetchRssOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function fetchRss(symbols) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbols.join(","))}&region=US&lang=en-US`;
  // Yahoo's feed drops connections transiently ("socket hang up"); one retry
  // with a short backoff recovers nearly all of them.
  try {
    return await fetchRssOnce(url);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await fetchRssOnce(url);
    } catch (e2) {
      console.error("[NewsCollector] Fetch error (after retry):", e2.message);
      return "";
    }
  }
}

// Yahoo retired the free RSS headline feed (feeds.finance.yahoo.com/rss/2.0/
// headline now 404s). Its current news lives on the JSON search endpoint —
// query1.finance.yahoo.com/v1/finance/search — the same host the trader's bar
// feed already uses. Query by symbol and normalise to the {headline,url,
// published,source,id} shape recordNewsItem expects. (#1583 / news-not-loading)
function fetchYahooNews(symbols) {
  const q = encodeURIComponent((symbols && symbols[0]) || "SPY");
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${q}&newsCount=12&quotesCount=0&lang=en-US&region=US`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const items = (data.news || [])
            .map((n) => ({
              headline: n.title,
              url: n.link,
              published: n.providerPublishTime
                ? new Date(n.providerPublishTime * 1000).toISOString()
                : new Date().toISOString(),
              source: n.publisher || "Yahoo Finance",
              id: n.uuid || n.link,
              // Yahoo tags each headline with the tickers it's actually about —
              // accurate per-story, so the finance card's company logo is right
              // (a PLTR story keeps its PLTR logo instead of inheriting the NVDA
              // query that surfaced it). Drives the ticker-logo in explore-feed.
              relatedTickers: (Array.isArray(n.relatedTickers) ? n.relatedTickers : [])
                .filter((t) => /^[A-Z]{1,5}$/.test(t))
                .slice(0, 4),
            }))
            .filter((it) => it.headline && it.url);
          resolve(items);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
  });
}

// Fetch the dashboard's news JSON over localhost HTTP. Resolves to a parsed
// object (or null on any failure — offline dashboard, bad JSON, timeout).
function fetchDashboardNews() {
  return new Promise((resolve) => {
    const req = http.get(DASHBOARD_NEWS_URL, { timeout: 20000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));      // dashboard not running → silent
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function loadWatchlist() {
  try {
    const raw = fs.readFileSync(WATCHLIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.tickers)) return parsed.tickers;
  } catch {
    // file missing or invalid — fall back to empty list (broad-market still runs)
  }
  return [];
}

class NewsCollector {
  constructor() {
    this.running = false;
    this.pollInterval = null;
  }

  async _collectFor(symbols, tag) {
    const items = (await fetchYahooNews(symbols)).slice(0, 8);
    if (!items.length) return 0;
    let recorded = 0;
    for (const item of items) {
      // Prefer Yahoo's per-headline relatedTickers (accurate company logo); fall
      // back to the query ticker for a per-ticker search, or none for broad.
      const rt = Array.isArray(item.relatedTickers) ? item.relatedTickers : [];
      const symbols = rt.length ? rt : (tag === "broad" ? [] : [tag]);
      const rec = await tradingNews.recordNewsItem({
        ...item,
        symbols,
        impact: scoreImpact(item.headline),
      }).catch((e) => {
        console.error("[NewsCollector] Record error:", e.message);
        return null;
      });
      if (rec && rec.tier === "entity") recorded++;
    }
    return recorded;
  }

  // Primary source — the dashboard's real Alpaca news. Each item already carries
  // id/headline/source/url/symbols/impact; map straight onto the CSF registry
  // (recordNewsItem dedups by id/url so repeated polls don't pile up). Returns
  // the number of NEW headlines recorded; 0 when the dashboard is offline.
  async _collectFromDashboard() {
    const data = await fetchDashboardNews();
    if (!data) return 0;
    const items = [
      ...(Array.isArray(data.ticker_news) ? data.ticker_news : []),
      ...(Array.isArray(data.broad_news) ? data.broad_news : []),
    ];
    let recorded = 0;
    for (const it of items) {
      if (!it || !it.headline) continue;
      const rec = await tradingNews.recordNewsItem({
        id: it.id,
        headline: it.headline,
        source: it.source || "Alpaca",
        url: it.url || "",
        // it.date is "YYYY-MM-DD" (parseable); the human "published" string lacks
        // a year, so prefer date for a sortable/renderable timestamp.
        published: it.date || it.published || "",
        date: it.date || "",
        symbols: Array.isArray(it.symbols) ? it.symbols : [],
        impact: typeof it.impact === "number" ? it.impact : scoreImpact(it.headline),
        summary: it.summary || "",
        image: it.image || "",
      }).catch((e) => {
        console.error("[NewsCollector] Dashboard record error:", e.message);
        return null;
      });
      if (rec && rec.tier === "entity") recorded++;
    }
    if (recorded > 0) console.log(`[NewsCollector] Recorded ${recorded} headline(s) from dashboard`);
    return recorded;
  }

  // Finnhub source (free /news + /company-news) — the reliable primary feed.
  // Unlike Yahoo's RSS (which the machine's HTTPS interception starves) and the
  // dashboard (usually offline), Finnhub is a stable keyed JSON API. Records
  // general market news plus per-watchlist-ticker company news. Silent no-op when
  // FINNHUB_API_KEY is unset (recordNewsItem dedups by id/url across sources, so
  // this never double-counts headlines Yahoo/dashboard also carry).
  async _collectFromFinnhub() {
    if (!marketData.hasFinnhub()) return 0;
    let recorded = 0;
    const record = async (item, symbols) => {
      const rec = await tradingNews.recordNewsItem({
        id: item.id,
        headline: item.headline,
        source: item.source || "Finnhub",
        url: item.url || "",
        published: item.published || "",
        date: (item.published || "").slice(0, 10),
        symbols: symbols || item.symbols || [],
        impact: scoreImpact(item.headline),
        summary: item.summary || "",
        image: item.image || "",
      }).catch((e) => { console.error("[NewsCollector] Finnhub record error:", e.message); return null; });
      if (rec && rec.tier === "entity") recorded++;
    };

    // Broad market news (general category) — untagged, feeds the finance rail.
    try {
      const general = (await marketData.finnhubMarketNews("general")).slice(0, 12);
      for (const it of general) await record(it, []);
    } catch (e) { console.error("[NewsCollector] Finnhub market news error:", e.message); }

    // Per-ticker company news for the equity watchlist.
    const tickers = loadWatchlist().filter((t) => /^[A-Z]{1,5}$/.test(t));
    for (const ticker of tickers) {
      try {
        const items = (await marketData.finnhubCompanyNews(ticker)).slice(0, 6);
        for (const it of items) await record(it, [ticker]);
      } catch (e) { console.error("[NewsCollector] Finnhub company news error:", e.message); }
    }
    if (recorded > 0) console.log(`[NewsCollector] Recorded ${recorded} headline(s) from Finnhub`);
    return recorded;
  }

  async collectOnce() {
    // Finnhub (free, reliable) is the primary source; the local Alpaca dashboard
    // and Yahoo RSS remain as supplements/fallbacks. All three dedup by id/url.
    let total = await this._collectFromFinnhub();
    total += await this._collectFromDashboard();

    // Stock-style tickers only (e.g. excludes BTCUSD/ETHUSD/SOLUSD, which
    // don't have Yahoo Finance equity RSS feeds — crypto news is handled by
    // crypto-collector.js).
    const tickers = loadWatchlist().filter((t) => /^[A-Z]{1,5}$/.test(t));

    total += await this._collectFor(BROAD_MARKET_SYMBOLS, "broad");
    for (const ticker of tickers) {
      total += await this._collectFor([ticker], ticker);
      // Be polite to Yahoo's free RSS endpoint
      await new Promise((r) => setTimeout(r, 500));
    }

    if (total > 0) {
      console.log(`[NewsCollector] Recorded ${total} new headline(s)`);
    }
    return total;
  }

  start(intervalMs = 600000) {
    if (this.running) return;
    this.running = true;

    console.log("[NewsCollector] Starting (interval: " + intervalMs + "ms)");

    this.collectOnce().catch((e) => console.error("[NewsCollector] Collect error:", e.message));
    this.pollInterval = setInterval(() => {
      this.collectOnce().catch((e) => console.error("[NewsCollector] Collect error:", e.message));
    }, intervalMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    console.log("[NewsCollector] Stopped");
  }
}

module.exports = NewsCollector;
