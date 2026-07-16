"use strict";
/**
 * options-data.js — options-chain / implied-volatility PROVIDER CHAIN.
 *
 * Loop stage: Observe. Pure DATA layer: fetches and normalizes listed-options
 * chains (strikes, bid/ask, volume, open interest, IV, greeks) so downstream
 * Reason-stage code has real market evidence to work from. It never places
 * orders, never scores trades, and never recommends anything.
 *
 * NO NEW KEYS (operator direction): providers are tried in order and every
 * result carries `source` so the evidence trail is explicit:
 *
 *   1. "alpaca"       — the user's OWN connected Alpaca account (ADR-0027
 *                       per-user OAuth via lib/alpaca-credentials.js, or the
 *                       operator's existing server keys). Options snapshots
 *                       (indicative feed) carry quotes, IV, and REAL greeks.
 *   2. "yahoo"        — keyless public chain (cookie+crumb handshake, then
 *                       v7/finance/options). Carries the underlying price and
 *                       quotes/IV but NO greeks; a Black–Scholes delta is
 *                       computed from Yahoo's own IV for SELECTION only and is
 *                       labeled `delta_source: "model(bs-from-iv)"` — never
 *                       passed off as provider data.
 *   3. "alphavantage" — last resort, used ONLY if ALPHAVANTAGE_API_KEY already
 *                       happens to be configured. Also the only provider that
 *                       serves dated HISTORICAL sessions ({ date }).
 *
 * HONEST DEGRADATION (Σ₀ External Reality Rule): each provider failure is
 * collected with its reason; when all fail the caller gets
 * { available: false, reason: "<provider>: <why>; …" }. This module never
 * throws at a caller and NEVER fabricates data. Fields a provider does not
 * carry (greeks, OI) stay absent/null — never invented. Provider-supplied
 * greeks are labeled `delta_source: "provider"`.
 *
 * MANNERS: one 15-minute in-memory chain cache per symbol+date; the Yahoo
 * cookie+crumb pair is cached ~30 minutes (refreshed once on 401/403); Yahoo
 * per-expiry pagination is capped; the Alpha Vantage path keeps its rolling
 * 5-requests/min limiter (that tier's ceiling).
 *
 * Normalized row shape (unchanged — the strategies engine depends on it):
 *   { contract, underlying, type: "call"|"put", strike, expiration: "YYYY-MM-DD",
 *     date, bid, ask, last, mark, volume, open_interest, implied_volatility,
 *     delta?, gamma?, theta?, vega?, rho?, delta_source? }
 */

const https = require("https");

const AV_HOST = "www.alphavantage.co";
const CACHE_TTL_MS = 15 * 60 * 1000;  // 15-minute chain cache
const RATE_MAX_PER_WINDOW = 5;        // Alpha Vantage free tier: 5 req/min
const RATE_WINDOW_MS = 60 * 1000;
const YAHOO_SESSION_TTL_MS = 30 * 60 * 1000; // cookie+crumb cache
const YAHOO_MAX_EXPIRY_FETCHES = 5;   // extra per-expiry chain requests beyond the first
const YAHOO_DEFAULT_HORIZON_DAYS = 70; // fetch expirations out to ~this many days
const ALPACA_MAX_PAGES = 5;           // snapshot pagination cap (1000 contracts/page)
const DAY_MS = 24 * 60 * 60 * 1000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const _cache = new Map(); // `${SYM}|${date||"latest"}` → { at, result }
let _requestLog = [];     // epoch-ms of recent AV upstream requests (rolling window)
let _yahooSession = { cookie: null, crumb: null, at: 0 };

function _apiKey() {
  return String(process.env.ALPHAVANTAGE_API_KEY || "").trim();
}

// ── transport ────────────────────────────────────────────────────────────────
// One raw seam for everything: fetchFn(url, { headers, timeoutMs }) →
// { status, headers, body }. Tests replace it with URL-routed fixtures.

function _getRaw(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

// ── shared normalization helpers ─────────────────────────────────────────────

function _num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _isoFromEpochSeconds(e) {
  const n = _num(e);
  if (n === null) return null;
  try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (_e) { return null; }
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26) — deterministic, no deps.
function _normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black–Scholes delta from a provider's OWN implied volatility (r = 0 — a
 * labeled selection proxy, not a pricing claim). Null when the inputs can't
 * support it; never invented.
 */
function _bsDelta({ S, K, T, iv, type }) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(iv > 0.0001)) return null;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  if (!Number.isFinite(d1)) return null;
  const nd1 = _normCdf(d1);
  return type === "put" ? nd1 - 1 : nd1;
}

// ── Alpha Vantage rate limiting (rolling 60s window, refuse honestly) ────────

function _rateGate(now) {
  _requestLog = _requestLog.filter((t) => now - t < RATE_WINDOW_MS);
  if (_requestLog.length < RATE_MAX_PER_WINDOW) {
    _requestLog.push(now);
    return null;
  }
  const retryAfterS = Math.max(1, Math.ceil((_requestLog[0] + RATE_WINDOW_MS - now) / 1000));
  return {
    reason: `rate limited (${RATE_MAX_PER_WINDOW} requests/min on this tier); retry in ~${retryAfterS}s`,
    retry_after_s: retryAfterS,
  };
}

// ── provider 3 (last resort): Alpha Vantage HISTORICAL_OPTIONS ───────────────

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
  let hasDelta = false;
  for (const g of ["delta", "gamma", "theta", "vega", "rho"]) {
    const v = _num(r[g]);
    if (v !== null) { row[g] = v; if (g === "delta") hasDelta = true; }
  }
  if (hasDelta) row.delta_source = "provider";
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

async function _fetchAlphaVantage(sym, date, fetchFn) {
  const key = _apiKey();
  if (!key) return { ok: false, reason: "ALPHAVANTAGE_API_KEY not configured" };
  const refused = _rateGate(Date.now());
  if (refused) return { ok: false, reason: refused.reason, retry_after_s: refused.retry_after_s };

  let qs = `function=HISTORICAL_OPTIONS&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`;
  if (date) qs += `&date=${date}`;
  let payload;
  try {
    const r = await fetchFn(`https://${AV_HOST}/query?${qs}`, {
      headers: { "User-Agent": "Mozilla/5.0 (KeystoneOptionsData)" },
    });
    if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
    payload = JSON.parse(r.body);
  } catch (e) {
    return { ok: false, reason: `request failed (${e.message})` };
  }
  const parsed = _parseChain(payload);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, rows: parsed.rows, underlyingPrice: null };
}

// ── provider 1: Alpaca (existing per-user OAuth / server keys — ADR-0027) ────

// OCC option symbol: root (≤6 alnum/dot) + YYMMDD + C/P + strike×1000 (8 digits).
const OCC_RE = /^([A-Z0-9.]{1,6})(\d{6})([CP])(\d{8})$/;

/**
 * Alpaca v1beta1 options snapshots payload → { ok, rows, nextPageToken }.
 * Exported for offline tests. Greeks come straight from the feed and are
 * labeled delta_source: "provider".
 */
function _parseAlpacaSnapshots(payload, sym) {
  if (!payload || typeof payload !== "object" || !payload.snapshots || typeof payload.snapshots !== "object") {
    return { ok: false, reason: "malformed Alpaca snapshots payload (no snapshots object)" };
  }
  const rows = [];
  for (const [occ, snap] of Object.entries(payload.snapshots)) {
    const m = String(occ || "").trim().match(OCC_RE);
    if (!m || !snap || typeof snap !== "object") continue;
    const ymd = m[2];
    const cp = m[3];
    const strike = Number(m[4]) / 1000;
    if (!Number.isFinite(strike)) continue;
    const q = snap.latestQuote || {};
    const bid = _num(q.bp);
    const ask = _num(q.ap);
    const t = q.t || (snap.latestTrade && snap.latestTrade.t) || null;
    const row = {
      contract: String(occ).trim(),
      underlying: sym,
      type: cp === "C" ? "call" : "put",
      strike,
      expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
      date: t ? String(t).slice(0, 10) : null,
      bid,
      ask,
      last: _num(snap.latestTrade && snap.latestTrade.p),
      mark: bid !== null && ask !== null ? (bid + ask) / 2 : null,
      volume: _num(snap.dailyBar && snap.dailyBar.v),
      open_interest: _num(snap.openInterest !== undefined ? snap.openInterest : snap.open_interest),
      implied_volatility: _num(snap.impliedVolatility !== undefined ? snap.impliedVolatility : snap.iv),
    };
    const greeks = snap.greeks || {};
    let hasDelta = false;
    for (const g of ["delta", "gamma", "theta", "vega", "rho"]) {
      const v = _num(greeks[g]);
      if (v !== null) { row[g] = v; if (g === "delta") hasDelta = true; }
    }
    if (hasDelta) row.delta_source = "provider";
    rows.push(row);
  }
  if (Object.keys(payload.snapshots).length > 0 && rows.length === 0) {
    return { ok: false, reason: "no parseable contract rows in Alpaca snapshots" };
  }
  return { ok: true, rows, nextPageToken: payload.next_page_token || null };
}

/** Default Alpaca auth: the same per-user resolution the broker routes use
 *  (user's own OAuth token first, else the operator's existing server keys). */
function _defaultAlpacaAuth(userId) {
  try {
    return require("./alpaca-adapter")._authFor(userId == null ? "" : userId);
  } catch (_e) {
    return null;
  }
}

async function _fetchAlpacaChain(sym, auth, fetchFn) {
  try {
    const rows = [];
    let pageToken = null;
    let pages = 0;
    do {
      const url =
        `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(sym)}` +
        `?feed=indicative&limit=1000` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
      const r = await fetchFn(url, { headers: { ...auth.headers, Accept: "application/json" } });
      if (r.status === 401 || r.status === 403) {
        return { ok: false, reason: `auth rejected (HTTP ${r.status}) — the connected Alpaca account may lack options market-data access` };
      }
      if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
      let payload;
      try { payload = JSON.parse(r.body); } catch (_e) { return { ok: false, reason: "bad JSON from Alpaca snapshots" }; }
      const parsed = _parseAlpacaSnapshots(payload, sym);
      if (!parsed.ok) {
        if (pages === 0) return { ok: false, reason: parsed.reason };
        break; // keep what earlier pages yielded
      }
      rows.push(...parsed.rows);
      pageToken = parsed.nextPageToken;
      pages++;
    } while (pageToken && pages < ALPACA_MAX_PAGES);
    if (!rows.length) return { ok: false, reason: "no option contracts in Alpaca snapshots" };
    return { ok: true, rows, underlyingPrice: null, session: rows[0].date };
  } catch (e) {
    return { ok: false, reason: `request failed (${e.message})` };
  }
}

// ── provider 2: Yahoo (keyless cookie+crumb; NO greeks — BS delta labeled) ───

async function _yahooHandshake(fetchFn, force = false) {
  if (!force && _yahooSession.cookie && _yahooSession.crumb &&
      Date.now() - _yahooSession.at < YAHOO_SESSION_TTL_MS) {
    return _yahooSession;
  }
  // Any fc.yahoo.com response (it's a 404) carries the session Set-Cookie.
  const c = await fetchFn("https://fc.yahoo.com/", { headers: { "User-Agent": BROWSER_UA }, timeoutMs: 10000 });
  const setCookie = c && c.headers ? c.headers["set-cookie"] : null;
  const parts = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = parts.map((s) => String(s).split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("no Set-Cookie from fc.yahoo.com");
  const cr = await fetchFn("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie }, timeoutMs: 10000,
  });
  const crumb = cr && cr.status === 200 ? String(cr.body || "").trim() : "";
  if (!crumb || crumb.length > 64 || /[{<>]/.test(crumb)) {
    throw new Error(`crumb handshake failed (HTTP ${cr ? cr.status : "?"})`);
  }
  _yahooSession = { cookie, crumb, at: Date.now() };
  return _yahooSession;
}

/**
 * One Yahoo v7 options payload → { ok, rows, underlyingPrice, session,
 * expirationDates, fetchedExpiration } | { ok: false, reason }. Exported for
 * offline tests. Yahoo carries NO greeks: a Black–Scholes delta is computed
 * from Yahoo's OWN implied volatility purely for strike selection and labeled
 * delta_source: "model(bs-from-iv)" — the other greeks stay absent.
 */
function _parseYahooChain(payload, opts = {}) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed Yahoo payload (not a JSON object)" };
  }
  const oc = payload.optionChain;
  if (!oc || !Array.isArray(oc.result)) {
    return { ok: false, reason: "malformed Yahoo payload (no optionChain.result)" };
  }
  if (oc.error) {
    return { ok: false, reason: `Yahoo: ${oc.error.description || oc.error.code || JSON.stringify(oc.error)}` };
  }
  const r0 = oc.result[0];
  if (!r0) return { ok: false, reason: "Yahoo returned an empty optionChain result (symbol may not be optionable)" };

  const quote = r0.quote || {};
  const sym = String(r0.underlyingSymbol || quote.symbol || "").toUpperCase() || null;
  const underlyingPrice = _num(quote.regularMarketPrice);
  const session = _isoFromEpochSeconds(quote.regularMarketTime);
  const nowMs = opts.now !== undefined ? Number(opts.now) || Date.now() : Date.now();

  const rows = [];
  const block = Array.isArray(r0.options) ? r0.options[0] : null;
  const takeSide = (list, type) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== "object") continue;
      const contract = String(c.contractSymbol || "").trim();
      const strike = _num(c.strike);
      if (!contract || strike === null) continue;
      const bid = _num(c.bid);
      const ask = _num(c.ask);
      const iv = _num(c.impliedVolatility);
      const row = {
        contract,
        underlying: sym,
        type,
        strike,
        expiration: _isoFromEpochSeconds(c.expiration),
        date: session,
        bid,
        ask,
        last: _num(c.lastPrice),
        mark: bid !== null && ask !== null ? (bid + ask) / 2 : null,
        volume: _num(c.volume),
        open_interest: _num(c.openInterest),
        implied_volatility: iv,
      };
      // Yahoo has NO greeks. BS delta from Yahoo's own IV, for selection only.
      const expEpoch = _num(c.expiration);
      const T = expEpoch !== null ? (expEpoch * 1000 - nowMs) / (365 * DAY_MS) : null;
      const delta = _bsDelta({ S: underlyingPrice, K: strike, T, iv, type });
      if (delta !== null) {
        row.delta = delta;
        row.delta_source = "model(bs-from-iv)";
      }
      rows.push(row);
    }
  };
  if (block) {
    takeSide(block.calls, "call");
    takeSide(block.puts, "put");
  }
  return {
    ok: true,
    rows,
    underlyingPrice,
    session,
    expirationDates: Array.isArray(r0.expirationDates) ? r0.expirationDates : [],
    fetchedExpiration: block ? _num(block.expirationDate) : null,
  };
}

async function _yahooOptionsCall(sym, dateEpoch, fetchFn) {
  let sess = await _yahooHandshake(fetchFn);
  const mkUrl = (s) =>
    `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}` +
    `?crumb=${encodeURIComponent(s.crumb)}` +
    (dateEpoch ? `&date=${dateEpoch}` : "");
  let r = await fetchFn(mkUrl(sess), { headers: { "User-Agent": BROWSER_UA, Cookie: sess.cookie } });
  if (r.status === 401 || r.status === 403) {
    // Stale cookie/crumb: refresh ONCE and retry — then take the answer as-is.
    sess = await _yahooHandshake(fetchFn, true);
    r = await fetchFn(mkUrl(sess), { headers: { "User-Agent": BROWSER_UA, Cookie: sess.cookie } });
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch (_e) { throw new Error("bad JSON from Yahoo options"); }
}

/**
 * Pick which extra expirations to fetch, capped at YAHOO_MAX_EXPIRY_FETCHES.
 * Symbols like SPY list DAILY expiries, so "first N in the horizon" would
 * cluster in the next week and starve a 21-60 DTE selection window — instead,
 * prefer expirations at/after `minDays` and spread the picks EVENLY across the
 * window when there are more candidates than the cap. Deterministic.
 */
function _pickYahooExpiries(expirationDates, fetchedExpiration, nowMs, minDays, horizonDays) {
  const dteOf = (e) => Math.ceil((e * 1000 - nowMs) / DAY_MS);
  const horizon = Number(horizonDays) > 0 ? Number(horizonDays) : YAHOO_DEFAULT_HORIZON_DAYS;
  const floor = Number(minDays) > 0 ? Number(minDays) : 0;
  const inHorizon = (Array.isArray(expirationDates) ? expirationDates : [])
    .map(Number)
    .filter((e) => Number.isFinite(e) && e !== fetchedExpiration && e * 1000 > nowMs && dteOf(e) <= horizon)
    .sort((a, b) => a - b);
  const preferred = inHorizon.filter((e) => dteOf(e) >= floor);
  const pool = preferred.length ? preferred : inHorizon;
  if (pool.length <= YAHOO_MAX_EXPIRY_FETCHES) return pool;
  const picks = [];
  for (let i = 0; i < YAHOO_MAX_EXPIRY_FETCHES; i++) {
    const idx = Math.round((i * (pool.length - 1)) / (YAHOO_MAX_EXPIRY_FETCHES - 1));
    if (!picks.includes(pool[idx])) picks.push(pool[idx]);
  }
  return picks;
}

async function _fetchYahooChain(sym, fetchFn, { minDays, horizonDays } = {}) {
  try {
    const first = _parseYahooChain(await _yahooOptionsCall(sym, null, fetchFn));
    if (!first.ok) return { ok: false, reason: first.reason };

    const rows = [...first.rows];
    const more = _pickYahooExpiries(first.expirationDates, first.fetchedExpiration, Date.now(), minDays, horizonDays);
    for (const exp of more) {
      try {
        const page = _parseYahooChain(await _yahooOptionsCall(sym, exp, fetchFn));
        if (page.ok) rows.push(...page.rows);
      } catch (_e) {
        // A missing later expiry must not sink the chain we already have.
      }
    }
    if (!rows.length) return { ok: false, reason: "Yahoo chain carried no option rows" };
    return { ok: true, rows, underlyingPrice: first.underlyingPrice, session: first.session };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * getOptionsChain(symbol, { date, userId, horizonDays, fetchFn, alpacaAuthFn })
 *
 * → { available: true, symbol, date, session, source: "alpaca"|"yahoo"|"alphavantage",
 *     cached, count, contracts, underlying_price, providers_skipped? }
 * → { available: false, reason }   (never throws)
 *
 * `date` (YYYY-MM-DD, optional): a HISTORICAL session — only Alpha Vantage can
 *   serve those, so the live providers are skipped with that reason.
 * `userId` (optional): resolves the user's connected Alpaca account exactly like
 *   the broker routes do (their OAuth token first, else operator server keys).
 * `minDays` / `horizonDays` (optional): the DTE window Yahoo expiry fetches
 *   should cover (defaults 0 / 70) — picks are spread evenly across it.
 * `fetchFn` / `alpacaAuthFn` (tests only): transport and auth seams.
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
    const fetchFn = opts.fetchFn || _getRaw;

    const cacheKey = `${sym}|${date || "latest"}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }

    const reasons = [];
    const providers = date ? ["alphavantage"] : ["alpaca", "yahoo", "alphavantage"];
    if (date) {
      reasons.push(
        "alpaca: live snapshots only — cannot serve a historical session",
        "yahoo: live chain only — cannot serve a historical session"
      );
    }

    for (const provider of providers) {
      let r;
      if (provider === "alpaca") {
        const auth = (opts.alpacaAuthFn || _defaultAlpacaAuth)(opts.userId);
        if (!auth) {
          reasons.push("alpaca: no connected Alpaca account for this user (and no server keys configured)");
          continue;
        }
        r = await _fetchAlpacaChain(sym, auth, fetchFn);
      } else if (provider === "yahoo") {
        r = await _fetchYahooChain(sym, fetchFn, { minDays: opts.minDays, horizonDays: opts.horizonDays });
      } else {
        r = await _fetchAlphaVantage(sym, date, fetchFn);
      }
      if (!r.ok) {
        reasons.push(`${provider}: ${r.reason}`);
        continue;
      }
      const result = {
        available: true,
        symbol: sym,
        date: date || null, // null = the latest chain this provider can see
        session: r.session !== undefined ? r.session : (r.rows.length ? r.rows[0].date : null),
        source: provider,
        cached: false,
        count: r.rows.length,
        contracts: r.rows,
        underlying_price: r.underlyingPrice !== undefined ? r.underlyingPrice : null,
        ...(reasons.length ? { providers_skipped: reasons } : {}),
      };
      _cache.set(cacheKey, { at: Date.now(), result });
      return result;
    }

    return { available: false, reason: reasons.join("; ") || "no options provider available" };
  } catch (e) {
    // Belt over braces: this layer NEVER throws at a caller.
    return { available: false, reason: `options data error (${e.message})` };
  }
}

/** Tests only: clear the cache, the AV rate window, and the Yahoo session. */
function _resetForTests() {
  _cache.clear();
  _requestLog = [];
  _yahooSession = { cookie: null, crumb: null, at: 0 };
}

module.exports = {
  getOptionsChain,
  _parseChain,
  _normalizeRow,
  _parseAlpacaSnapshots,
  _parseYahooChain,
  _pickYahooExpiries,
  _bsDelta,
  _resetForTests,
  CACHE_TTL_MS,
  RATE_MAX_PER_WINDOW,
  YAHOO_MAX_EXPIRY_FETCHES,
  ALPACA_MAX_PAGES,
};
