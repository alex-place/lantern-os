"use strict";

/**
 * lib/unisona-trader.js — the Business-tier evidence-cited research partner (#2556).
 *
 * Product plan §01 Business card: "UnisonaTrader — an AI stock-and-options advisor
 * that researches the market with you and shows its evidence." This module builds a
 * RESEARCH BRIEF for a symbol from real market-data tool calls, where every
 * quantitative claim carries a receipt back to the exact call that produced it —
 * the External Reality Rule applied to markets: nothing asserted without evidence.
 *
 * POSITIONING (§01/§06, non-negotiable): a research PARTNER, NOT a licensed advisor.
 * It surfaces facts + reasoning and LEAVES THE DECISION TO THE USER. It emits NO
 * buy/sell/hold imperatives and no personalized recommendations — only sourced
 * observations. The disclaimer is part of the payload, and a test asserts the brief
 * contains no advice-imperative language.
 *
 * DATA HONESTY: options-chain research (chain / IV / greeks / covered-call & CSP
 * analysis) is not yet wired to a data source that legally permits it (the issue's
 * known gap — Yahoo needs crumb auth, Alpha Vantage free IV is identified but not
 * integrated). Rather than fabricate greeks, the options section says so plainly.
 *
 * LOOP STAGE: Reason (grounded market research) + Verify (every claim cites its source).
 */

const DISCLAIMER =
  "UnisonaTrader is a research partner, not a licensed financial advisor. It surfaces " +
  "evidence and reasoning; every figure below is sourced to a live data call. It does " +
  "not tell you to buy, sell, or hold — the decision is yours.";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (v) => (v == null ? null : `${v > 0 ? "+" : ""}${v}%`);

/**
 * Build a research brief. `get(pathAndQuery)` is an injectable loopback fetcher
 * (default: the in-process trading API hop, same as tool-runner). Returns the
 * brief plus a `receipts` run-log; each claim's `source` is a receipt id, so
 * "every quantitative claim traces to a tool call" is structural, not asserted.
 */
async function researchBrief(symbol, opts = {}) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z.]{1,6}$/.test(sym)) {
    return { ok: false, error: "invalid_symbol", detail: "Provide a US equity ticker (e.g. SPY)." };
  }
  const get = opts.get || defaultGet;
  const receipts = [];
  async function call(id, pathAndQuery) {
    const at = opts.now || new Date().toISOString();
    try {
      const data = await get(pathAndQuery);
      const ok = !!data && data.available !== false && !data.error;
      receipts.push({ id, endpoint: pathAndQuery, ok, at });
      return ok ? data : null;
    } catch (e) {
      receipts.push({ id, endpoint: pathAndQuery, ok: false, at, error: e.message });
      return null;
    }
  }

  // ── Gather (each is a citable receipt) ──────────────────────────────────────
  const stats = await call("symbol_stats", `/api/trading/symbol-stats?ticker=${encodeURIComponent(sym)}`);
  const info = await call("symbol_info", `/api/trading/symbol-info?ticker=${encodeURIComponent(sym)}`);
  const market = await call("market_status", `/api/trading/market-status`);
  const news = await call("news", `/api/trading/news/recent?ticker=${encodeURIComponent(sym)}&limit=5`);

  const claim = (id, text, value, confidence) => ({ claim: text, value, source: id, confidence });
  const sections = [];

  // Price & trend — from symbol-stats (returns over windows, SMA position).
  if (stats) {
    const r = stats.returns || {};
    const trendClaims = [];
    if (stats.price != null) trendClaims.push(claim("symbol_stats", `Last price`, num(stats.price), "high"));
    for (const [k, label] of [["1d", "1-day return"], ["5d", "5-day return"], ["30d", "30-day return"], ["90d", "90-day return"]]) {
      if (r[k] != null) trendClaims.push(claim("symbol_stats", label, pct(num(r[k])), "high"));
    }
    if (stats.ytd != null) trendClaims.push(claim("symbol_stats", "Year-to-date return", pct(num(stats.ytd)), "high"));
    if (stats.sma50 != null && stats.price != null) {
      trendClaims.push(claim("symbol_stats", "Price vs 50-day average",
        stats.price >= stats.sma50 ? "above the 50-day SMA" : "below the 50-day SMA", "high"));
    }
    if (stats.avgVol != null) trendClaims.push(claim("symbol_stats", "Avg daily volume (30d)", num(stats.avgVol), "high"));
    if (trendClaims.length) sections.push({ title: "Price & trend", claims: trendClaims });
  }

  // Identity / fundamentals — from symbol-info (name, exchange, asset class).
  if (info && (info.name || info.exchange)) {
    const idClaims = [];
    if (info.name) idClaims.push(claim("symbol_info", "Name", String(info.name), "high"));
    if (info.exchange) idClaims.push(claim("symbol_info", "Exchange", String(info.exchange), "high"));
    if (info.asset_class || info.assetClass) idClaims.push(claim("symbol_info", "Asset class", String(info.asset_class || info.assetClass), "high"));
    if (idClaims.length) sections.push({ title: "Identity", claims: idClaims });
  }

  // Market context — VIX / regime / SPY trend / session (the backdrop, sourced).
  if (market) {
    const mClaims = [];
    if (market.vix != null) mClaims.push(claim("market_status", "VIX (volatility)", num(market.vix), "high"));
    if (market.regime) mClaims.push(claim("market_status", "Volatility regime", String(market.regime), "high"));
    if (market.spy_trend || market.spyTrend) mClaims.push(claim("market_status", "S&P 500 trend", String(market.spy_trend || market.spyTrend), "high"));
    if (market.market_open != null || market.session) mClaims.push(claim("market_status", "US session", market.session || (market.market_open ? "open" : "closed"), "high"));
    if (mClaims.length) sections.push({ title: "Market context", claims: mClaims });
  }

  // Recent news — headlines with source + sentiment (NOT quantitative; listed as items).
  const newsItems = Array.isArray(news) ? news : (news && news.news) || [];
  if (Array.isArray(newsItems) && newsItems.length) {
    sections.push({
      title: "Recent news",
      items: newsItems.slice(0, 5).map((n) => ({
        headline: String(n.headline || n.title || "").slice(0, 200),
        source: n.source || null,
        sentiment: n.sentiment || null,
        url: n.url || n.link || null,
      })),
    });
  }

  // Options — honest gap, never fabricated.
  sections.push({
    title: "Options",
    note: "Options-chain research (chain, implied volatility, greeks, covered-call / cash-secured-put analysis) " +
      "is not yet wired to a licensed data source, so it is omitted here rather than estimated. Tracked as the " +
      "next data integration for this surface.",
    available: false,
  });

  // Every claim carries a `source` receipt id → count them for the acceptance check.
  const quantClaims = sections.flatMap((s) => s.claims || []);
  const citedCount = quantClaims.filter((c) => receipts.some((r) => r.id === c.source && r.ok)).length;

  return {
    ok: true,
    kind: "research_brief",
    symbol: sym,
    generatedAt: opts.now || new Date().toISOString(),
    disclaimer: DISCLAIMER,
    sections,
    receipts,
    citation: {
      quantitativeClaims: quantClaims.length,
      backedByReceipt: citedCount,
      fullyCited: citedCount === quantClaims.length, // every number traces to a successful call
    },
    dataGaps: ["options_chain"],
  };
}

/** Default loopback fetcher — the in-process trading API hop (mirrors tool-runner). */
function defaultGet(pathAndQuery) {
  const http = require("http");
  const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathAndQuery, headers: { "x-keystone-internal": "1" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(9000, () => req.destroy(new Error("timeout")));
  });
}

module.exports = { researchBrief, DISCLAIMER };
