'use strict';
/**
 * lib/two-sleeve/bars-fallback.js — a second source of 5m bars behind a LATE Yahoo feed (OFF by default): Alpaca's for the engine's
 * custom scans (2026-11-07), IBKR's for the stable box's overnight book (2026-11-09, stableIbkrBars below).
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
 * does it read the second source's 5m bars for the session — one read for every symbol the caller has asked for, kept CACHE_MS — and
 * APPEND the ones that start after Yahoo's newest bar. Nothing Yahoo served is changed or dropped, so a feed that is merely late changes
 * nothing the scans already had. An empty or failed Yahoo read is left as it is: the noise leg and the bond gate read the prior session
 * from the same series, which a session read from the second source does not hold. The scans then decide exactly as they do on Yahoo's
 * bars.
 *
 * THE FEED (the engine). Alpaca's free market data serves the consolidated tape (SIP) only 15 minutes late, so the real-time read is the
 * IEX exchange's own prints (feed=iex; TRADER_BARS_ALPACA_FEED=sip on a plan that has the real-time tape). IEX carries a few percent of
 * the volume, so a bar's high and low can sit inside the consolidated ones and its close can differ by a cent or so. Its volume is not
 * comparable with Yahoo's; none of the four custom scans reads volume. Every appended bar carries src 'alpaca-<feed>'.
 *
 * KNOB (the engine). TRADER_BARS_ALPACA_FALLBACK (the sleeve's env): '1' armed; 'shadow' reads Alpaca the same way and journals what it
 * would append, but returns Yahoo's bars unchanged; anything else off, the default, with no Alpaca request at all. It needs the Alpaca
 * keys in the sleeve's env file (the spellings lib/entry-tags.js serverNewsHeaders accepts); without them it is inert and the worker's
 * ready row says so.
 *
 * JOURNAL (the caller's own log). One bars_fallback row (bars_fallback_shadow in the shadow) each time the newest bar of the second
 * source's read moves while Yahoo is late: the trigger, its lag, and each symbol's newest Yahoo bar and newest bar of the source. One
 * bars_fallback_failed row at most every RETRY_MS while the read fails: the status and the reason, never a key. At most one read every
 * CACHE_MS per caller.
 *
 * THE STABLE BOX (2026-11-09, stableIbkrBars). Stable trades through IBKR, and its overnight book (lib/overnight-book.js, called from
 * routes/trading.js) read Yahoo alone: on 10-30 it missed its window as the engine's sleeve O did. With TRADER_BARS_IBKR_FALLBACK=
 * shadow|1 (stable's .env.local; off unless set, and only when the user's broker is IBKR) the book's getBars goes through this same
 * fallback with IBKR's /iserver/marketdata/history as the second source:
 *   - one request per contract (conids looked up once with secdef/search and kept), and every request goes through ONE pacer: one at a
 *     time, PACE_GAP_MS apart, at most PACE_PER_MIN a minute, none for PACE_COOL_MS after a 429. IBKR's rate limit can hold the whole
 *     session, orders included, so past a limit the pacer refuses instead of queueing;
 *   - in the shadow the read runs DETACHED: the pass gets Yahoo's bars at once and the row lands when IBKR answers, so the shadow never
 *     delays the book's 15:55 decision. Armed ('1') waits, as the engine does, and refuses a batch whose first new close sits more than
 *     MAX_STEP from Yahoo's newest (a wrong price scale, not a move);
 *   - THE PROBE: the paper account carried no market-data subscription when this was written (every order gets IBKR's "submitting an
 *     order without market data" notice), so IBKR's bars there may be delayed or refused. At each PROBE_SLOTS time of a session one
 *     bars_ibkr_probe row records, for SPY, QQQ and SMH, what IBKR serves: mdAvailability and mktDataDelay as IBKR states them, its
 *     newest bar and that bar's lag against the clock, and the close / high / low gaps (bp) against Yahoo's same bars, plus the close
 *     gap against Yahoo's bar one step earlier (which shows whether IBKR labels a bar by its start). Nine paced requests a session.
 * The rows go to the stable journal under the user 'bars-ibkr'. Nothing here places, cancels or changes an order.
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
const MAX_STEP = 0.2;                 // stable, armed: a first new close this far from Yahoo's newest is a wrong scale, not a move
// IBKR (the stable box)
const IBKR_CACHE_MS = 30000;          // one IBKR read (a request per symbol) serves the book's passes for this long
const PACE_GAP_MS = 1100;             // between the starts of two IBKR market-data requests
const PACE_PER_MIN = 12;              // at most this many in any minute
const PACE_COOL_MS = 15 * 60000;      // none at all after IBKR answers 429
const CONID_MISS_MS = 30 * 60000;     // a symbol IBKR could not resolve is asked again after this
const PROBE_SLOTS = ['10:05', '12:05', '15:52'];   // ET; the last one three minutes before the overnight book's 15:55 window
const PROBE_SYMBOLS = ['SPY', 'QQQ', 'SMH'];       // the overnight book's names
const PROBE_WINDOW_MIN = 20;          // a slot passed by more than this (a restart, a gap in passes) is skipped, not caught up
const SETTLED_MS = 60000;             // a bar is compared against Yahoo once it ended at least this long ago

const tOf = (b) => Date.parse(b && b.timestamp != null ? b.timestamp : b && b.t);
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const barTime = (ms) => (Number.isFinite(ms) ? hhmm(etOf(ms).min) : null);
const iso = (ms) => new Date(ms).toISOString();
const errText = (e) => String((e && e.message) || e).slice(0, 160);

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
 * clock the scans read; `log` the caller's journal. See the header for when the second source is read and what is appended.
 * The second source is `fetchBars` ({ symbols, startMs, endMs } -> fetchAlpacaBars' shape) when given, else Alpaca's bars endpoint with
 * `headers`; without either the feed is Yahoo's alone. `src` labels appended bars (default 'alpaca-<feed>'), `sourceKey` names the
 * source in the journal rows' per-symbol entries (default 'alpaca'), `detach` makes the shadow's read run without holding the call,
 * and `maxStep` (armed) refuses a batch whose first new close is that far from Yahoo's newest. The engine passes none of the four.
 */
function createBarsFallback({ getBars, headers, feed = 'iex', shadow = false, symbols = [], now = Date.now, log = null, fetchFn = globalThis.fetch,
  staleMs = STALE_MS, cacheMs = CACHE_MS, retryMs = RETRY_MS, timeoutMs = FETCH_MS, fetchBars = null, src = null, sourceKey = 'alpaca',
  detach = false, maxStep = null } = {}) {
  if (typeof getBars !== 'function') throw new Error('bars fallback: getBars(sym, tf) required');
  const source = typeof fetchBars === 'function' ? fetchBars
    : (headers ? (q) => fetchAlpacaBars({ ...q, feed, headers, fetchFn, timeoutMs }) : null);
  const label = src || `alpaca-${feed}`;
  const known = new Set();            // every symbol the caller reads: one read covers them all
  const yahooLast = {};               // sym -> the start of Yahoo's newest bar at its latest read
  let batch = null;                   // { day, at, symbols: Set, bars }
  let inflight = null;
  let failedAt = -Infinity, failLogged = -Infinity;
  let loggedKey = null;               // `${day}:${newest}` of the latest journal row
  const refusedLogged = new Set();    // `${day}:${sym}` of a batch refused for its price step
  const stats = { reads: 0, failures: 0, served: 0, appended: 0 };
  const seed = (list) => { for (const s of list || []) { const u = String(s).trim().toUpperCase(); if (SYMBOL_RX.test(u)) known.add(u); } };
  seed(symbols);
  const journal = (row) => { if (typeof log === 'function') { try { log(row); } catch (_e) { /* journal only */ } } };

  /** The session's bars of the second source for every known symbol, from the cache or one read; null while a read fails. */
  function read(day, t) {
    if (batch && batch.day === day && t - batch.at < cacheMs && [...known].every((s) => batch.symbols.has(s))) return Promise.resolve(batch);
    if (t - failedAt < retryMs) return Promise.resolve(null);
    if (inflight) return inflight;
    const list = [...known].sort();
    inflight = (async () => {
      stats.reads++;
      let res;
      try { res = await source({ symbols: list, startMs: etInstant(day, OPEN_MIN), endMs: t }); } catch (e) { res = { ok: false, status: 0, why: errText(e) }; }
      if (!res || !res.ok) {
        failedAt = t; stats.failures++;
        if (t - failLogged >= retryMs) {
          failLogged = t;
          journal({ event: 'bars_fallback_failed', day, at: iso(t), feed, status: res ? res.status : 0, why: res ? res.why : 'no answer', symbols: list.length, shadow: !!shadow });
        }
        return null;
      }
      batch = { day, at: t, symbols: new Set(list), bars: res.bars };
      return batch;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** One journal row per newest bar of the second source while Yahoo is late. */
  function note(day, t, got, trigger, lagMs) {
    let newest = -Infinity;
    for (const rows of Object.values(got.bars)) { const bt = rows.length ? tOf(rows[rows.length - 1]) : NaN; if (bt <= t && bt > newest) newest = bt; }
    const key = `${day}:${newest}`;
    if (key === loggedKey) return;
    loggedKey = key;
    const per = {};
    for (const s of [...got.symbols].sort()) {
      const rows = got.bars[s] || []; const y = yahooLast[s];
      per[s] = { yahoo: Number.isFinite(y) && etOf(y).day === day ? barTime(y) : null, [sourceKey]: rows.length ? barTime(tOf(rows[rows.length - 1])) : null };
    }
    journal({ event: shadow ? 'bars_fallback_shadow' : 'bars_fallback', day, at: iso(t), feed, trigger, lag_s: Math.round(lagMs / 1000),
      newest_bar: Number.isFinite(newest) ? barTime(newest) : null, symbols: per, shadow: !!shadow });
  }

  async function wrapped(sym, tf = '5m') {
    const r = await getBars(sym, tf);
    if (tf !== '5m' || !source) return r;
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
    if (shadow && detach) {
      // the stable box: the shadow never holds a pass; the read and its row run on their own
      read(e.day, t).then((got) => { if (got) note(e.day, t, got, S, lagMs); }).catch(() => {});
      return r;
    }
    const got = await read(e.day, t);
    if (!got) return r;
    note(e.day, t, got, S, lagMs);
    const add = (got.bars[S] || []).filter((b) => { const bt = tOf(b); return bt > lastT && bt <= t; });
    if (!add.length || shadow) return r;
    if (Number.isFinite(maxStep) && maxStep > 0) {
      const yb = bars.find((b) => tOf(b) === lastT);
      const yc = yb ? Number(yb.close) : NaN, ac = Number(add[0].close);
      if (Number.isFinite(yc) && yc > 0 && Math.abs(ac / yc - 1) > maxStep) {
        const k = `${e.day}:${S}`;
        if (!refusedLogged.has(k)) {
          refusedLogged.add(k);
          journal({ event: 'bars_fallback_refused', day: e.day, at: iso(t), feed, symbol: S, yahoo_close: yc, first_close: ac,
            why: `the first new close is ${((ac / yc - 1) * 100).toFixed(1)} % from Yahoo's newest (limit ${Math.round(maxStep * 100)} %)`, shadow: false });
        }
        return r;
      }
    }
    stats.served++; stats.appended += add.length;
    return { ...r, bars: bars.concat(add), count: bars.length + add.length,
      fallback: { src: label, appended: add.length, yahoo_last: iso(lastT), last: add[add.length - 1].timestamp } };
  }

  return { getBars: wrapped, seed, feed, shadow: !!shadow, stats };
}

// ── IBKR, the stable box's second source ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * One pacer for every IBKR market-data request of a process: one at a time, `gapMs` between starts, at most `perMinute` in any minute,
 * none at all for `coolMs` after IBKR answers 429. Past a limit it REFUSES ({ ok: false, paced: true }) instead of queueing, so a late
 * Yahoo feed can never stack requests onto the session the orders use. `run(fn)` resolves fn's { ok, status, json, error }; never throws.
 */
function createIbkrPacer({ gapMs = PACE_GAP_MS, perMinute = PACE_PER_MIN, coolMs = PACE_COOL_MS, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let last = -Infinity, coolUntil = -Infinity;
  const starts = [];
  const stats = { requests: 0, refused: 0, cooled: 0 };
  function run(fn) {
    const job = chain.then(async () => {
      const t0 = now();
      if (t0 < coolUntil) { stats.refused++; return { ok: false, status: 0, json: null, error: 'paced: IBKR rate-limit cool-down', paced: true }; }
      while (starts.length && t0 - starts[0] >= 60000) starts.shift();
      if (starts.length >= perMinute) { stats.refused++; return { ok: false, status: 0, json: null, error: `paced: ${perMinute} requests in the last minute`, paced: true }; }
      const wait = last + gapMs - t0;
      if (wait > 0) await sleep(wait);
      last = now(); starts.push(last); stats.requests++;
      let r;
      try { r = await fn(); } catch (e) { r = { ok: false, status: 0, json: null, error: errText(e) }; }
      if (r && r.status === 429) { coolUntil = now() + coolMs; stats.cooled++; }
      return r || { ok: false, status: 0, json: null, error: 'no answer' };
    });
    chain = job.then(() => {}, () => {});
    return job;
  }
  return { run, stats, coolUntil: () => coolUntil };
}

/** IBKR's /iserver/marketdata/history body -> { bars (parseBars' shape, src marked), availability, delay_ms, price_factor, error }. */
function ibkrBarsFromHistory(json, src = 'ibkr') {
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  if (!json || typeof json !== 'object') return { bars: [], availability: null, delay_ms: null, price_factor: null, error: 'empty body' };
  const availability = json.mdAvailability != null ? String(json.mdAvailability).slice(0, 8) : null;
  const delay_ms = num(json.mktDataDelay), price_factor = num(json.priceFactor);
  if (json.error) return { bars: [], availability, delay_ms, price_factor, error: String(json.error).slice(0, 160) };
  const bars = [];
  for (const d of Array.isArray(json.data) ? json.data : []) {
    const t = Number(d && d.t);
    const o = Number(d && d.o), h = Number(d && d.h), l = Number(d && d.l), c = Number(d && d.c);
    if (!Number.isFinite(t) || t <= 0 || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    bars.push({ timestamp: iso(t), open: o, high: h, low: l, close: c, volume: num(d.v) || 0, src });
  }
  bars.sort((x, y) => tOf(x) - tOf(y));
  return { bars, availability, delay_ms, price_factor, error: null };
}

/** A symbol's conid: { id } from the cache or one paced secdef search; { id: null, paced } when refused or unresolved (a miss is kept 30 min). */
async function ibkrConid(client, sym, { pacer, conids, now = Date.now }) {
  const hit = conids.get(sym);
  if (hit && hit.id) return { id: hit.id };
  if (hit && now() < hit.retryAt) return { id: null };
  const r = await pacer.run(async () => {
    const c = await client.searchContract(sym);
    return { ok: !!(c && Number(c.conid) > 0), status: c ? 200 : 0, json: c, error: c ? null : 'search failed' };
  });
  if (r && r.paced) return { id: null, paced: true };
  const id = r && r.ok ? Number(r.json.conid) : null;
  conids.set(sym, id ? { id } : { id: null, retryAt: now() + CONID_MISS_MS });
  return { id };
}

/** One contract's session bars from IBKR, paced: { ok, status, conid, parsed } or { ok: false, status, conid?, why, paced? }. */
async function ibkrSession(client, sym, { pacer, conids, now = Date.now, src = 'ibkr' }) {
  const c = await ibkrConid(client, sym, { pacer, conids, now });
  if (!c.id) return { ok: false, status: 0, why: c.paced ? 'paced' : 'no conid', paced: !!c.paced };
  const r = await pacer.run(() => client.getHistory(c.id, { period: '1d', bar: '5min', outsideRth: false }));
  if (!r || !r.ok) {
    return { ok: false, status: r ? r.status : 0, conid: c.id, paced: !!(r && r.paced),
      why: String((r && (r.error || (r.status ? `HTTP ${r.status}` : null))) || 'no answer').slice(0, 120) };
  }
  return { ok: true, status: r.status || 200, conid: c.id, parsed: ibkrBarsFromHistory(r.json, src) };
}

/**
 * IBKR's 5m bars of the session for `symbols`, startMs..endMs, in fetchAlpacaBars' shape: { ok, status, bars, md } or
 * { ok: false, status, why, md }. One paced request per symbol; a refusal (the pacer, or IBKR's 429) ends the read. `md` keeps, per
 * symbol, what IBKR said about its data (mdAvailability, mktDataDelay) or why it failed. Never throws.
 */
async function fetchIbkrBars({ client, symbols, startMs, endMs, pacer, conids, now = Date.now, src = 'ibkr' } = {}) {
  const list = [...new Set((symbols || []).map((s) => String(s).toUpperCase()))].filter((s) => SYMBOL_RX.test(s));
  if (!list.length) return { ok: false, status: 0, why: 'no symbols' };
  if (!client || typeof client.getHistory !== 'function' || typeof client.searchContract !== 'function') return { ok: false, status: 0, why: 'no IBKR client' };
  if (!pacer || !conids) return { ok: false, status: 0, why: 'no pacer' };
  const bars = {}, md = {};
  let status = 0, why = null;
  for (const sym of list) {
    let one;
    try { one = await ibkrSession(client, sym, { pacer, conids, now, src }); } catch (e) { one = { ok: false, status: 0, why: errText(e) }; }
    if (!one.ok) {
      status = one.status || status; md[sym] = { error: one.why }; why = why || `${sym}: ${one.why}`;
      if (one.paced || one.status === 429) break;
      continue;
    }
    const p = one.parsed;
    md[sym] = { availability: p.availability, delay_ms: p.delay_ms, ...(p.error ? { error: p.error } : {}) };
    if (p.error) { why = why || `${sym}: ${p.error}`; continue; }
    status = 200;
    const win = p.bars.filter((b) => { const bt = tOf(b); return bt >= startMs && bt <= endMs; });
    if (win.length) bars[sym] = win;
  }
  if (!Object.keys(bars).length) return { ok: false, status, why: String(why || 'no bars in the session').slice(0, 160), md };
  return { ok: true, status: 200, bars, md };
}

/** Today's bars of both feeds at clock t: each one's newest bar and its lag (s, negative = the forming bar is there), and the gaps (bp)
 *  on the settled bars both hold, matched on the same start and on Yahoo's bar one step earlier. */
function compareFeeds(ib, yb, t) {
  const day = etOf(t).day;
  const today = (rows) => (rows || []).filter((b) => { const bt = tOf(b); return Number.isFinite(bt) && bt <= t && etOf(bt).day === day; });
  const I = today(ib), Y = today(yb);
  const newest = (rows) => (rows.length ? tOf(rows[rows.length - 1]) : NaN);
  const lag = (bt) => (Number.isFinite(bt) ? Math.round((t - (bt + BAR_MS)) / 1000) : null);
  const ni = newest(I), ny = newest(Y);
  const ymap = new Map(Y.map((b) => [tOf(b), b]));
  const bp = (a, b) => Math.abs(Number(a) / Number(b) - 1) * 1e4;
  const gaps = (shift) => {
    const c = [], h = [], l = [];
    for (const b of I) {
      const bt = tOf(b);
      if (bt + BAR_MS > t - SETTLED_MS) continue;
      const y = ymap.get(bt - shift);
      if (!y) continue;
      c.push(bp(b.close, y.close)); h.push(bp(b.high, y.high)); l.push(bp(b.low, y.low));
    }
    return { c, h, l };
  };
  const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(2); };
  const max = (xs) => (xs.length ? +Math.max(...xs).toFixed(2) : null);
  const g0 = gaps(0), g1 = gaps(BAR_MS);
  return { ibkr_bars: I.length, ibkr_newest: Number.isFinite(ni) ? barTime(ni) : null, ibkr_lag_s: lag(ni),
    yahoo_bars: Y.length, yahoo_newest: Number.isFinite(ny) ? barTime(ny) : null, yahoo_lag_s: lag(ny),
    n: g0.c.length, close_med_bp: med(g0.c), close_max_bp: max(g0.c), high_med_bp: med(g0.h), low_med_bp: med(g0.l),
    n_shift: g1.c.length, close_med_bp_shift: med(g1.c) };
}

/**
 * THE PROBE: at each `slots` time (ET) of a regular session, one bars_ibkr_probe row on what IBKR serves for `symbols` against Yahoo.
 * kick(t) costs nothing outside a slot; a slot is tried once (a failure is a row too) and never caught up past PROBE_WINDOW_MIN.
 * Returns the running probe's promise (never rejects) or null.
 */
function createIbkrProbe({ clientOf, getBars, pacer, conids, symbols = PROBE_SYMBOLS, slots = PROBE_SLOTS, log = null, now = Date.now, src = 'ibkr' } = {}) {
  const done = new Set();
  let running = null;
  const journal = (row) => { if (typeof log === 'function') { try { log(row); } catch (_e) { /* journal only */ } } };
  const slotMin = slots.map((s) => { const [h, m] = String(s).split(':').map(Number); return { s, min: h * 60 + m }; });
  function due(t) {
    const e = etOf(t);
    if (!inRegularSession(e.day, e.min)) return null;
    for (const x of slotMin) if (e.min >= x.min && e.min < x.min + PROBE_WINDOW_MIN && !done.has(`${e.day}:${x.s}`)) return { day: e.day, slot: x.s };
    return null;
  }
  async function one(client, sym) {
    if (!client || typeof client.getHistory !== 'function' || typeof client.searchContract !== 'function') return { error: 'no IBKR client' };
    const s = await ibkrSession(client, sym, { pacer, conids, now, src });
    if (!s.ok) return { ...(s.conid ? { conid: s.conid } : {}), status: s.status, error: s.why };
    const tq = now();
    let y = null;
    try { y = await getBars(sym, '5m'); } catch (_e) { y = null; }
    const p = s.parsed;
    return { conid: s.conid, availability: p.availability, delay_ms: p.delay_ms, price_factor: p.price_factor, ...(p.error ? { error: p.error } : {}),
      ...compareFeeds(p.bars, y && Array.isArray(y.bars) ? y.bars : [], tq) };
  }
  async function probe(day, slot, t) {
    let client = null;
    try { client = typeof clientOf === 'function' ? clientOf() : null; } catch (_e) { client = null; }
    const out = {};
    for (const sym of symbols) { try { out[sym] = await one(client, sym); } catch (e) { out[sym] = { error: errText(e) }; } }
    journal({ event: 'bars_ibkr_probe', day, slot, at: iso(t), symbols: out, pacer: { ...pacer.stats }, shadow: true });
  }
  function kick(t = now()) {
    if (running) return running;
    const d = due(t);
    if (!d) return null;
    done.add(`${d.day}:${d.slot}`);
    running = probe(d.day, d.slot, t).catch(() => {}).finally(() => { running = null; });
    return running;
  }
  return { kick, done };
}

/**
 * The stable box's wiring (routes/trading.js): null unless TRADER_BARS_IBKR_FALLBACK is 'shadow' or '1' and the user's broker is IBKR;
 * else one instance per user and mode for the process: { mode, getBars (the overnight book's, wrapped), kick(t) (the probe), stats,
 * pacer }. The IBKR client is resolved at every read (facade.ibkrForUser), so the fallback rides the same client and session token the
 * orders use; the pacer keeps its requests far under IBKR's limits.
 */
const _stable = new Map();
function stableIbkrBars({ env = process.env, facade, broker, userId, getBars, log = null, now = Date.now } = {}) {
  const mode = String((env && env.TRADER_BARS_IBKR_FALLBACK) || '').trim().toLowerCase();
  if (mode !== 'shadow' && mode !== '1') return null;
  if (broker !== 'ibkr' || !facade || typeof facade.ibkrForUser !== 'function' || typeof getBars !== 'function') return null;
  const key = `${userId}|${mode}`;
  const hit = _stable.get(key);
  if (hit) return hit;
  const pacer = createIbkrPacer({ now });
  const conids = new Map();
  const clientOf = () => { try { return facade.ibkrForUser(userId); } catch (_e) { return null; } };
  const fb = createBarsFallback({ getBars, feed: 'ibkr', src: 'ibkr', sourceKey: 'ibkr', shadow: mode === 'shadow', detach: true, maxStep: MAX_STEP,
    cacheMs: IBKR_CACHE_MS, now, log, fetchBars: (q) => fetchIbkrBars({ ...q, client: clientOf(), pacer, conids, now }) });
  const probe = createIbkrProbe({ clientOf, getBars, pacer, conids, log, now });
  const s = { mode, getBars: fb.getBars, kick: (t) => probe.kick(t), stats: fb.stats, pacer };
  _stable.set(key, s);
  return s;
}
function _resetStableForTests() { _stable.clear(); }

module.exports = {
  createBarsFallback, fetchAlpacaBars, etInstant, toBar, STALE_MS, CACHE_MS, RETRY_MS, FETCH_MS, BARS_URL,
  createIbkrPacer, ibkrBarsFromHistory, fetchIbkrBars, compareFeeds, createIbkrProbe, stableIbkrBars, _resetStableForTests,
  MAX_STEP, IBKR_CACHE_MS, PACE_GAP_MS, PACE_PER_MIN, PACE_COOL_MS, PROBE_SLOTS, PROBE_SYMBOLS, PROBE_WINDOW_MIN,
};
