/**
 * Yahoo Finance market-data provider (keyless, Node-native)
 *
 * Why this exists: the trader dashboard's charts/prices were fed by a Python
 * subprocess (cli.py → Alpaca). Each call paid ~8.7s just to `import agents`
 * (which constructs an Alpaca client at import time and *fails* without keys),
 * so every poll blew the 7s budget and the charts never populated. This module
 * fetches the same data — OHLCV bars + latest price/prev-close — directly from
 * Yahoo's public chart endpoint in ~200-600ms, with no API key, and caches it
 * so the page's 5s/15s pollers hit warm data instead of the network.
 *
 * Used by trader-agent.js for getWatchlistPrices / getBars / getBarsMulti.
 * Order placement + broker account still go through Alpaca (Python).
 */

const https = require('https');

// Per-timeframe Yahoo {interval, range}. `agg` aggregates N base bars into one
// (Yahoo has no native 4h, so we roll up 4×60m). Ranges are widened well past
// the visible window so charts have deep history to pan/zoom into — the client
// shows a modest default window and reveals more bars as you zoom in. Ranges
// respect Yahoo's per-interval history limits (1m≤7d, 5m/15m≤60d, 60m≤730d).
const TF = {
  '1m':  { interval: '1m',  range: '5d',  agg: 1 },
  '5m':  { interval: '5m',  range: '1mo', agg: 1 },
  '15m': { interval: '15m', range: '1mo', agg: 1 },
  '1h':  { interval: '60m', range: '6mo', agg: 1 },
  '4h':  { interval: '60m', range: '1y',  agg: 4 },
  '1d':  { interval: '1d',  range: '10y', agg: 1 },  // deep enough for the 5Y range and a real "All"
  '1w':  { interval: '1wk', range: '10y', agg: 1 },  // weekly candles for multi-year views
  '1mo': { interval: '1mo', range: 'max', agg: 1 },  // monthly candles across full history
};
// Deep history for zoom/pan (the client windows it). 2600 covers ~10y of daily bars so
// the "All" range shows a decade of history (Yahoo drops daily→monthly past ~10y, so 10y
// is the deepest useful daily window). Each timeframe is still bounded by its own Yahoo
// `range` above, so intraday frames don't balloon.
const MAX_BARS = 2600;
const QUOTE_TTL = 20000;       // 20s — card prices
const BARS_TTL = 45000;        // 45s — chart bars
const FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT = 8000;

// Crypto bases on the default watchlist (BTCUSD → BTC-USD for Yahoo). An
// explicit set avoids misclassifying a USD-suffixed equity as crypto.
const CRYPTO_BASES = new Set([
  'BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'LTC', 'BCH', 'AVAX', 'MATIC',
  'DOT', 'LINK', 'UNI', 'ATOM', 'SHIB', 'TRX', 'XLM', 'ALGO', 'NEAR', 'APT',
]);

function cryptoBase(ticker) {
  const m = String(ticker || '').toUpperCase().match(/^([A-Z]{2,6})USD$/);
  return m && CRYPTO_BASES.has(m[1]) ? m[1] : null;
}
function isCrypto(ticker) {
  return cryptoBase(ticker) != null;
}
function tickerToYahoo(ticker) {
  const base = cryptoBase(ticker);
  return base ? `${base}-USD` : String(ticker || '').toUpperCase();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (KeystoneTrader)', Accept: 'application/json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('bad JSON from Yahoo'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error('Yahoo request timeout'));
    });
  });
}

/**
 * The most recent traded print INCLUDING pre-market / after-hours.
 *
 * `meta.regularMarketPrice` freezes at the 16:00 close, so during extended hours the
 * quoted price disagreed with the chart — the bars already carry pre/post prints
 * (includePrePost=true) while the price field did not (measured 2026-07-27 17:46 ET:
 * last bar 739.47 vs regularMarketPrice 739.09 on SPY). Prefer Yahoo's explicit
 * post/pre fields when present, else the last non-null close from the intraday
 * series, else the regular close. Returns { price, session }.
 */
function latestPrint(result) {
  const meta = (result && result.meta) || {};
  const reg = Number(meta.regularMarketPrice) || 0;
  const post = Number(meta.postMarketPrice) || 0;
  const pre = Number(meta.preMarketPrice) || 0;
  if (post > 0) return { price: post, session: 'post' };
  if (pre > 0) return { price: pre, session: 'pre' };
  // Fall back to the series: Yahoo often leaves post/preMarketPrice null even when
  // extended-hours BARS exist, so the last bar is the only honest latest print.
  try {
    const ts = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = q.close || [];
    const regEnd = Number(meta.currentTradingPeriod && meta.currentTradingPeriod.regular && meta.currentTradingPeriod.regular.end) || 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = Number(closes[i]);
      if (Number.isFinite(c) && c > 0) {
        const extended = regEnd > 0 && Number(ts[i]) > regEnd;
        if (!extended && reg > 0) return { price: reg, session: 'regular' };
        return { price: c, session: extended ? 'extended' : 'regular' };
      }
    }
  } catch (_e) { /* fall through to the regular close */ }
  return { price: reg, session: 'regular' };
}

async function fetchChart(ticker, interval, range) {
  const sym = encodeURIComponent(tickerToYahoo(ticker));
  // includePrePost=true adds pre-market (04:00–09:30) and after-hours (16:00–20:00)
  // bars to intraday charts. It's a no-op for daily+ intervals (no intraday sessions).
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&includePrePost=true`;
  const j = await httpsGetJson(url);
  const result = j && j.chart && Array.isArray(j.chart.result) && j.chart.result[0];
  if (!result) throw new Error('no chart result');
  return result;
}

// Roll up `agg` consecutive bars into one (for 4h from 60m).
function aggregate(bars, agg) {
  if (agg <= 1) return bars;
  const out = [];
  for (let i = 0; i < bars.length; i += agg) {
    const chunk = bars.slice(i, i + agg);
    if (!chunk.length) continue;
    out.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + (b.volume || 0), 0),
    });
  }
  return out;
}

function parseBars(result, agg) {
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i];
    const h = q.high && q.high[i];
    const l = q.low && q.low[i];
    const c = q.close && q.close[i];
    if (c == null || o == null || h == null || l == null) continue; // skip gap bars
    bars.push({
      timestamp: new Date(ts[i] * 1000).toISOString(),
      open: +o, high: +h, low: +l, close: +c,
      volume: q.volume && q.volume[i] != null ? +q.volume[i] : 0,
    });
  }
  // Drop Yahoo's synthetic trailing placeholder — at session end it appends a
  // zero-volume bar whose O==H==L==C (the latest price), which renders as a
  // misleading flat doji and skews the candle/line tail. Strip it for accuracy.
  if (bars.length > 1) {
    const t = bars[bars.length - 1];
    if ((t.volume || 0) === 0 && t.open === t.high && t.high === t.low && t.low === t.close) {
      bars.pop();
    }
  }
  const rolled = aggregate(bars, agg);
  return rolled.slice(-MAX_BARS);
}

// ── Concurrency-limited map ──────────────────────────────────────────────────
async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Cache ────────────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(key, ttl) {
  const e = _cache.get(key);
  if (e && Date.now() - e.time < ttl) return e.data;
  return null;
}
function cacheSet(key, data) {
  _cache.set(key, { data, time: Date.now() });
}

// ── Earnings surprise (Tier-2: actual EPS vs consensus) ─────────────────────
// Yahoo's quoteSummary now needs a cookie+crumb; fetch once and reuse. Keyless.
let _crumb = null; // { crumb, cookie, time }
function _rawGet(url, headers) {
  return new Promise((resolve) => {
    const req = https.request(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', Accept: 'application/json,*/*', ...(headers || {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy());
    req.end();
  });
}
async function _getCrumb(force) {
  if (!force && _crumb && Date.now() - _crumb.time < 6 * 3600 * 1000) return _crumb;
  const c1 = await _rawGet('https://fc.yahoo.com/');
  const cookie = ((c1.headers && c1.headers['set-cookie']) || []).map((s) => s.split(';')[0]).join('; ');
  if (!cookie) return null;
  const cr = await _rawGet('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie });
  if (cr.status !== 200 || !cr.body || /[<{]/.test(cr.body)) return null;
  _crumb = { crumb: cr.body.trim(), cookie, time: Date.now() };
  return _crumb;
}

/**
 * Latest reported earnings surprise for a US equity (keyless Yahoo quoteSummary).
 * Returns { surprisePct, epsActual, epsEstimate, quarter } or null. surprisePct is
 * signed (%): + = beat, − = miss. Cached 6h (earnings are quarterly). Framework
 * Step 3 — "the beat/miss vs expectations matters more than the headline itself."
 */
async function getEarningsSurprise(ticker) {
  const sym = tickerToYahoo(ticker);
  if (isCrypto(ticker) || !/^[A-Z.]{1,6}$/.test(sym)) return null;
  const key = `earn_${sym}`;
  const hit = cacheGet(key, 6 * 3600 * 1000);
  if (hit !== null) return hit;
  const doFetch = async (retry) => {
    const cr = await _getCrumb(retry);
    if (!cr) return null;
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=earningsHistory&crumb=${encodeURIComponent(cr.crumb)}`;
    const r = await _rawGet(url, { Cookie: cr.cookie });
    if (r.status === 401 && !retry) return doFetch(true); // stale crumb → refresh once
    if (r.status !== 200) return null;
    try {
      const hist = JSON.parse(r.body).quoteSummary.result[0].earningsHistory.history;
      const rows = (hist || []).filter((h) => h && h.epsActual && h.epsEstimate);
      const last = rows[rows.length - 1]; // most recent quarter
      if (!last) return null;
      const act = last.epsActual.raw, est = last.epsEstimate.raw;
      const surprisePct = last.surprisePercent && last.surprisePercent.raw != null
        ? last.surprisePercent.raw * 100
        : (est ? ((act - est) / Math.abs(est)) * 100 : 0);
      return { surprisePct: round(surprisePct, 1), epsActual: act, epsEstimate: est, quarter: (last.quarter && last.quarter.fmt) || null };
    } catch (_e) { return null; }
  };
  let out = null;
  try { out = await doFetch(false); } catch (_e) { out = null; }
  cacheSet(key, out); // cache null too (avoid hammering on a symbol with no data)
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Latest price + % change for each ticker.
 * Returns: [{ ticker, price, chg_pct, is_crypto }]
 */
async function getQuotes(tickers) {
  const list = Array.isArray(tickers) ? tickers : [];
  const key = 'q:' + list.join(',');
  const hit = cacheGet(key, QUOTE_TTL);
  if (hit) return hit;

  const rows = await pmap(list, FETCH_CONCURRENCY, async (ticker) => {
    try {
      // Range '1d' (not '5d') so chartPreviousClose is YESTERDAY's close → a true DAY %
      // change. With '5d', chartPreviousClose was the close ~5 sessions back, so the
      // watchlist showed a multi-day move (AAPL "+7.42%") mislabeled as the day's %.
      // 5m intraday (not 1d): includePrePost only adds pre/after-hours bars to an
      // INTRADAY series, and Yahoo leaves meta.post/preMarketPrice null — so a daily
      // interval can never see an extended-hours print. 5m keeps the payload small
      // while still tracking extended moves within 5 minutes; chartPreviousClose
      // still resolves to yesterday's close on range=1d, so the day % stays correct.
      const result = await fetchChart(ticker, '5m', '1d');
      const meta = result.meta || {};
      // Latest print INCLUDING pre/after-hours — the chart already draws those bars,
      // so the price beside it must not stay frozen at the 16:00 close.
      const { price, session } = latestPrint(result);
      const prev = Number(meta.chartPreviousClose || meta.previousClose) || 0;
      const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      return { ticker, price: round(price, 4), chg_pct: round(chg, 2), session, is_crypto: isCrypto(ticker) };
    } catch (e) {
      return { ticker, price: 0, chg_pct: 0, is_crypto: isCrypto(ticker) };
    }
  });
  cacheSet(key, rows);
  return rows;
}

/**
 * OHLCV bars for one ticker at a timeframe.
 * Returns: { bars: [...], ticker, timeframe, count }
 */
const _barArchive = require('./bar-archive');

async function getBars(ticker, timeframe = '5m') {
  const tf = TF[timeframe] || TF['5m'];
  const key = `b:${ticker}:${timeframe}`;
  const hit = cacheGet(key, BARS_TTL);
  if (hit) return hit;
  try {
    const result = await fetchChart(ticker, tf.interval, tf.range);
    const bars = parseBars(result, tf.agg);
    _barArchive.archive(ticker, timeframe, bars);   // Observe: grow the intraday corpus (fail-soft)
    const out = { bars, ticker, timeframe, count: bars.length };
    cacheSet(key, out);
    return out;
  } catch (e) {
    return { bars: [], ticker, timeframe, count: 0, error: e.message };
  }
}

/**
 * OHLCV bars for many tickers at one timeframe.
 * Returns: { bars: { TICKER: { bars: [...], count } }, timeframe }
 */
async function getBarsMulti(tickers, timeframe = '5m') {
  const list = Array.isArray(tickers) ? tickers : [];
  const key = `bm:${timeframe}:${list.join(',')}`;
  const hit = cacheGet(key, BARS_TTL);
  if (hit) return hit;

  const tf = TF[timeframe] || TF['5m'];
  const results = await pmap(list, FETCH_CONCURRENCY, async (ticker) => {
    try {
      const result = await fetchChart(ticker, tf.interval, tf.range);
      const bars = parseBars(result, tf.agg);
      _barArchive.archive(ticker, timeframe, bars); // Observe: grow the intraday corpus (fail-soft)
      return { ticker, bars };
    } catch (e) {
      return { ticker, bars: [] };
    }
  });

  const bars = {};
  for (const r of results) {
    if (r && r.ticker) bars[r.ticker] = { bars: r.bars || [], count: (r.bars || []).length };
  }
  const out = { bars, timeframe };
  cacheSet(key, out);
  return out;
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// Is the US equity session open right now? (Mon–Fri, 09:30–16:00 America/New_York.)
// DST-correct via Intl; does NOT account for market holidays — good enough to
// avoid the 7s Python/Alpaca clock call that used to hang the header (#1860).
function isUsEquityMarketOpen() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
      minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const wd = get('weekday');
    if (wd === 'Sat' || wd === 'Sun') return false;
    const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
    return mins >= 570 && mins < 960; // 09:30 (570) .. 16:00 (960) ET
  } catch (e) {
    return false;
  }
}

/**
 * Per-ticker returns/volume/technicals from keyless Yahoo daily bars — the single
 * source of truth for the `/api/trading/symbol-stats` route AND the `trader_quote`
 * tool's direct fallback (so a quote resolves whether or not a co-located server is
 * up). Pure over getBars; no server/broker state. Returns { ticker, price, returns,
 * volume, avgVolume, technical, bullCount, sma20, sma50, available }.
 */
async function getSymbolStats(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return { ticker: t, returns: {}, available: false };
  const data = await getBars(t, '1d');
  const bars = (data && Array.isArray(data.bars)) ? data.bars : [];
  if (bars.length < 2) return { ticker: t, returns: {}, available: false };
  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  const retOver = (n) => { if (bars.length <= n) return null; const p0 = closes[bars.length - 1 - n]; return p0 ? +(((price - p0) / p0) * 100).toFixed(2) : null; };
  const yr = new Date().getUTCFullYear();
  const yi = bars.findIndex((b) => new Date(b.timestamp).getUTCFullYear() === yr);
  const ytd = yi >= 0 && closes[yi] ? +(((price - closes[yi]) / closes[yi]) * 100).toFixed(2) : null;
  const avgVol = Math.round(bars.slice(-30).reduce((s, b) => s + (b.volume || 0), 0) / Math.min(30, bars.length));
  const sma = (n) => { const sl = closes.slice(-Math.min(n, closes.length)); return sl.reduce((s, c) => s + c, 0) / sl.length; };
  const s20 = sma(20), s50 = sma(50), s200 = sma(200);
  const bull = [s20, s50, s200].filter((s) => price > s).length;
  const technical = bull >= 3 ? 'Strong Buy' : bull === 2 ? 'Buy' : bull === 1 ? 'Sell' : 'Strong Sell';
  return {
    ticker: t, price,
    returns: { '1M': retOver(21), '3M': retOver(63), YTD: ytd, '1Y': retOver(252), '3Y': retOver(756) },
    volume: bars[bars.length - 1].volume, avgVolume: avgVol,
    technical, bullCount: bull,
    sma20: +s20.toFixed(2), sma50: +s50.toFixed(2),
    available: true,
  };
}

/**
 * Keyless market status — VIX + regime + SPY trend + session open, straight from
 * Yahoo. Replaces the Python→Alpaca `get_market_status` call that hit the 7s
 * timeout and left the header's VIX/Market stuck at "—" (#1860). Broker-only
 * fields (equity, day P&L) are NOT here — they come from getPositions.
 * Returns: { market_open, vix, vix_regime, market, spy_1d, spy_5d, available, source, timestamp }
 */
async function getMarketStatus() {
  const key = 'market_status';
  const hit = cacheGet(key, QUOTE_TTL);
  if (hit) return hit;

  let vix = 0, spy_1d = 0, spy_5d = 0, gotData = false;
  try {
    const vres = await fetchChart('^VIX', '1d', '5d');
    vix = Number(vres.meta && vres.meta.regularMarketPrice) || 0;
    if (vix > 0) gotData = true;
  } catch (e) { /* fall through — VIX optional */ }
  try {
    const sres = await fetchChart('SPY', '1d', '1mo');
    const bars = parseBars(sres, 1);
    if (bars.length >= 2) {
      const last = bars[bars.length - 1].close;
      const prev = bars[bars.length - 2].close;
      const first5 = bars[Math.max(0, bars.length - 6)].close;
      if (prev > 0) spy_1d = ((last - prev) / prev) * 100;
      if (first5 > 0) spy_5d = ((last - first5) / first5) * 100;
      gotData = true;
    }
  } catch (e) { /* fall through — SPY optional */ }

  const vix_regime = vix <= 0 ? 'UNKNOWN'
    : vix < 20 ? 'CALM' : vix < 30 ? 'ELEVATED' : vix < 40 ? 'HIGH' : 'EXTREME';
  const market = spy_1d > 0.1 ? 'BULLISH' : spy_1d < -0.1 ? 'BEARISH' : 'NEUTRAL';

  const out = {
    market_open: isUsEquityMarketOpen(),
    vix: round(vix, 2),
    vix_regime,
    market,
    spy_1d: round(spy_1d, 2),
    spy_5d: round(spy_5d, 2),
    available: gotData,
    source: 'yahoo',
    timestamp: new Date().toISOString(),
  };
  if (gotData) cacheSet(key, out);
  return out;
}

/**
 * Keyless symbol validation — a live Yahoo quote probe. Replaces the Python
 * Alpaca-asset lookup that timed out at 7s, breaking "+ Add symbol" search and
 * validation (#1859/#1860). A ticker with a positive Yahoo price is treated as
 * valid + tradable.
 * Returns: { valid, tradable, symbol, name, exchange, asset_class, price?, reason }
 */
async function validateSymbol(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t || !/^[\^A-Z0-9.\-/]{1,12}$/.test(t)) {
    return { valid: false, tradable: false, symbol: t, reason: 'invalid format' };
  }
  try {
    const res = await fetchChart(t, '1d', '5d');
    const meta = res.meta || {};
    const price = Number(meta.regularMarketPrice) || 0;
    if (price > 0) {
      return {
        valid: true, tradable: true, symbol: t,
        name: meta.shortName || meta.longName || t,
        exchange: meta.fullExchangeName || meta.exchangeName || '',
        asset_class: isCrypto(t) ? 'crypto' : 'us_equity',
        price: round(price, 4),
        reason: '',
      };
    }
    return { valid: false, tradable: false, symbol: t, reason: 'no market data' };
  } catch (e) {
    return { valid: false, tradable: false, symbol: t, reason: 'not a known symbol' };
  }
}

/**
 * Yahoo-summary fundamentals for the focused single-symbol view (#2412) — the
 * fields the Yahoo Finance quote page shows above the fold: previous close /
 * open, day + 52-week range, bid/ask, market cap, beta, P/E, EPS, dividend
 * yield, and the mean analyst target. Keyless quoteSummary (same cookie+crumb
 * path as getEarningsSurprise), cached 10 min. Returns null for crypto / on any
 * failure so the caller degrades to what it already has. Every value is a plain
 * number|string|null — no Yahoo {raw,fmt} wrappers leak to the client.
 */
async function getQuoteSummary(ticker) {
  const sym = tickerToYahoo(ticker);
  if (isCrypto(ticker) || !/^[A-Z.]{1,6}$/.test(sym)) return null;
  const key = `qs_${sym}`;
  const hit = cacheGet(key, 10 * 60 * 1000);
  if (hit !== null) return hit;
  const raw = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : (typeof v === 'number' ? v : null));
  const doFetch = async (retry) => {
    const cr = await _getCrumb(retry);
    if (!cr) return null;
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}&crumb=${encodeURIComponent(cr.crumb)}`;
    const r = await _rawGet(url, { Cookie: cr.cookie });
    if (r.status === 401 && !retry) return doFetch(true); // stale crumb → refresh once
    if (r.status !== 200) return null;
    let result;
    try { result = JSON.parse(r.body).quoteSummary.result[0]; } catch (_e) { return null; }
    if (!result) return null;
    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};
    const dy = raw(sd.dividendYield);
    return {
      ticker,
      previousClose: raw(sd.previousClose),
      open: raw(sd.open),
      dayLow: raw(sd.dayLow),
      dayHigh: raw(sd.dayHigh),
      bid: raw(sd.bid),
      ask: raw(sd.ask),
      fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
      fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
      marketCap: raw(sd.marketCap),
      beta: raw(sd.beta),
      trailingPE: raw(sd.trailingPE),
      forwardPE: raw(sd.forwardPE),
      eps: raw(ks.trailingEps),
      dividendYield: dy != null ? round(dy * 100, 2) : null,
      targetMeanPrice: raw(fd.targetMeanPrice),
      available: true,
    };
  };
  let out = null;
  try { out = await doFetch(false); } catch (_e) { out = null; }
  cacheSet(key, out); // cache null too — avoid hammering symbols with no summary
  return out;
}

module.exports = {
  getQuotes, getBars, getBarsMulti, getMarketStatus, getSymbolStats, validateSymbol,
  getEarningsSurprise, getQuoteSummary,
  isCrypto, tickerToYahoo, isUsEquityMarketOpen, _TF: TF,
};
