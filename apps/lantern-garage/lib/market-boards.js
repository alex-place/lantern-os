'use strict';

/**
 * market-boards.js — the asset-class boards behind /markets.html and /market.html
 * (founder, 2026-10-11: TradingView's "market summary → see major indices → see all
 * crypto" each lead to a page of their own, for US stocks, crypto, futures, forex and
 * the economy; ours all led to the trader).
 *
 * WHAT IT IS. A named list of instruments per asset class — indices, crypto, futures,
 * forex — and the US-stock boards cut from lib/market-universe. Every list is priced with
 * Yahoo's BATCH quote: one request carries up to 50 symbols, where a chart call per row
 * would be fifty.
 *
 * WHY IT IS ITS OWN CLIENT. lib/market-data-yahoo is the ARMED trader's quote path. Its
 * cache is bounded at 200 entries (the 2026-09-28 leak fix), so a hundred board symbols
 * written into it would evict the trader's own bars and make it refetch, and its crumb is
 * shared state. This module shares nothing with it. The one thing the two do share is
 * Yahoo's patience with this host — which is why a board costs one request, and why the
 * stock boards replaced a movers route that priced its 119 names one chart call at a time.
 *
 * HONEST ABOUT ITS REACH. A curated list per class, named on the page: not every
 * contract, coin or pair, and not a screener. A row Yahoo cannot price is dropped, never
 * drawn blank. Nothing here reads an account, a ledger or the engine.
 *
 * It names itself to Yahoo as unisona.ai, in the conventional "compatible; name; +url"
 * form. (A bare product token is refused by Yahoo's cookie gate; this form is not.)
 */

const https = require('https');

// ── The boards ──────────────────────────────────────────────────────────────────
// Each row: [yahoo symbol, display name, short code, unit]. The short code is what the
// page prints beside the name (TradingView's "SPX", "CL1!"); the unit matters most on
// futures, where Yahoo prices corn in US CENTS a bushel — "479.75" with no unit reads as
// dollars, which is off by a factor of a hundred.
const CLASSES = {
  indices: {
    title: 'Indices',
    blurb: 'The major US and world stock indices, priced live.',
    lead: '^GSPC',
    summary: ['^GSPC', '^NDX', '^DJI', '^RUT', '^N225', '^FTSE', '^GDAXI', '^HSI'],
    hub: ['^GSPC', '^NDX', '^DJI', '^RUT', '^VIX', '^N225', '^FTSE', '^GDAXI'],
    groups: [
      { id: 'us', title: 'US indices', rows: [
        ['^GSPC', 'S&P 500', 'SPX'], ['^NDX', 'Nasdaq 100', 'NDX'], ['^DJI', 'Dow 30', 'DJI'],
        ['^RUT', 'Russell 2000', 'RUT'], ['^IXIC', 'Nasdaq Composite', 'IXIC'],
        ['^VIX', 'Cboe Volatility Index', 'VIX'],
      ] },
      { id: 'world', title: 'World indices', rows: [
        ['^N225', 'Japan 225', 'N225'], ['^FTSE', 'FTSE 100', 'UKX'], ['^GDAXI', 'DAX', 'DAX'],
        ['^FCHI', 'CAC 40', 'CAC'], ['^STOXX50E', 'Euro Stoxx 50', 'SX5E'], ['^HSI', 'Hang Seng', 'HSI'],
        ['000001.SS', 'SSE Composite', 'SSE'], ['^NSEI', 'Nifty 50', 'NIFTY'], ['^KS11', 'KOSPI', 'KOSPI'],
        ['^AXJO', 'S&P/ASX 200', 'ASX200'], ['^GSPTSE', 'S&P/TSX Composite', 'TSX'], ['^BVSP', 'Ibovespa', 'IBOV'],
      ] },
    ],
  },
  crypto: {
    title: 'Crypto',
    blurb: 'The largest coins by market capitalisation, priced live in US dollars.',
    lead: 'BTC-USD',
    sortBy: 'mcap',
    summary: ['BTC-USD', 'ETH-USD', 'XRP-USD', 'BNB-USD', 'SOL-USD', 'DOGE-USD'],
    hubTop: 6,
    groups: [
      { id: 'coins', title: 'Coins by market cap', rows: [
        ['BTC-USD', 'Bitcoin', 'BTC', 'USD'], ['ETH-USD', 'Ethereum', 'ETH', 'USD'], ['XRP-USD', 'XRP', 'XRP', 'USD'],
        ['BNB-USD', 'BNB', 'BNB', 'USD'], ['SOL-USD', 'Solana', 'SOL', 'USD'], ['TRX-USD', 'TRON', 'TRX', 'USD'],
        ['DOGE-USD', 'Dogecoin', 'DOGE', 'USD'], ['ADA-USD', 'Cardano', 'ADA', 'USD'], ['LINK-USD', 'Chainlink', 'LINK', 'USD'],
        ['BCH-USD', 'Bitcoin Cash', 'BCH', 'USD'], ['XLM-USD', 'Stellar', 'XLM', 'USD'], ['SUI20947-USD', 'Sui', 'SUI', 'USD'],
        ['AVAX-USD', 'Avalanche', 'AVAX', 'USD'], ['LTC-USD', 'Litecoin', 'LTC', 'USD'], ['SHIB-USD', 'Shiba Inu', 'SHIB', 'USD'],
        ['DOT-USD', 'Polkadot', 'DOT', 'USD'],
      ] },
    ],
  },
  futures: {
    title: 'Futures',
    blurb: 'Energy, metals, agricultural, index and Treasury futures — the front contract of each.',
    lead: 'CL=F',
    summary: ['GC=F', 'SI=F', 'HG=F', 'PL=F', 'CL=F', 'NG=F'],
    hub: ['CL=F', 'NG=F', 'GC=F', 'SI=F', 'HG=F', 'ES=F'],
    groups: [
      { id: 'energy', title: 'Energy futures', rows: [
        ['CL=F', 'Light crude oil', 'CL', 'USD/bbl'], ['BZ=F', 'Brent crude oil', 'BZ', 'USD/bbl'],
        ['NG=F', 'Natural gas', 'NG', 'USD/MMBtu'], ['RB=F', 'RBOB gasoline', 'RB', 'USD/gal'],
        ['HO=F', 'Heating oil (ULSD)', 'HO', 'USD/gal'],
      ] },
      { id: 'metals', title: 'Metals futures', rows: [
        ['GC=F', 'Gold', 'GC', 'USD/oz'], ['SI=F', 'Silver', 'SI', 'USD/oz'], ['HG=F', 'Copper', 'HG', 'USD/lb'],
        ['PL=F', 'Platinum', 'PL', 'USD/oz'], ['PA=F', 'Palladium', 'PA', 'USD/oz'],
      ] },
      { id: 'agricultural', title: 'Agricultural futures', rows: [
        ['ZC=F', 'Corn', 'ZC', 'US¢/bu'], ['ZW=F', 'Wheat', 'ZW', 'US¢/bu'], ['ZS=F', 'Soybeans', 'ZS', 'US¢/bu'],
        ['KC=F', 'Coffee', 'KC', 'US¢/lb'], ['SB=F', 'Sugar No. 11', 'SB', 'US¢/lb'], ['CT=F', 'Cotton No. 2', 'CT', 'US¢/lb'],
        ['CC=F', 'Cocoa', 'CC', 'USD/t'], ['LE=F', 'Live cattle', 'LE', 'US¢/lb'], ['HE=F', 'Lean hogs', 'HE', 'US¢/lb'],
      ] },
      { id: 'index', title: 'Index futures', rows: [
        ['ES=F', 'E-mini S&P 500', 'ES', 'points'], ['NQ=F', 'E-mini Nasdaq 100', 'NQ', 'points'],
        ['YM=F', 'E-mini Dow', 'YM', 'points'], ['RTY=F', 'E-mini Russell 2000', 'RTY', 'points'],
      ] },
      { id: 'rates', title: 'Treasury futures', rows: [
        ['ZT=F', '2-year T-note', 'ZT', '% of par'], ['ZN=F', '10-year T-note', 'ZN', '% of par'],
        ['ZB=F', '30-year T-bond', 'ZB', '% of par'],
      ] },
    ],
  },
  forex: {
    title: 'Forex',
    blurb: 'Major, cross and emerging-market currency pairs, and the dollar index.',
    lead: 'EURUSD=X',
    summary: ['EURUSD=X', 'JPY=X', 'GBPUSD=X', 'AUDUSD=X', 'CAD=X', 'CHF=X'],
    hub: ['EURUSD=X', 'JPY=X', 'GBPUSD=X', 'AUDUSD=X', 'CAD=X', 'DX-Y.NYB'],
    groups: [
      { id: 'majors', title: 'Major pairs', rows: [
        ['EURUSD=X', 'Euro / US dollar', 'EURUSD'], ['JPY=X', 'US dollar / Japanese yen', 'USDJPY'],
        ['GBPUSD=X', 'British pound / US dollar', 'GBPUSD'], ['AUDUSD=X', 'Australian dollar / US dollar', 'AUDUSD'],
        ['CAD=X', 'US dollar / Canadian dollar', 'USDCAD'], ['CHF=X', 'US dollar / Swiss franc', 'USDCHF'],
        ['NZDUSD=X', 'New Zealand dollar / US dollar', 'NZDUSD'],
      ] },
      { id: 'crosses', title: 'Crosses', rows: [
        ['EURJPY=X', 'Euro / Japanese yen', 'EURJPY'], ['EURGBP=X', 'Euro / British pound', 'EURGBP'],
        ['GBPJPY=X', 'British pound / Japanese yen', 'GBPJPY'], ['EURCHF=X', 'Euro / Swiss franc', 'EURCHF'],
        ['AUDJPY=X', 'Australian dollar / Japanese yen', 'AUDJPY'], ['EURAUD=X', 'Euro / Australian dollar', 'EURAUD'],
      ] },
      { id: 'emerging', title: 'Dollar vs emerging markets', rows: [
        ['CNY=X', 'US dollar / Chinese yuan', 'USDCNY'], ['MXN=X', 'US dollar / Mexican peso', 'USDMXN'],
        ['INR=X', 'US dollar / Indian rupee', 'USDINR'], ['BRL=X', 'US dollar / Brazilian real', 'USDBRL'],
        ['ZAR=X', 'US dollar / South African rand', 'USDZAR'], ['TRY=X', 'US dollar / Turkish lira', 'USDTRY'],
      ] },
      { id: 'index', title: 'Dollar index', rows: [
        ['DX-Y.NYB', 'US Dollar Index', 'DXY'],
      ] },
    ],
  },
};

// The SPDR sector funds stand in for "sector performance": a fund per sector is a real,
// priced thing, where a sector average of our 119 names would be a number we made up.
const SECTORS = [
  ['XLK', 'Technology'], ['XLC', 'Communications'], ['XLY', 'Discretionary'],
  ['XLF', 'Financials'], ['XLV', 'Health care'], ['XLI', 'Industrials'], ['XLE', 'Energy'],
  ['XLB', 'Materials'], ['XLP', 'Staples'], ['XLU', 'Utilities'], ['XLRE', 'Real estate'],
];

const STOCK_GROUPS = [
  { id: 'gainers', title: 'Gainers' },
  { id: 'losers', title: 'Losers' },
  { id: 'active', title: 'Most active' },
  { id: 'all', title: 'All tracked' },
];

// Every instrument this module will fetch for a symbol page or a chart. A request for
// anything else is refused, so a public endpoint cannot be used to make this host fetch
// arbitrary symbols — and the caches below are bounded by this list rather than by use.
const LISTED = new Map();
for (const [cid, C] of Object.entries(CLASSES)) {
  for (const g of C.groups) {
    for (const [sym, name, short, unit] of g.rows) {
      if (!LISTED.has(sym)) LISTED.set(sym, { symbol: sym, name, short, unit: unit || null, class: cid, group: g.id });
    }
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (compatible; unisona.ai/1.0; +https://unisona.ai)';
const TIMEOUT_MS = 8000;
const MAX_BODY = 4 * 1024 * 1024;
const BATCH = 50;

function get(url, headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...(headers || {}) } }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > MAX_BODY) req.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: d, headers: res.headers }));
      res.on('close', () => finish({ status: 0, body: '', headers: {} }));
    });
    req.on('error', () => finish({ status: 0, body: '', headers: {} }));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

let _crumb = null;          // { crumb, cookie, at }
let _crumbRefusedAt = 0;    // a refusing gate is not asked again for five minutes
async function crumb(force) {
  if (!force && _crumb && Date.now() - _crumb.at < 6 * 3600e3) return _crumb;
  if (!force && Date.now() - _crumbRefusedAt < 5 * 60e3) return null;
  const c1 = await get('https://fc.yahoo.com/');
  const cookie = ((c1.headers && c1.headers['set-cookie']) || []).map((s) => String(s).split(';')[0]).join('; ');
  if (cookie) {
    const r = await get('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie });
    const body = String(r.body || '').trim();
    if (r.status === 200 && body && !/[<{\s]/.test(body)) {
      _crumb = { crumb: body, cookie, at: Date.now() };
      return _crumb;
    }
  }
  _crumbRefusedAt = Date.now();
  return null;
}

async function v7(symbols, retried) {
  const c = await crumb(retried);
  if (!c) return null;
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
    + encodeURIComponent(symbols.join(',')) + '&crumb=' + encodeURIComponent(c.crumb);
  const r = await get(url, { Cookie: c.cookie });
  if (r.status === 401 && !retried) return v7(symbols, true);   // a stale crumb, once
  if (r.status !== 200) return null;
  try {
    const res = JSON.parse(r.body).quoteResponse.result;
    return Array.isArray(res) ? res.map(fromV7).filter(Boolean) : null;
  } catch (_e) { return null; }
}

async function chart(sym, params) {
  const r = await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?' + params);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body).chart.result[0] || null; } catch (_e) { return null; }
}

async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (_e) { out[k] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// One fetch in flight per key: twenty visitors opening the same board at once cost one
// request, not twenty.
const _flights = new Map();
function flight(key, fn) {
  if (_flights.has(key)) return _flights.get(key);
  const p = Promise.resolve().then(fn).finally(() => _flights.delete(key));
  _flights.set(key, p);
  return p;
}

// ── Normalising a quote ──────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
// Yahoo reports a field it does not have as 0 (the day range of a yield, a 52-week low
// of 0 on ^TNX). For a price, 0 is never a value, so it is read as missing.
function pos(v) { const n = num(v); return n != null && n > 0 ? n : null; }
function round(n, d) { if (n == null || !Number.isFinite(n)) return null; const f = 10 ** d; return Math.round(n * f) / f; }
function cleanName(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function fromV7(q) {
  const price = q && pos(q.regularMarketPrice);
  if (!price || !q.symbol) return null;
  const pre = pos(q.preMarketPrice), post = pos(q.postMarketPrice);
  return {
    symbol: String(q.symbol),
    yname: cleanName(q.shortName || q.longName),
    price,
    chg: num(q.regularMarketChange),
    chg_pct: num(q.regularMarketChangePercent),
    high: pos(q.regularMarketDayHigh),
    low: pos(q.regularMarketDayLow),
    volume: pos(q.regularMarketVolume),
    mcap: pos(q.marketCap),
    supply: pos(q.circulatingSupply),
    avg50: pos(q.fiftyDayAverage),
    avg200: pos(q.twoHundredDayAverage),
    w52_chg: num(q.fiftyTwoWeekChangePercent),
    w52_high: pos(q.fiftyTwoWeekHigh),
    w52_low: pos(q.fiftyTwoWeekLow),
    currency: q.currency || null,
    hint: Number.isInteger(q.priceHint) ? q.priceHint : null,
    state: q.marketState || null,
    time: num(q.regularMarketTime) ? q.regularMarketTime * 1000 : null,
    exchange: q.fullExchangeName || q.exchange || null,
    pre: pre ? { price: pre, chg_pct: num(q.preMarketChangePercent) } : null,
    post: post ? { price: post, chg_pct: num(q.postMarketChangePercent) } : null,
  };
}

/** The same row from a chart response — the fallback when the batch endpoint refuses. It
 *  has no moving averages or market cap, so those read as missing rather than as zero. */
function fromChart(sym, result) {
  const m = (result && result.meta) || {};
  const price = pos(m.regularMarketPrice);
  if (!price) return null;
  const closes = ((((result.indicators || {}).quote || [])[0]) || {}).close || [];
  let prev = null;
  for (let i = closes.length - 2; i >= 0; i--) { if (pos(closes[i])) { prev = Number(closes[i]); break; } }
  const chg = num(m.fulldayChange) != null ? num(m.fulldayChange) : (prev ? price - prev : null);
  const chgPct = num(m.regularMarketChangePercent) != null ? num(m.regularMarketChangePercent)
    : (prev ? ((price - prev) / prev) * 100 : null);
  return {
    symbol: sym, yname: cleanName(m.shortName || m.longName), price, chg, chg_pct: chgPct,
    high: pos(m.regularMarketDayHigh), low: pos(m.regularMarketDayLow), volume: pos(m.regularMarketVolume),
    mcap: null, supply: null, avg50: null, avg200: null, w52_chg: null,
    w52_high: pos(m.fiftyTwoWeekHigh), w52_low: pos(m.fiftyTwoWeekLow),
    currency: m.currency || null, hint: Number.isInteger(m.priceHint) ? m.priceHint : null,
    state: null, time: num(m.regularMarketTime) ? m.regularMarketTime * 1000 : null,
    exchange: m.fullExchangeName || m.exchangeName || null, pre: null, post: null,
  };
}

// ── Quote cache ──────────────────────────────────────────────────────────────────
const QUOTE_TTL = 30e3;
const FALLBACK_TTL = 120e3;   // a chart-per-row fallback is expensive; it is renewed less often
const _quotes = new Map();    // symbol -> { row, at, ttl }

async function refresh(symbols) {
  for (let i = 0; i < symbols.length; i += BATCH) {
    const part = symbols.slice(i, i + BATCH);
    let rows = await v7(part);
    let ttl = QUOTE_TTL;
    if (!rows) {
      rows = (await pmap(part, 4, async (s) => fromChart(s, await chart(s, 'interval=1d&range=5d')))).filter(Boolean);
      ttl = FALLBACK_TTL;
    }
    const at = Date.now();
    const got = new Map(rows.map((r) => [r.symbol, r]));
    // A symbol Yahoo did not price is remembered as missing for one TTL, so a dead symbol
    // is not refetched on every view.
    for (const s of part) _quotes.set(s, { row: got.get(s) || null, at, ttl });
  }
}

/** Quotes for `symbols`, as a Map symbol -> row. Fresh rows come from the cache. */
async function quotes(symbols) {
  const want = [...new Set(symbols)];
  const now = Date.now();
  const stale = want.filter((s) => { const e = _quotes.get(s); return !e || now - e.at >= e.ttl; });
  if (stale.length) await flight('q|' + stale.join(','), () => refresh(stale));
  const out = new Map();
  for (const s of want) { const e = _quotes.get(s); if (e && e.row) out.set(s, e.row); }
  return out;
}

// ── History (for performance and charts) ─────────────────────────────────────────
const HIST_TTL = 30 * 60e3;
const _hist = new Map();   // symbol -> { pts, at }

function pointsOf(res) {
  if (!res) return [];
  const ts = res.timestamp || [];
  const c = ((((res.indicators || {}).quote || [])[0]) || {}).close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const v = Number(c[i]);
    if (c[i] != null && Number.isFinite(v) && v > 0) out.push([ts[i] * 1000, v]);
  }
  return out;
}

// History comes from Yahoo's SPARK endpoint: two years of daily closes for up to twenty
// symbols in one request (it answers 400 past twenty). A Performance view over the 119
// tracked stocks is six requests, not 119 chart calls.
const SPARK_MAX = 20;

function sparkPoints(entry) {
  if (!entry) return [];
  const ts = entry.timestamp || [];
  const c = entry.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const v = Number(c[i]);
    if (c[i] != null && Number.isFinite(v) && v > 0) out.push([ts[i] * 1000, v]);
  }
  return out;
}

async function loadHistories(symbols) {
  for (let i = 0; i < symbols.length; i += SPARK_MAX) {
    const part = symbols.slice(i, i + SPARK_MAX);
    const r = await get('https://query1.finance.yahoo.com/v8/finance/spark?symbols='
      + encodeURIComponent(part.join(',')) + '&range=2y&interval=1d');
    let j = null;
    if (r.status === 200) { try { j = JSON.parse(r.body); } catch (_e) { j = null; } }
    const got = new Map();
    for (const sym of part) got.set(sym, j ? sparkPoints(j[sym]) : []);
    // A refused batch for one or two symbols (a symbol page, a lead chart) falls back to a
    // chart call each; a big batch does not, so an outage never becomes a hundred calls.
    if (!j && part.length <= 2) {
      for (const sym of part) got.set(sym, pointsOf(await chart(sym, 'interval=1d&range=2y')));
    }
    const at = Date.now();
    for (const sym of part) {
      const pts = got.get(sym);
      // A failed fetch is retried after a minute, not after half an hour.
      _hist.set(sym, { pts, at: pts.length ? at : at - HIST_TTL + 60e3 });
    }
  }
}

/** Two years of daily closes per symbol, as a Map symbol -> [[ms, close], …]. */
async function histories(symbols) {
  const want = [...new Set(symbols)];
  const now = Date.now();
  const stale = want.filter((x) => { const e = _hist.get(x); return !e || now - e.at >= HIST_TTL; });
  if (stale.length) await flight('h|' + stale.join(','), () => loadHistories(stale));
  const out = new Map();
  for (const x of want) { const e = _hist.get(x); out.set(x, e ? e.pts : []); }
  return out;
}
async function history(sym) { return (await histories([sym])).get(sym) || []; }

/** Return over each window: the live price against the last close at or before the
 *  window's start. Calendar windows, not bar counts — a crypto week has seven sessions
 *  and an index week five, and "1W" means the same week for both. */
function perfFrom(pts, price, now = Date.now()) {
  const out = { w1: null, m1: null, m3: null, m6: null, ytd: null, y1: null };
  if (!Array.isArray(pts) || pts.length < 2 || !(price > 0)) return out;
  const at = (t) => {
    let lo = 0, hi = pts.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 ? pts[best][1] : null;
  };
  const ret = (ref) => (ref > 0 ? round((price / ref - 1) * 100, 2) : null);
  const back = (months) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - months); return d.getTime(); };
  out.w1 = ret(at(now - 7 * 86400e3));
  out.m1 = ret(at(back(1)));
  out.m3 = ret(at(back(3)));
  out.m6 = ret(at(back(6)));
  out.y1 = ret(at(back(12)));
  out.ytd = ret(at(Date.UTC(new Date(now).getUTCFullYear(), 0, 1) - 1));
  return out;
}

// Chart ranges for the summary chart and the symbol page. The daily ones are cut from the
// same cached history the performance figures use, so they cost nothing extra.
const RANGES = {
  '1D': { params: 'interval=5m&range=1d', ttl: 60e3 },
  '5D': { params: 'interval=15m&range=5d', ttl: 5 * 60e3 },
  '1M': { months: 1 }, '6M': { months: 6 }, '1Y': { months: 12 },
  '5Y': { params: 'interval=1wk&range=5y', ttl: 6 * 3600e3 },
};
const _series = new Map();   // "sym|range" -> { pts, at }

/** { points: [[ms, close], …], base, last } — `base` is what the window's move is
 *  measured from when it is not the first point (for 1D, the previous close), and `last`
 *  is the quote's own { price, chg_pct } for 1D, so a chart's "today" is the same number
 *  as every quote beside it. */
async function series(sym, range) {
  const R = RANGES[range];
  if (!R) return null;
  if (R.months) {
    const pts = await history(sym);
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - R.months);
    return { points: pts.filter((p) => p[0] >= d.getTime()), base: null };
  }
  const key = sym + '|' + range;
  const e = _series.get(key);
  if (e && Date.now() - e.at < R.ttl) return e.val;
  return flight('s|' + key, async () => {
    const res = await chart(sym, R.params);
    let pts = pointsOf(res);
    // "1D" is measured from the previous session's close — the figure every quote on the
    // page calls today's change — not from the day's first bar, which read +0.24% beside a
    // quote of +0.59% for the same S&P 500 on the same screen. The QUOTE's previous close
    // where there is one: for a coin, Yahoo's chart and quote endpoints disagree about it
    // (Bitcoin read +0.82% on its chart beside +0.69% in its row).
    let base = range === '1D' ? pos(res && res.meta && res.meta.chartPreviousClose) : null;
    let last = null;
    if (range === '1D') {
      const q = (await quotes([sym])).get(sym);
      if (q && q.chg != null && q.price - q.chg > 0) base = q.price - q.chg;
      if (q) last = { price: q.price, chg_pct: q.chg_pct };
    }
    // A session minutes old has a "1d" of a few bars: a coin just past midnight UTC, a
    // future just after Sunday's 18:00 ET open. Show the last day of trading instead — at
    // least a regular session's worth of bars (78), however long ago they printed — still
    // measured from the same previous close.
    if (range === '1D' && pts.length < 24) {
      const wide = pointsOf(await chart(sym, 'interval=5m&range=5d'));
      if (wide.length) {
        const end = wide[wide.length - 1][0];
        const day = wide.filter((p) => p[0] > end - 86400e3);
        pts = day.length >= 78 ? day : wide.slice(-78);
      }
    }
    const val = { points: pts, base, last };
    _series.set(key, { val, at: pts.length ? Date.now() : Date.now() - R.ttl + 30e3 });
    return val;
  });
}

// ── Derived boards ───────────────────────────────────────────────────────────────

// The cross-rate grid, derived — not fetched — from each currency's rate against the
// dollar: a pair A/B moves by (1+a)/(1+b)-1 when A and B move by a and b against USD.
// One-day changes only; the page says which.
const FX_CCY = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
const FX_LEG = {   // currency -> [pair, is the pair quoted as USD per it (false) or it per USD (true)]
  EUR: ['EURUSD=X', false], GBP: ['GBPUSD=X', false], AUD: ['AUDUSD=X', false], NZD: ['NZDUSD=X', false],
  JPY: ['JPY=X', true], CHF: ['CHF=X', true], CAD: ['CAD=X', true],
};
function crossRates(bySym) {
  const g = { USD: 0 };
  for (const [ccy, [sym, inverted]] of Object.entries(FX_LEG)) {
    const r = bySym.get(sym);
    const p = r ? Number(r.chg_pct) : NaN;
    if (r == null || r.chg_pct == null || !Number.isFinite(p)) continue;
    const f = 1 + p / 100;
    g[ccy] = inverted ? 1 / f - 1 : f - 1;
  }
  const cells = [];
  for (const base of FX_CCY) {
    for (const quote of FX_CCY) {
      if (base === quote) continue;
      const ok = g[base] != null && g[quote] != null;
      cells.push({ base, quote, chg_pct: ok ? round(((1 + g[base]) / (1 + g[quote]) - 1) * 100, 2) : null });
    }
  }
  return { currencies: FX_CCY, cells };
}

/** Advancing / declining and how many sit above their averages — across the list it is
 *  handed, which the page names. */
function breadthOf(rows) {
  let adv = 0, dec = 0, unch = 0, a50 = 0, n50 = 0, a200 = 0, n200 = 0;
  for (const r of rows) {
    if (r.chg_pct != null && Number.isFinite(r.chg_pct)) { if (r.chg_pct > 0) adv++; else if (r.chg_pct < 0) dec++; else unch++; }
    if (r.avg50 > 0) { n50++; if (r.price > r.avg50) a50++; }
    if (r.avg200 > 0) { n200++; if (r.price > r.avg200) a200++; }
  }
  return {
    n: rows.length, adv, dec, unch, n50, n200,
    above50: n50 ? Math.round((a50 / n50) * 100) : null,
    above200: n200 ? Math.round((a200 / n200) * 100) : null,
  };
}

function sessionChange(r, session) {
  if (session === 'pre') return r.pre ? r.pre.chg_pct : null;
  if (session === 'post') return r.post ? r.post.chg_pct : null;
  return r.chg_pct;
}

/** Rank by the session's move (dir +1 gainers, -1 losers) or by dollar volume (dir 0). */
function rank(rows, dir, session, limit) {
  let out;
  if (dir === 0) {
    out = rows.filter((r) => r.volume > 0).sort((a, b) => b.price * b.volume - a.price * a.volume);
  } else {
    out = rows
      .map((r) => ({ r, m: sessionChange(r, session) }))
      .filter((x) => x.m != null && Number.isFinite(x.m) && (dir > 0 ? x.m > 0 : x.m < 0))
      .sort((a, b) => (dir > 0 ? b.m - a.m : a.m - b.m))
      .map((x) => x.r);
  }
  return limit ? out.slice(0, limit) : out;
}

// ── What the client receives ─────────────────────────────────────────────────────
// A fixed set of fields. Everything here is market data; nothing names an account.
function present(sym, q, extra) {
  const L = LISTED.get(sym);
  return {
    symbol: sym,
    name: L ? L.name : (q.yname || sym),
    short: L ? L.short : sym,
    unit: L ? L.unit : null,
    price: q.price, chg: q.chg, chg_pct: q.chg_pct, high: q.high, low: q.low, volume: q.volume,
    mcap: q.mcap, supply: q.supply, avg50: q.avg50, avg200: q.avg200, w52_chg: q.w52_chg,
    w52_high: q.w52_high, w52_low: q.w52_low, currency: q.currency, hint: q.hint, state: q.state,
    time: q.time, exchange: q.exchange,
    ...(extra || {}),
  };
}

function classOf(id) { return Object.prototype.hasOwnProperty.call(CLASSES, id) ? CLASSES[id] : null; }
function symbolsOf(C) { return [].concat(...C.groups.map((g) => g.rows.map((r) => r[0]))); }
function groupRows(C, g, q) {
  const rows = g.rows.map((r) => (q.has(r[0]) ? present(r[0], q.get(r[0])) : null)).filter(Boolean);
  if (C.sortBy === 'mcap') rows.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  return rows;
}

function stockRows(q) {
  const { UNIVERSE, kindOf } = require('./market-universe');
  return UNIVERSE.filter((s) => q.has(s)).map((s) => {
    const r = q.get(s);
    return { ...present(s, r), name: r.yname || s, short: s, kind: kindOf(s), pre: r.pre, post: r.post };
  });
}

// ── Public API ───────────────────────────────────────────────────────────────────

/** /markets.html: a few instruments from every class, and the day's biggest stock moves. */
async function hub() {
  const { UNIVERSE } = require('./market-universe');
  const want = [].concat(CLASSES.indices.hub, symbolsOf(CLASSES.crypto), CLASSES.futures.hub, CLASSES.forex.hub, UNIVERSE);
  const q = await quotes(want);
  const pick = (list) => list.filter((s) => q.has(s)).map((s) => present(s, q.get(s)));
  const coins = groupRows(CLASSES.crypto, CLASSES.crypto.groups[0], q).slice(0, CLASSES.crypto.hubTop);
  const stocks = stockRows(q);
  return {
    asOf: new Date().toISOString(),
    lead: { symbol: CLASSES.indices.lead, name: LISTED.get(CLASSES.indices.lead).name },
    indices: pick(CLASSES.indices.hub),
    crypto: coins,
    futures: pick(CLASSES.futures.hub),
    forex: pick(CLASSES.forex.hub),
    stocks: { universe: UNIVERSE.length, priced: stocks.length, gainers: rank(stocks, 1, 'regular', 5), losers: rank(stocks, -1, 'regular', 5) },
  };
}

/** /market.html?c=<class>: the class's summary table, and every group's first rows. */
async function overview(classId) {
  if (classId === 'stocks') return stocksOverview();
  const C = classOf(classId);
  if (!C) return null;
  const q = await quotes(symbolsOf(C));
  const priced = C.summary.filter((s) => q.has(s));
  const H = await histories(priced);
  const summary = priced.map((s) => present(s, q.get(s), { perf: perfFrom(H.get(s), q.get(s).price) }));
  const out = {
    asOf: new Date().toISOString(),
    class: { id: classId, title: C.title, blurb: C.blurb },
    lead: { symbol: C.lead, name: LISTED.get(C.lead).name },
    summary,
    groups: C.groups.map((g) => {
      const rows = groupRows(C, g, q);
      return { id: g.id, title: g.title, listed: g.rows.length, priced: rows.length, rows: rows.slice(0, 6) };
    }),
  };
  if (classId === 'forex') out.cross = crossRates(q);
  if (classId === 'crypto') {
    // Totals over the coins LISTED here, and labelled that way on the page — this is not
    // the whole crypto market's capitalisation, and Bitcoin's share of sixteen coins is
    // not "Bitcoin dominance".
    const coins = groupRows(C, C.groups[0], q);
    const total = coins.reduce((s, r) => s + (r.mcap || 0), 0);
    const btc = coins.find((r) => r.symbol === 'BTC-USD');
    out.totals = { coins: coins.length, mcap: total || null, btcShare: total && btc && btc.mcap ? round((btc.mcap / total) * 100, 1) : null };
  }
  return out;
}

async function stocksOverview() {
  const { UNIVERSE } = require('./market-universe');
  const q = await quotes([].concat(UNIVERSE, SECTORS.map((s) => s[0])));
  const rows = stockRows(q);
  const H = await histories(SECTORS.map((x) => x[0]).filter((x) => q.has(x)));
  const sectors = SECTORS.filter(([s]) => q.has(s)).map(([s, name]) => {
    const r = q.get(s);
    const pf = perfFrom(H.get(s), r.price);
    return { symbol: s, name, chg_pct: r.chg_pct, m1: pf.m1, ytd: pf.ytd };
  });
  return {
    asOf: new Date().toISOString(),
    class: { id: 'stocks', title: 'US stocks', blurb: 'The biggest moves, the busiest names and the breadth of the ' + UNIVERSE.length + ' US stocks and funds we track.' },
    lead: { symbol: '^GSPC', name: 'S&P 500' },
    universe: UNIVERSE.length,
    priced: rows.length,
    breadth: breadthOf(rows),
    sectors,
    gainers: rank(rows, 1, 'regular', 6),
    losers: rank(rows, -1, 'regular', 6),
    active: rank(rows, 0, 'regular', 6),
    groups: STOCK_GROUPS,
  };
}

/** /market.html?c=<class>&g=<group>: one group in full; view=perf adds the windows. */
async function board(classId, groupId, opts = {}) {
  const view = opts.view === 'perf' ? 'perf' : 'overview';
  if (classId === 'stocks') {
    const G = STOCK_GROUPS.find((g) => g.id === groupId);
    if (!G) return null;
    const { UNIVERSE } = require('./market-universe');
    const session = opts.session === 'pre' || opts.session === 'post' ? opts.session : 'regular';
    const rows = stockRows(await quotes(UNIVERSE));
    let list;
    if (G.id === 'gainers') list = rank(rows, 1, session);
    else if (G.id === 'losers') list = rank(rows, -1, session);
    else if (G.id === 'active') list = rank(rows, 0, session);
    else list = rows.slice().sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    if (view === 'perf') {
      const H = await histories(list.map((r) => r.symbol));
      for (const r of list) r.perf = perfFrom(H.get(r.symbol), r.price);
    }
    return {
      asOf: new Date().toISOString(),
      class: { id: 'stocks', title: 'US stocks' }, group: G, groups: STOCK_GROUPS,
      view, session, universe: UNIVERSE.length, priced: rows.length, rows: list,
    };
  }
  const C = classOf(classId);
  const g = C && C.groups.find((x) => x.id === groupId);
  if (!g) return null;
  const rows = groupRows(C, g, await quotes(g.rows.map((r) => r[0])));
  if (view === 'perf') {
    const H = await histories(rows.map((r) => r.symbol));
    for (const r of rows) r.perf = perfFrom(H.get(r.symbol), r.price);
  }
  return {
    asOf: new Date().toISOString(),
    class: { id: classId, title: C.title }, group: { id: g.id, title: g.title },
    groups: C.groups.map((x) => ({ id: x.id, title: x.title })),
    view, listed: g.rows.length, priced: rows.length, rows,
  };
}

/** One listed instrument, for its symbol page. null when the symbol is not on a board. */
async function instrument(sym) {
  const L = LISTED.get(sym);
  if (!L) return null;
  const q = await quotes([sym]);
  const r = q.get(sym);
  const C = CLASSES[L.class];
  const g = C.groups.find((x) => x.id === L.group);
  let trade = null;
  if (L.class === 'crypto') {
    // The terminal trades a coin as BTCUSD; only the coins it knows get the link.
    const base = sym.replace(/-USD$/, '').replace(/\d+$/, '');
    try { if (require('./market-data-yahoo').isCrypto(base + 'USD')) trade = base + 'USD'; } catch (_e) { trade = null; }
  }
  return {
    symbol: sym, name: L.name, short: L.short, unit: L.unit,
    class: { id: L.class, title: C.title }, group: { id: g.id, title: g.title },
    quote: r ? present(sym, r) : null,
    perf: r ? perfFrom(await history(sym), r.price) : null,
    trade,
  };
}

function isListed(sym) { return LISTED.has(sym); }

module.exports = {
  hub, overview, board, instrument, series, isListed,
  CLASS_IDS: Object.keys(CLASSES).concat('stocks'), RANGES: Object.keys(RANGES),
  // pure pieces, for tests
  _CLASSES: CLASSES, _SECTORS: SECTORS, _LISTED: LISTED, _UA: UA,
  _fromV7: fromV7, _fromChart: fromChart, _perfFrom: perfFrom, _crossRates: crossRates,
  _breadthOf: breadthOf, _rank: rank, _pointsOf: pointsOf,
  _reset() { _quotes.clear(); _hist.clear(); _series.clear(); _flights.clear(); _crumb = null; _crumbRefusedAt = 0; },
};
