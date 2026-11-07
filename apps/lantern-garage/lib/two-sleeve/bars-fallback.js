'use strict';
/**
 * lib/two-sleeve/bars-fallback.js — Alpaca's 5m bars behind a LATE Yahoo feed, for the engine's custom scans (2026-11-07, OFF by default).
 *
 * WHY. On 2026-10-30 Yahoo's 5m bars ran 20-60 minutes late from about 12:30 ET. The 15:50 bar never settled inside 15:55-16:00, so
 * the overnight book bought nothing for the weekend and the close-IBS sleeve had no decision bar; #3796 journals such a miss, it does
 * not prevent one. The noise leg offers an entry only within 3 minutes of its decision bar's close, so a late feed silences it too, and
 * the month-end bond book's two windows a month read the same 15:50 bar.
 *
 * WHAT. A getBars(sym, tf) for the scans (lib/two-sleeve/scan-worker.js) that asks Yahoo first, exactly as before. Only when
 *   - the timeframe is 5m and the clock is inside a regular session (lib/market-calendar.js: 09:30 to 16:00, 13:00 on an early close),
 *   - Yahoo returned bars, and
 *   - Yahoo's newest bar at or before now ENDED more than STALE_MS ago (a live feed always holds the forming bar; a feed with nothing
 *     today counts from the 09:30 open),
 * does it read Alpaca's 5m bars for the session — one request for every symbol the worker has asked for, kept CACHE_MS — and APPEND the
 * ones that start after Yahoo's newest bar. Nothing Yahoo served is changed or dropped, so a feed that is merely late changes nothing
 * the scans already had. An empty or failed Yahoo read is left as it is: the noise leg and the bond gate read the prior session from
 * the same series, which a session read from Alpaca does not hold. The scans then decide exactly as they do on Yahoo's bars.
 *
 * THE FEED. Alpaca's free market data serves the consolidated tape (SIP) only 15 minutes late, so the real-time read is the IEX
 * exchange's own prints (feed=iex; TRADER_BARS_ALPACA_FEED=sip on a plan that has the real-time tape). IEX carries a few percent of the
 * volume, so a bar's high and low can sit inside the consolidated ones and its close can differ by a cent or so. Its volume is not
 * comparable with Yahoo's; none of the four custom scans reads volume. Every appended bar carries src 'alpaca-<feed>'.
 *
 * KNOB. TRADER_BARS_ALPACA_FALLBACK (the sleeve's env): '1' armed; 'shadow' reads Alpaca the same way and journals what it would
 * append, but returns Yahoo's bars unchanged; anything else off, the default, with no Alpaca request at all. It needs the Alpaca keys
 * in the sleeve's env file (the spellings lib/entry-tags.js serverNewsHeaders accepts); without them it is inert and the worker's
 * ready row says so.
 *
 * JOURNAL (the worker's own log). One bars_fallback row (bars_fallback_shadow in the shadow) each time the newest bar of Alpaca's read
 * moves while Yahoo is late: the trigger, its lag, and each symbol's newest Yahoo and Alpaca bar. One bars_fallback_failed row at most
 * every RETRY_MS while Alpaca's read fails: the status and the reason, never a key. At most one request every CACHE_MS per worker.
 */
const { etOf, inRegularSession } = require('../market-calendar');

const BAR_MS = 5 * 60000;
const OPEN_MIN = 570;                 // 09:30 ET
const STALE_MS = 2 * 60000;           // Yahoo's newest bar ended this long ago: the feed is late
const CACHE_MS = 15000;               // one Alpaca read serves every symbol of a scan
const RETRY_MS = 60000;               // after a failed read, the next one waits this long
const FETCH_MS = 8000;                // one read's timeout (the worker's whole scan times out at 45 s)
const MAX_PAGES = 5;
const BARS_URL = 'https://data.alpaca.markets/v2/stocks/bars';
const SYMBOL_RX = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/;   // a US stock or fund; anything else stays Yahoo's alone

const tOf = (b) => Date.parse(b && b.timestamp != null ? b.timestamp : b && b.t);
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const barTime = (ms) => (Number.isFinite(ms) ? hhmm(etOf(ms).min) : null);
const iso = (ms) => new Date(ms).toISOString();

/** The instant of ET minute `min` on `day`, EDT or EST as the date has it, or null. */
function etInstant(day, min) {
  const [y, m, d] = String(day).split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, Math.floor(min / 60) + off, min % 60);
    const e = etOf(ms);
    if (e.day === day && e.min === min) return ms;
  }
  return null;
}

/** One Alpaca bar in the shape lib/market-data-yahoo.js parseBars returns, marked with its source. */
function toBar(a, src) {
  const t = Date.parse(a && a.t);
  const o = Number(a && a.o), h = Number(a && a.h), l = Number(a && a.l), c = Number(a && a.c);
  if (!Number.isFinite(t) || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return null;
  return { timestamp: iso(t), open: o, high: h, low: l, close: c, volume: Number.isFinite(Number(a.v)) ? Number(a.v) : 0, src };
}

/**
 * Alpaca's 5m bars for `symbols` from startMs to endMs: { ok, status, bars: { SYM: [bar...] }, pages } or { ok: false, status, why }.
 * Never throws; the reason never carries a header.
 */
async function fetchAlpacaBars({ symbols, startMs, endMs, feed = 'iex', headers, fetchFn = globalThis.fetch, timeoutMs = FETCH_MS } = {}) {
  const list = [...new Set((symbols || []).map((s) => String(s).toUpperCase()))].filter((s) => SYMBOL_RX.test(s));
  if (!list.length) return { ok: false, status: 0, why: 'no symbols' };
  if (typeof fetchFn !== 'function') return { ok: false, status: 0, why: 'no fetch' };
  const src = `alpaca-${feed}`;
  const bars = {};
  let token = null, pages = 0;
  do {
    const url = `${BARS_URL}?symbols=${list.join(',')}&timeframe=5Min&start=${encodeURIComponent(iso(startMs))}&end=${encodeURIComponent(iso(endMs))}`
      + `&limit=10000&feed=${encodeURIComponent(feed)}&adjustment=raw&sort=asc${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let status = 0, body = null;
    try {
      const r = await fetchFn(url, { headers: { ...headers, Accept: 'application/json' }, signal: ctl.signal });
      status = r.status;
      if (status === 200) body = await r.json();
    } catch (e) {
      return { ok: false, status, why: e && e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String((e && e.message) || e).slice(0, 160) };
    } finally { clearTimeout(timer); }
    if (status !== 200 || !body || typeof body !== 'object') return { ok: false, status, why: status === 200 ? 'bad body' : `HTTP ${status}` };
    for (const [sym, rows] of Object.entries(body.bars || {})) {
      for (const a of Array.isArray(rows) ? rows : []) { const b = toBar(a, src); if (b) (bars[sym] = bars[sym] || []).push(b); }
    }
    token = body.next_page_token || null;
    pages++;
  } while (token && pages < MAX_PAGES);
  for (const k of Object.keys(bars)) bars[k].sort((x, y) => tOf(x) - tOf(y));
  return { ok: true, status: 200, bars, pages };
}

/**
 * The wrapped feed: { getBars(sym, tf), seed(symbols), feed, shadow, stats }. `getBars` is Yahoo's (sym, tf) -> { bars }; `now` the
 * clock the scans read; `log` the worker's journal. See the header for when Alpaca is read and what is appended.
 */
function createBarsFallback({ getBars, headers, feed = 'iex', shadow = false, symbols = [], now = Date.now, log = null, fetchFn = globalThis.fetch,
  staleMs = STALE_MS, cacheMs = CACHE_MS, retryMs = RETRY_MS, timeoutMs = FETCH_MS } = {}) {
  if (typeof getBars !== 'function') throw new Error('bars fallback: getBars(sym, tf) required');
  const known = new Set();            // every symbol the worker reads: one Alpaca read covers them all
  const yahooLast = {};               // sym -> the start of Yahoo's newest bar at its latest read
  let batch = null;                   // { day, at, symbols: Set, bars }
  let inflight = null;
  let failedAt = -Infinity, failLogged = -Infinity;
  let loggedKey = null;               // `${day}:${newest}` of the latest journal row
  const stats = { reads: 0, failures: 0, served: 0, appended: 0 };
  const seed = (list) => { for (const s of list || []) { const u = String(s).trim().toUpperCase(); if (SYMBOL_RX.test(u)) known.add(u); } };
  seed(symbols);
  const journal = (row) => { if (typeof log === 'function') { try { log(row); } catch (_e) { /* journal only */ } } };

  /** The session's Alpaca bars for every known symbol, from the cache or one read; null while a read fails. */
  function read(day, t) {
    if (batch && batch.day === day && t - batch.at < cacheMs && [...known].every((s) => batch.symbols.has(s))) return Promise.resolve(batch);
    if (t - failedAt < retryMs) return Promise.resolve(null);
    if (inflight) return inflight;
    const list = [...known].sort();
    inflight = (async () => {
      stats.reads++;
      const res = await fetchAlpacaBars({ symbols: list, startMs: etInstant(day, OPEN_MIN), endMs: t, feed, headers, fetchFn, timeoutMs });
      if (!res.ok) {
        failedAt = t; stats.failures++;
        if (t - failLogged >= retryMs) { failLogged = t; journal({ event: 'bars_fallback_failed', day, at: iso(t), feed, status: res.status, why: res.why, symbols: list.length, shadow: !!shadow }); }
        return null;
      }
      batch = { day, at: t, symbols: new Set(list), bars: res.bars };
      return batch;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** One journal row per newest Alpaca bar while Yahoo is late. */
  function note(day, t, got, trigger, lagMs) {
    let newest = -Infinity;
    for (const rows of Object.values(got.bars)) { const bt = rows.length ? tOf(rows[rows.length - 1]) : NaN; if (bt <= t && bt > newest) newest = bt; }
    const key = `${day}:${newest}`;
    if (key === loggedKey) return;
    loggedKey = key;
    const per = {};
    for (const s of [...got.symbols].sort()) {
      const rows = got.bars[s] || []; const y = yahooLast[s];
      per[s] = { yahoo: Number.isFinite(y) && etOf(y).day === day ? barTime(y) : null, alpaca: rows.length ? barTime(tOf(rows[rows.length - 1])) : null };
    }
    journal({ event: shadow ? 'bars_fallback_shadow' : 'bars_fallback', day, at: iso(t), feed, trigger, lag_s: Math.round(lagMs / 1000),
      newest_bar: Number.isFinite(newest) ? barTime(newest) : null, symbols: per, shadow: !!shadow });
  }

  async function wrapped(sym, tf = '5m') {
    const r = await getBars(sym, tf);
    if (tf !== '5m' || !headers) return r;
    const S = String(sym || '').trim().toUpperCase();
    if (!SYMBOL_RX.test(S)) return r;
    known.add(S);
    const bars = r && Array.isArray(r.bars) ? r.bars : null;
    if (!bars || !bars.length) return r;
    const t = now();
    const e = etOf(t);
    if (!inRegularSession(e.day, e.min)) return r;
    let lastT = -Infinity;
    for (const b of bars) { const bt = tOf(b); if (bt <= t && bt > lastT) lastT = bt; }
    if (!Number.isFinite(lastT)) return r;
    yahooLast[S] = lastT;
    const lagMs = t - Math.max(lastT + BAR_MS, etInstant(e.day, OPEN_MIN));
    if (lagMs <= staleMs) return r;
    const got = await read(e.day, t);
    if (!got) return r;
    note(e.day, t, got, S, lagMs);
    const add = (got.bars[S] || []).filter((b) => { const bt = tOf(b); return bt > lastT && bt <= t; });
    if (!add.length || shadow) return r;
    stats.served++; stats.appended += add.length;
    return { ...r, bars: bars.concat(add), count: bars.length + add.length,
      fallback: { src: `alpaca-${feed}`, appended: add.length, yahoo_last: iso(lastT), last: add[add.length - 1].timestamp } };
  }

  return { getBars: wrapped, seed, feed, shadow: !!shadow, stats };
}

module.exports = { createBarsFallback, fetchAlpacaBars, etInstant, toBar, STALE_MS, CACHE_MS, RETRY_MS, FETCH_MS, BARS_URL };
