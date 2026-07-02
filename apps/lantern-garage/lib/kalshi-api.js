/**
 * Kalshi v2 API client — the full trade-api surface, for the on-dashboard terminal.
 *
 * Read endpoints (markets / events / orderbook / exchange status) are public and
 * need no auth. Portfolio reads (balance / positions / orders / fills) and order
 * placement are authenticated with Kalshi's RSA-PSS request signing.
 *
 * SAFETY — the live boundary is enforced in code, not by trust:
 *   - Credentials come from env (KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY[_PATH]).
 *     This module NEVER asks for or stores keys; if they are absent, authed calls
 *     return {error:'credentials_required'} and the UI prompts YOU to connect them.
 *   - placeOrder is DRY-RUN by default. A live order requires ALL of:
 *       (1) KALSHI_TRADING_ENABLED === '1', and
 *       (2) the kill-switch file data/kalshi/LIVE-KILL-SWITCH is ABSENT, and
 *       (3) valid credentials.
 *     Otherwise it logs a planned order to the existing kalshi-live-ledger.jsonl
 *     and returns {mode:'dry_run'} — nothing hits the exchange.
 */

"use strict";

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "..", "..", "..", "data", "kalshi");
const LEDGER = path.join(KALSHI_DIR, "kalshi-live-ledger.jsonl");
const KILL_SWITCH = path.join(KALSHI_DIR, "LIVE-KILL-SWITCH");
// Trading-paused flag: when this file exists, ALL trade-suggestion decks return
// zero entry cards. Engaged 2026-06-17 after the realized-PnL backtest showed no
// edge after fees. Remove only once a strategy is proven net-profitable vs the
// bet-favorite baseline (see experiments/kalshi_pnl_backtest.py).
const TRADING_PAUSED = path.join(KALSHI_DIR, "TRADING-PAUSED");

const ENV = (process.env.KALSHI_ENV || "prod").toLowerCase();
// Kalshi consolidated its API onto `api.elections.kalshi.com`. The legacy
// `external-api.kalshi.com` host still proxies READS but its order-placement
// endpoint is retired — POST /portfolio/orders there returns 410 Gone, which is why
// live orders were failing. The signature is host-agnostic (ts+method+path), so
// moving hosts keeps auth working. Override with KALSHI_API_HOST if Kalshi migrates again.
const HOST = process.env.KALSHI_API_HOST
  || (ENV === "demo" ? "demo-api.kalshi.co" : "api.elections.kalshi.com");
const BASE = "/trade-api/v2";

// ── credentials (user-supplied via env; never entered here) ──────────────────
function loadPrivateKey() {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY;
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return null;
}
function hasCredentials() {
  return !!(process.env.KALSHI_API_KEY_ID && loadPrivateKey());
}
function killSwitchActive() {
  return fs.existsSync(KILL_SWITCH);
}
function tradingPaused() {
  return fs.existsSync(TRADING_PAUSED);
}
function tradingEnabled() {
  return process.env.KALSHI_TRADING_ENABLED === "1";
}

// ── RSA-PSS request signing (Kalshi auth scheme) ─────────────────────────────
function signedHeaders(method, fullPath) {
  const ts = Date.now().toString();
  const pem = loadPrivateKey();
  const msg = ts + method.toUpperCase() + fullPath;
  const signature = crypto
    .sign("sha256", Buffer.from(msg), {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
  return {
    "KALSHI-ACCESS-KEY": process.env.KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": ts,
  };
}

// ── core request ─────────────────────────────────────────────────────────────
function request(method, endpoint, { auth = false, query = null, body = null } = {}) {
  return new Promise((resolve) => {
    if (auth && !hasCredentials()) {
      return resolve({ ok: false, status: 401, error: "credentials_required" });
    }
    let pathOnly = BASE + endpoint;
    if (query) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null && v !== "")
      ).toString();
      if (qs) pathOnly += "?" + qs;
    }
    const sigPath = (BASE + endpoint); // signature uses path WITHOUT query
    const headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (auth) Object.assign(headers, signedHeaders(method, sigPath));

    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      { hostname: HOST, path: pathOnly, method, headers, timeout: 15000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: parsed });
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, error: "timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── schema normalization ─────────────────────────────────────────────────────
// Kalshi's current API returns a decimal schema (yes_ask_dollars: "0.38",
// orderbook_fp.yes_dollars: [["0.38","6218.00"], …]). The terminal speaks the
// older integer-cents schema (yes_ask: 38, orderbook.yes: [[38, 6218], …]), so
// we normalize here — one place — and the UI stays simple and stable.
function centsFromDollars(s) {
  const f = parseFloat(s);
  return Number.isFinite(f) ? Math.round(f * 100) : null;
}
function numFromFp(s) {
  const f = parseFloat(s);
  return Number.isFinite(f) ? Math.round(f) : null;
}
function normalizeMarket(m) {
  return {
    ...m,
    yes_ask: m.yes_ask ?? centsFromDollars(m.yes_ask_dollars),
    yes_bid: m.yes_bid ?? centsFromDollars(m.yes_bid_dollars),
    no_ask: m.no_ask ?? centsFromDollars(m.no_ask_dollars),
    no_bid: m.no_bid ?? centsFromDollars(m.no_bid_dollars),
    last_price: m.last_price ?? centsFromDollars(m.last_price_dollars),
    volume: m.volume ?? numFromFp(m.volume_fp),
  };
}
function normalizeBook(side) {
  return (side || []).map((lvl) => {
    const [p, s] = lvl;
    return [centsFromDollars(p) ?? p, numFromFp(s) ?? s];
  });
}

// ── public market data ───────────────────────────────────────────────────────
const getExchangeStatus = () => request("GET", "/exchange/status");
const getEvents = (q = {}) => request("GET", "/events", { query: q });
const getMarket = (ticker) => request("GET", `/markets/${encodeURIComponent(ticker)}`);
const getSeries = (q = {}) => request("GET", "/series", { query: q });

async function getMarkets(q = {}) {
  const r = await request("GET", "/markets", { query: q });
  if (r.ok && r.data && Array.isArray(r.data.markets)) {
    r.data.markets = r.data.markets.map(normalizeMarket);
  }
  return r;
}

async function getOrderbook(ticker, depth = 10) {
  const r = await request("GET", `/markets/${encodeURIComponent(ticker)}/orderbook`, {
    query: { depth },
  });
  if (r.ok && r.data) {
    const raw = r.data.orderbook || r.data.orderbook_fp;
    if (raw) {
      r.data.orderbook = {
        yes: normalizeBook(raw.yes || raw.yes_dollars),
        no: normalizeBook(raw.no || raw.no_dollars),
      };
    }
  }
  return r;
}

// ── authenticated portfolio ──────────────────────────────────────────────────
const getBalance = () => request("GET", "/portfolio/balance", { auth: true });
const getOrders = (q = {}) => request("GET", "/portfolio/orders", { auth: true, query: q });

async function getPositions(q = {}) {
  const r = await request("GET", "/portfolio/positions", { auth: true, query: q });
  if (r.ok && r.data && Array.isArray(r.data.market_positions)) {
    r.data.market_positions = r.data.market_positions.map((p) => ({
      ...p,
      position: p.position ?? numFromFp(p.position_fp ?? p.quantity_fp),
    }));
  }
  return r;
}

async function getFills(q = {}) {
  const r = await request("GET", "/portfolio/fills", { auth: true, query: q });
  if (r.ok && r.data && Array.isArray(r.data.fills)) {
    r.data.fills = r.data.fills.map((f) => ({
      ...f,
      ticker: f.ticker || f.market_ticker,
      count: f.count ?? numFromFp(f.count_fp),
      yes_price: f.yes_price ?? centsFromDollars(f.yes_price_dollars),
      no_price: f.no_price ?? centsFromDollars(f.no_price_dollars),
    }));
  }
  return r;
}

// ── live-scope gate ──────────────────────────────────────────────────────────
// Even with every global gate cleared (KALSHI_TRADING_ENABLED=1 + kill-switch off +
// creds), a LIVE order is only allowed for an ALLOWLISTED source and up to a hard
// contract cap. This keeps real money on the proven, band-robust weather-edge path
// and forces everything else (crypto/momentum, unsourced orders) to dry-run —
// enforced in code, not by trust. `KALSHI_LIVE_SCOPE=all` removes the restriction.
function liveScopeSources() {
  const raw = (process.env.KALSHI_LIVE_SCOPE || "kalshi-weather-edge").trim();
  if (!raw || raw.toLowerCase() === "all") return null; // null = no source restriction
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}
function liveMaxContracts() {
  const n = parseInt(process.env.KALSHI_LIVE_MAX_CONTRACTS || "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ── orders (dry-run / kill-switch / scope gated) ─────────────────────────────
function logLedger(entry) {
  try {
    fs.mkdirSync(KALSHI_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* best-effort */ }
}

/**
 * Place an order. Returns the live result ONLY if trading is enabled, the kill
 * switch is off, and credentials exist; otherwise records a dry-run plan.
 * @param {{ticker, side:'yes'|'no', action:'buy'|'sell', count:number, type:'limit'|'market', limitCents?:number}} o
 */
async function placeOrder(o) {
  const blockers = [];
  if (!tradingEnabled()) blockers.push("trading_disabled (set KALSHI_TRADING_ENABLED=1)");
  if (killSwitchActive()) blockers.push("kill_switch_active (data/kalshi/LIVE-KILL-SWITCH)");
  if (!hasCredentials()) blockers.push("credentials_required");

  // Scope gate: restrict live orders to the allowlisted source(s). An unsourced or
  // off-scope order (e.g. crypto/momentum) can NEVER go live — it falls to dry-run.
  const scope = liveScopeSources();
  if (scope && !scope.has(o.source)) {
    blockers.push(`out_of_live_scope (source=${o.source || "none"}; live-allowed=${[...scope].join(",")})`);
  }

  // Hard contract cap for live orders — a live order is clamped to at most this many.
  const maxN = liveMaxContracts();
  const cappedCount = Math.min(o.count || 1, maxN);

  const clientOrderId = crypto.randomUUID();
  const base = {
    ticker: o.ticker, side: o.side, action: o.action, count: cappedCount,
    type: o.type || "limit", clientOrderId, source: o.source || null,
  };
  if (o.type !== "market") base.limitCents = o.limitCents;
  if ((o.count || 1) !== cappedCount) base.countCappedFrom = o.count;

  if (blockers.length) {
    logLedger({ event: "dry_run_order_planned", mode: "dry_run", environment: ENV, wouldBlock: blockers, ...base });
    return { mode: "dry_run", wouldBlock: blockers, order: base };
  }

  // LIVE path — all gates cleared. Kalshi expects yes_price/no_price in cents.
  const body = {
    ticker: o.ticker, action: o.action, side: o.side, count: cappedCount,
    type: o.type || "limit", client_order_id: clientOrderId,
  };
  if (o.type !== "market") {
    if (o.side === "yes") body.yes_price = o.limitCents; else body.no_price = o.limitCents;
  }
  const res = await request("POST", "/portfolio/orders", { auth: true, body });
  logLedger({ event: "live_order_submitted", mode: "live", environment: ENV, status: res.status, ...base });
  return { mode: "live", status: res.status, result: res.data, order: base };
}

async function cancelOrder(orderId) {
  if (!tradingEnabled() || killSwitchActive() || !hasCredentials()) {
    return { mode: "dry_run", wouldBlock: true, orderId };
  }
  const res = await request("DELETE", `/portfolio/orders/${encodeURIComponent(orderId)}`, { auth: true });
  return { mode: "live", status: res.status, result: res.data };
}

// ── connection / safety snapshot for the UI ──────────────────────────────────
async function getConnection() {
  const status = await getExchangeStatus();
  return {
    env: ENV,
    host: HOST,
    exchangeActive: status.ok ? (status.data?.exchange_active ?? null) : null,
    credentials: hasCredentials(),
    tradingEnabled: tradingEnabled(),
    killSwitch: killSwitchActive(),
    tradingPaused: tradingPaused(),
    canTradeLive: tradingEnabled() && !killSwitchActive() && hasCredentials(),
    liveScope: (() => { const s = liveScopeSources(); return s ? [...s] : "all"; })(),
    liveMaxContracts: liveMaxContracts(),
  };
}

module.exports = {
  getExchangeStatus, getMarkets, getEvents, getMarket, getOrderbook, getSeries,
  getBalance, getPositions, getOrders, getFills,
  placeOrder, cancelOrder, getConnection,
  hasCredentials, killSwitchActive, tradingEnabled, tradingPaused,
};
