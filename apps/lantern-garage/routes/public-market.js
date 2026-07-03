"use strict";

/**
 * Public market-data — keyless read-only quotes/bars for the LOGGED-OUT chart view
 * (stock-charts.html). Deliberately NOT under /api/trading/, so the trade-entitlement
 * guard doesn't block it: a guest can see charts, but no account/order/trading data.
 * Source is the same keyless Yahoo path the trader uses (lib/market-data-yahoo).
 */

const yahoo = require("../lib/market-data-yahoo");

// Only plain tickers (defence: these values reach an outbound Yahoo request).
function cleanTickers(raw, fallback) {
  const list = String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{1,10}$/.test(s));
  return list.length ? list.slice(0, 24) : fallback;
}

const DEFAULT_WATCHLIST = ["SPY", "AAPL", "TSLA", "NVDA", "AMD", "AMZN", "META", "MSFT", "GOOGL", "QQQ"];
const ALLOWED_TF = new Set(["1m", "5m", "15m", "1h", "1d", "5d", "1M"]);

module.exports = async function publicMarketRoutes(req, res, url, deps) {
  const { sendJson } = deps;
  if (!url.pathname.startsWith("/api/market/")) return false;

  // GET /api/market/status — VIX / regime / SPY trend / session-open (keyless)
  if (url.pathname === "/api/market/status" && req.method === "GET") {
    try { sendJson(res, await yahoo.getMarketStatus(), 200); }
    catch (e) { sendJson(res, { available: false, reason: e.message }, 200); }
    return true;
  }

  // GET /api/market/quotes?tickers=SPY,AAPL — read-only prices
  if (url.pathname === "/api/market/quotes" && req.method === "GET") {
    const tickers = cleanTickers(url.searchParams.get("tickers"), DEFAULT_WATCHLIST);
    try { sendJson(res, { quotes: await yahoo.getQuotes(tickers) }, 200); }
    catch (e) { sendJson(res, { quotes: [], error: e.message }, 200); }
    return true;
  }

  // GET /api/market/bars-multi?tickers=SPY,AAPL&timeframe=5m — OHLCV for the chart grid
  if (url.pathname === "/api/market/bars-multi" && req.method === "GET") {
    const tickers = cleanTickers(url.searchParams.get("tickers"), DEFAULT_WATCHLIST);
    const tf = ALLOWED_TF.has(url.searchParams.get("timeframe")) ? url.searchParams.get("timeframe") : "5m";
    try { sendJson(res, await yahoo.getBarsMulti(tickers, tf), 200); }
    catch (e) { sendJson(res, { bars: {}, timeframe: tf, error: e.message }, 200); }
    return true;
  }

  // GET /api/market/bars?ticker=NVDA&timeframe=5m — one symbol
  if (url.pathname === "/api/market/bars" && req.method === "GET") {
    const t = cleanTickers(url.searchParams.get("ticker"), ["SPY"])[0];
    const tf = ALLOWED_TF.has(url.searchParams.get("timeframe")) ? url.searchParams.get("timeframe") : "5m";
    try { sendJson(res, await yahoo.getBars(t, tf), 200); }
    catch (e) { sendJson(res, { bars: [], ticker: t, timeframe: tf, error: e.message }, 200); }
    return true;
  }

  return false;
};
