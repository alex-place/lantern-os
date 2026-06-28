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
  '1d':  { interval: '1d',  range: '2y',  agg: 1 },
};
const MAX_BARS = 500;          // deep history for zoom/pan (client windows it)
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
  const m = /^([A-Z]{2,6})USD$/.exec(String(ticker || '').toUpperCase());
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

async function fetchChart(ticker, interval, range) {
  const sym = encodeURIComponent(tickerToYahoo(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
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
      const result = await fetchChart(ticker, '1d', '5d');
      const meta = result.meta || {};
      const price = Number(meta.regularMarketPrice) || 0;
      const prev = Number(meta.chartPreviousClose || meta.previousClose) || 0;
      const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      return { ticker, price: round(price, 4), chg_pct: round(chg, 2), is_crypto: isCrypto(ticker) };
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
async function getBars(ticker, timeframe = '5m') {
  const tf = TF[timeframe] || TF['5m'];
  const key = `b:${ticker}:${timeframe}`;
  const hit = cacheGet(key, BARS_TTL);
  if (hit) return hit;
  try {
    const result = await fetchChart(ticker, tf.interval, tf.range);
    const bars = parseBars(result, tf.agg);
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

module.exports = { getQuotes, getBars, getBarsMulti, isCrypto, tickerToYahoo, _TF: TF };
