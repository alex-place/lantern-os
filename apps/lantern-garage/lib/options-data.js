"use strict";
/**
 * options-data.js — Alpha Vantage options-chain / implied-volatility client.
 *
 * Loop stage: Observe. Pure DATA layer: fetches and normalizes listed-options
 * chains (strikes, bid/ask, volume, open interest, IV, greeks) so downstream
 * Reason-stage code has real market evidence to work from. It never places
 * orders, never scores trades, and never recommends anything.
 *
 * HONEST DEGRADATION (Σ₀ External Reality Rule):
 *  - Keyed by env ALPHAVANTAGE_API_KEY. When unset, every call returns
 *    { available: false, reason: "ALPHAVANTAGE_API_KEY not configured" } —
 *    it never throws and NEVER fabricates data.
 *  - Upstream error payloads ("Error Message" / "Note" / "Information") are
 *    surfaced verbatim as { available: false, reason }, not swallowed.
 *
 * Endpoint: HISTORICAL_OPTIONS (free tier). Called without &date= it returns
 * the previous trading session's full chain — that is the "latest" chain the
 * free tier can see. With { date: "YYYY-MM-DD" } it returns that session's
 * chain (history back to 2008). The premium REALTIME_OPTIONS endpoint is
 * reachable via { realtime: true }; on a free key Alpha Vantage answers with
 * an "Information" notice, which degrades honestly like everything else.
 *
 * FREE-TIER MANNERS:
 *  - 15-minute in-memory cache per symbol+date (chains are session-granular,
 *    so 15 minutes is conservative, not stale).
 *  - Rolling-window rate limit: at most 5 upstream requests per minute
 *    (Alpha Vantage's free ceiling). Excess calls are REFUSED with an honest
 *    retry_after_s instead of queued — hammering a free API is not a feature.
 *
 * No new dependencies: plain node https, same _getJson pattern as
 * lib/portfolio-analytics.js.
 */

const https = require("https");

const AV_HOST = "www.alphavantage.co";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15-minute chain cache
const RATE_MAX_PER_WINDOW = 5;       // Alpha Vantage free tier: 5 req/min
const RATE_WINDOW_MS = 60 * 1000;

const _cache = new Map(); // `${SYM}|${date||"latest"}|${fn}` → { at, result }
let _requestLog = [];     // epoch-ms of recent upstream requests (rolling window)

function _apiKey() {
  return String(process.env.ALPHAVANTAGE_API_KEY || "").trim();
}

// ── transport (same shape as portfolio-analytics._getJson) ──────────────────

function _getJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (KeystoneOptionsData)" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (_e) { reject(new Error("bad JSON")); } });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

// ── rate limiting (rolling 60s window, refuse honestly) ─────────────────────

function _rateGate(now) {
  _requestLog = _requestLog.filter((t) => now - t < RATE_WINDOW_MS);
  if (_requestLog.length < RATE_MAX_PER_WINDOW) {
    _requestLog.push(now);
    return null;
  }
  const retryAfterS = Math.max(1, Math.ceil((_requestLog[0] + RATE_WINDOW_MS - now) / 1000));
  return {
    available: false,
    reason: `rate limited: Alpha Vantage free tier allows ${RATE_MAX_PER_WINDOW} requests/min; retry in ~${retryAfterS}s`,
    retry_after_s: retryAfterS,
  };
}

// ── normalization ────────────────────────────────────────────────────────────

function _num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One Alpha Vantage chain row (all-string fields) → normalized contract row.
 * Returns null for rows missing the identity fields (contract/strike/type).
 */
function _normalizeRow(r) {
  if (!r || typeof r !== "object") return null;
  const contract = String(r.contractID || r.contract || "").trim();
  const type = String(r.type || "").toLowerCase();
  const strike = _num(r.strike);
  if (!contract || strike === null || (type !== "call" && type !== "put")) return null;
  const row = {
    contract,
    underlying: String(r.symbol || "").toUpperCase() || null,
    type,
    strike,
    expiration: String(r.expiration || "") || null,
    date: String(r.date || "") || null, // session the quote is from
    bid: _num(r.bid),
    ask: _num(r.ask),
    last: _num(r.last),
    mark: _num(r.mark),
    volume: _num(r.volume),
    open_interest: _num(r.open_interest),
    implied_volatility: _num(r.implied_volatility),
  };
  // Greeks only when present — absent fields stay absent, never invented.
  for (const g of ["delta", "gamma", "theta", "vega", "rho"]) {
    const v = _num(r[g]);
    if (v !== null) row[g] = v;
  }
  return row;
}

/**
 * Full Alpha Vantage payload → { ok: true, rows } | { ok: false, reason }.
 * Handles the three upstream notice shapes ("Error Message" / "Note" /
 * "Information") and structurally malformed bodies. Exported for offline tests.
 */
function _parseChain(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "malformed Alpha Vantage payload (not a JSON object)" };
  }
  for (const k of ["Error Message", "Note", "Information"]) {
    if (payload[k]) return { ok: false, reason: `Alpha Vantage: ${String(payload[k])}` };
  }
  if (!Array.isArray(payload.data)) {
    return { ok: false, reason: "malformed Alpha Vantage payload (no data array)" };
  }
  const rows = [];
  for (const r of payload.data) {
    const n = _normalizeRow(r);
    if (n) rows.push(n);
  }
  if (payload.data.length > 0 && rows.length === 0) {
    return { ok: false, reason: "malformed Alpha Vantage payload (no parseable contract rows)" };
  }
  return { ok: true, rows };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * getOptionsChain(symbol, { date, realtime, fetchFn })
 *
 * → { available: true, symbol, date, session, source, cached, count, contracts }
 * → { available: false, reason, ... }   (never throws)
 *
 * `date` (YYYY-MM-DD, optional): historical session; omitted = previous session.
 * `realtime` (optional): use REALTIME_OPTIONS (premium — degrades honestly on free keys).
 * `fetchFn` (tests only): replaces the network hop.
 */
async function getOptionsChain(symbol, opts = {}) {
  try {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) {
      return { available: false, reason: `invalid symbol '${String(symbol)}'` };
    }
    const date = opts.date ? String(opts.date).trim() : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { available: false, reason: `invalid date '${date}' (expected YYYY-MM-DD)` };
    }
    const key = _apiKey();
    if (!key) {
      return { available: false, reason: "ALPHAVANTAGE_API_KEY not configured" };
    }

    const fn = opts.realtime ? "REALTIME_OPTIONS" : "HISTORICAL_OPTIONS";
    const cacheKey = `${sym}|${date || "latest"}|${fn}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }

    const refused = _rateGate(Date.now());
    if (refused) return refused;

    let qs = `function=${fn}&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`;
    if (date && fn === "HISTORICAL_OPTIONS") qs += `&date=${date}`;
    const url = `https://${AV_HOST}/query?${qs}`;

    let payload;
    try {
      payload = await (opts.fetchFn || _getJson)(url);
    } catch (e) {
      return { available: false, reason: `Alpha Vantage request failed (${e.message})` };
    }

    const parsed = _parseChain(payload);
    if (!parsed.ok) return { available: false, reason: parsed.reason };

    const result = {
      available: true,
      symbol: sym,
      date: date || null, // null = previous trading session ("latest" the tier can see)
      session: parsed.rows.length ? parsed.rows[0].date : null,
      source: `alphavantage:${fn}`,
      cached: false,
      count: parsed.rows.length,
      contracts: parsed.rows,
    };
    _cache.set(cacheKey, { at: Date.now(), result });
    return result;
  } catch (e) {
    // Belt over braces: this layer NEVER throws at a caller.
    return { available: false, reason: `options data error (${e.message})` };
  }
}

/** Tests only: clear the cache + rate-limit window. */
function _resetForTests() {
  _cache.clear();
  _requestLog = [];
}

module.exports = {
  getOptionsChain,
  _parseChain,
  _normalizeRow,
  _resetForTests,
  CACHE_TTL_MS,
  RATE_MAX_PER_WINDOW,
};
