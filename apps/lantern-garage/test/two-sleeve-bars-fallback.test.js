'use strict';
/**
 * two-sleeve-bars-fallback.test.js — Alpaca's 5m bars behind a late Yahoo feed (2026-11-07, off by default).
 *
 * lib/two-sleeve/bars-fallback.js wraps the getBars the engine's custom scans read. Pinned on synthetic sessions and a fake Alpaca:
 *   - a live Yahoo feed (it holds the forming bar) is returned as it is, and Alpaca is never asked;
 *   - inside the session, a Yahoo feed whose newest bar ended over two minutes ago gets Alpaca's newer bars APPENDED, one read
 *     serving every symbol the worker reads; Yahoo's own bars are never changed; the shadow reads the same way, journals one row
 *     per newest Alpaca bar, and returns Yahoo's bars;
 *   - outside the session (pre-market, after the close, a weekend, a holiday, after a 13:00 close), for another timeframe, an
 *     empty or failed Yahoo read or a symbol Alpaca does not list, nothing is read;
 *   - a failing or slow Alpaca leaves Yahoo's bars, journals one row without any key, and waits a minute before the next read;
 *   - the 10-30 case end to end: with Yahoo late since 15:25, the overnight book's entry window and the close-IBS decision open
 *     on Alpaca's 15:50 bar, and stay shut without the fallback;
 *   - the scan worker: off unless TRADER_BARS_ALPACA_FALLBACK is set, inert without keys, the feed and mode in its ready row.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBarsFallback, fetchAlpacaBars, etInstant, STALE_MS, RETRY_MS } = require('../lib/two-sleeve/bars-fallback');
const { createOvernightScan } = require('../lib/two-sleeve/overnight-scan');
const { createCloseIbsScan, ONE_DECISION_BAR } = require('../lib/two-sleeve/closeibs-scan');
const { etOf } = require('../lib/market-calendar');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

const pad = (n) => String(n).padStart(2, '0');
/** The instant of an ET wall-clock time on `day`. */
function at(day, hh, mm, ss = 0) {
  for (const off of [4, 5]) { const ms = Date.parse(`${day}T${pad(hh + off)}:${pad(mm)}:${pad(ss)}Z`); const e = etOf(ms); if (e.day === day && e.min === hh * 60 + mm) return ms; }
  throw new Error(`no ET instant for ${day} ${hh}:${mm}`);
}
const MIN5 = 300000;
/** Yahoo-shaped 5m bars of `day` from 09:30 up to (not including) the bar starting at hh:mm, all at `c` with a 1-point range. */
function yahooSession(day, hh, mm, { c = 100, h = c + 0.5, l = c - 0.5 } = {}) {
  const out = [];
  for (let t = at(day, 9, 30); t < at(day, hh, mm); t += MIN5) out.push({ timestamp: new Date(t).toISOString(), open: c, high: h, low: l, close: c, volume: 1000 });
  return out;
}
/** Alpaca's series for one symbol: bars from 09:30 up to (not including) hh:mm, the ones from `fromHH:fromMM` at `late`. */
function alpacaSeries(day, hh, mm, { c = 100, late = null, from = null } = {}) {
  const out = [];
  for (let t = at(day, 9, 30); t < at(day, hh, mm); t += MIN5) {
    const p = late && from && t >= at(day, from[0], from[1]) ? late : { c, h: c + 0.5, l: c - 0.5 };
    out.push({ t, ...p });
  }
  return out;
}
/** A fake Alpaca bars endpoint over `series` (sym -> [{ t, c, h, l }]): it serves what lies inside the asked window. */
function fakeAlpaca(series, { status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url, headers: opts && opts.headers, symbols: u.searchParams.get('symbols').split(','), start: u.searchParams.get('start'),
      end: u.searchParams.get('end'), feed: u.searchParams.get('feed'), timeframe: u.searchParams.get('timeframe') });
    if (status !== 200) return { status, json: async () => ({ message: 'forbidden' }) };
    const s = Date.parse(u.searchParams.get('start')), e = Date.parse(u.searchParams.get('end'));
    const bars = {};
    for (const sym of u.searchParams.get('symbols').split(',')) {
      const rows = (series[sym] || []).filter((b) => b.t >= s && b.t <= e)
        .map((b) => ({ t: new Date(b.t).toISOString(), o: b.c, h: b.h != null ? b.h : b.c, l: b.l != null ? b.l : b.c, c: b.c, v: 100, n: 3, vw: b.c }));
      if (rows.length) bars[sym] = rows;
    }
    return { status: 200, json: async () => ({ bars, next_page_token: null }) };
  };
  return { fetchFn, calls };
}
const KEYS = { 'APCA-API-KEY-ID': 'test-id', 'APCA-API-SECRET-KEY': 'test-secret' };
/** A fake Yahoo over a map sym -> bars (the same object every call, as a cached read would be). */
function fakeYahoo(map) { const calls = []; return { calls, getBars: async (sym, tf) => { calls.push([sym, tf]); return map[`${sym}:${tf}`] || map[sym] || { bars: [] }; } }; }
const DAY = '2026-11-05';   // a Thursday, EST

test('a live Yahoo feed is returned as it is and Alpaca is never asked', async () => {
  const y = { bars: yahooSession(DAY, 16, 0) };   // holds the forming 15:55 bar at 15:56
  const A = fakeAlpaca({ SPY: alpacaSeries(DAY, 16, 0) });
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 15, 56), fetchFn: A.fetchFn });
  assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  // the newest bar closed under two minutes ago (no forming bar yet): still live
  const y2 = { bars: yahooSession(DAY, 15, 55) };
  const fb2 = createBarsFallback({ getBars: fakeYahoo({ SPY: y2 }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 15, 55) + STALE_MS, fetchFn: A.fetchFn });
  assert.strictEqual(await fb2.getBars('SPY', '5m'), y2);
  assert.equal(A.calls.length, 0);
});

test('late inside the session: one read for every symbol, Alpaca\'s newer bars appended, Yahoo\'s own untouched', async () => {
  const ySpy = { bars: yahooSession(DAY, 15, 30) }, yQqq = { bars: yahooSession(DAY, 15, 30, { c: 500 }) };   // newest bar 15:25
  const spyBefore = JSON.stringify(ySpy);
  const A = fakeAlpaca({ SPY: alpacaSeries(DAY, 16, 0, { late: { c: 99, h: 99.2, l: 98.9 }, from: [15, 30] }), QQQ: alpacaSeries(DAY, 16, 0, { c: 500 }) });
  const rows = [];
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: ySpy, QQQ: yQqq }).getBars, headers: KEYS, symbols: ['SPY', 'QQQ'], now: () => at(DAY, 15, 55, 30), fetchFn: A.fetchFn, log: (r) => rows.push(r) });
  const r = await fb.getBars('SPY', '5m');
  const q = await fb.getBars('QQQ', '5m');
  assert.equal(A.calls.length, 1, 'one read served both symbols');
  const c = A.calls[0];
  assert.deepEqual(c.symbols, ['QQQ', 'SPY']); assert.equal(c.feed, 'iex'); assert.equal(c.timeframe, '5Min');
  assert.equal(c.start, new Date(at(DAY, 9, 30)).toISOString()); assert.equal(c.end, new Date(at(DAY, 15, 55, 30)).toISOString());
  assert.equal(c.headers['APCA-API-KEY-ID'], 'test-id');
  assert.equal(r.bars.length, ySpy.bars.length + 6, '15:30 through the forming 15:55 bar');
  assert.deepEqual(r.bars.slice(0, ySpy.bars.length), ySpy.bars);
  assert.equal(JSON.stringify(ySpy), spyBefore, 'Yahoo\'s result is not mutated');
  const added = r.bars.slice(ySpy.bars.length);
  assert.ok(added.every((b) => b.src === 'alpaca-iex'));
  assert.equal(added[0].timestamp, new Date(at(DAY, 15, 30)).toISOString());
  assert.equal(added[4].close, 99); assert.equal(added[4].low, 98.9);
  assert.equal(r.fallback.appended, 6); assert.equal(r.fallback.src, 'alpaca-iex');
  assert.equal(q.bars.length, yQqq.bars.length + 6);
  assert.equal(rows.length, 1); assert.equal(rows[0].event, 'bars_fallback');
  assert.equal(rows[0].trigger, 'SPY'); assert.equal(rows[0].newest_bar, '15:55'); assert.equal(rows[0].lag_s, 25 * 60 + 30);
  assert.deepEqual(rows[0].symbols, { QQQ: { yahoo: null, alpaca: '15:55' }, SPY: { yahoo: '15:25', alpaca: '15:55' } });
  assert.deepEqual(fb.stats, { reads: 1, failures: 0, served: 2, appended: 12 });
});

test('the shadow reads the same way, returns Yahoo\'s bars, and journals once per newest Alpaca bar', async () => {
  const y = { bars: yahooSession(DAY, 14, 15) };   // newest 14:10
  const A = fakeAlpaca({ SPY: alpacaSeries(DAY, 16, 0) });
  const rows = []; let clock = at(DAY, 14, 40, 30);
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], shadow: true, now: () => clock, fetchFn: A.fetchFn, log: (r) => rows.push(r) });
  assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  assert.equal(rows.length, 1); assert.equal(rows[0].event, 'bars_fallback_shadow'); assert.equal(rows[0].shadow, true); assert.equal(rows[0].newest_bar, '14:40');
  clock += 10000; await fb.getBars('SPY', '5m');
  assert.equal(A.calls.length, 1, 'inside the 15 s cache: no second read');
  clock += 10000; await fb.getBars('SPY', '5m');
  assert.equal(A.calls.length, 2, 'past the cache: read again');
  assert.equal(rows.length, 1, 'the same newest bar: no second row');
  clock = at(DAY, 14, 45, 30); await fb.getBars('SPY', '5m');
  assert.equal(rows.length, 2); assert.equal(rows[1].newest_bar, '14:45');
  assert.equal(fb.stats.appended, 0);
});

test('outside the regular session, nothing is read; a 13:00 close ends the session at 13:00', async () => {
  const cases = [
    [DAY, 9, 29, yahooSession('2026-11-04', 16, 0)],           // pre-market, yesterday's bars only
    [DAY, 16, 0, yahooSession(DAY, 15, 0)],                    // the close
    ['2026-11-07', 12, 0, yahooSession('2026-11-06', 16, 0)],  // a Saturday
    ['2026-11-26', 12, 0, yahooSession('2026-11-25', 16, 0)],  // Thanksgiving
    ['2026-11-27', 13, 5, yahooSession('2026-11-27', 12, 30)], // after the 13:00 close
  ];
  for (const [day, hh, mm, bars] of cases) {
    const A = fakeAlpaca({ SPY: alpacaSeries(day, 13, 0) });
    const y = { bars };
    const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(day, hh, mm, 30), fetchFn: A.fetchFn });
    assert.strictEqual(await fb.getBars('SPY', '5m'), y, `${day} ${hh}:${mm}`);
    assert.equal(A.calls.length, 0, `${day} ${hh}:${mm}`);
  }
  // inside the short session it works as on any day
  const A = fakeAlpaca({ SPY: alpacaSeries('2026-11-27', 13, 0) });
  const y = { bars: yahooSession('2026-11-27', 12, 30) };
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at('2026-11-27', 12, 55, 30), fetchFn: A.fetchFn });
  const r = await fb.getBars('SPY', '5m');
  assert.equal(A.calls.length, 1); assert.equal(r.bars.length, y.bars.length + 6);
  // a feed with nothing today is late from the 09:30 open
  const A2 = fakeAlpaca({ SPY: alpacaSeries(DAY, 16, 0) });
  const y2 = { bars: yahooSession('2026-11-04', 16, 0) };
  const fb2 = createBarsFallback({ getBars: fakeYahoo({ SPY: y2 }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 9, 31, 30), fetchFn: A2.fetchFn });
  assert.strictEqual(await fb2.getBars('SPY', '5m'), y2, '09:31:30: under two minutes into the session');
  const fb3 = createBarsFallback({ getBars: fakeYahoo({ SPY: y2 }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 9, 42, 30), fetchFn: A2.fetchFn });
  const r3 = await fb3.getBars('SPY', '5m');
  assert.equal(r3.bars.length, y2.bars.length + 3, 'the 09:30, 09:35 and the forming 09:40 bar');
});

test('another timeframe, an empty or failed Yahoo read, a symbol Alpaca does not list, no keys: untouched, nothing read', async () => {
  const A = fakeAlpaca({ SPY: alpacaSeries(DAY, 16, 0) });
  const now = () => at(DAY, 15, 55, 30);
  const daily = { bars: [{ timestamp: new Date(at('2026-11-04', 9, 30)).toISOString(), open: 1, high: 1, low: 1, close: 1 }] };
  const empty = { bars: [], error: 'HTTP 429' };
  const late = { bars: yahooSession(DAY, 15, 30) };
  const Y = fakeYahoo({ 'SPY:1d': daily, 'QQQ:5m': empty, 'BTC-USD:5m': late, 'SPY:5m': late });
  const fb = createBarsFallback({ getBars: Y.getBars, headers: KEYS, now, fetchFn: A.fetchFn });
  assert.strictEqual(await fb.getBars('SPY', '1d'), daily);
  assert.strictEqual(await fb.getBars('QQQ', '5m'), empty);
  assert.strictEqual(await fb.getBars('BTC-USD', '5m'), late);
  const noKeys = createBarsFallback({ getBars: Y.getBars, headers: null, now, fetchFn: A.fetchFn });
  assert.strictEqual(await noKeys.getBars('SPY', '5m'), late);
  assert.equal(A.calls.length, 0);
  assert.throws(() => createBarsFallback({}), /getBars/);
});

test('Alpaca failing: Yahoo\'s bars, one row without any key, and a minute before the next read', async () => {
  const y = { bars: yahooSession(DAY, 15, 30) };
  const A = fakeAlpaca({}, { status: 403 });
  const rows = []; let clock = at(DAY, 15, 55, 30);
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => clock, fetchFn: A.fetchFn, log: (r) => rows.push(r) });
  assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  assert.equal(rows.length, 1); assert.equal(rows[0].event, 'bars_fallback_failed'); assert.equal(rows[0].status, 403); assert.equal(rows[0].why, 'HTTP 403');
  assert.ok(!JSON.stringify(rows).includes('test-secret') && !JSON.stringify(rows).includes('test-id'), 'no key in the journal');
  clock += 30000; assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  assert.equal(A.calls.length, 1, 'no retry inside a minute');
  clock += RETRY_MS; await fb.getBars('SPY', '5m');
  assert.equal(A.calls.length, 2); assert.equal(rows.length, 2);
  assert.equal(fb.stats.failures, 2);
});

test('a slow Alpaca is cut at the read\'s own limit; pages are followed', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  const y = { bars: yahooSession(DAY, 15, 30) };
  const rows = [];
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 15, 55, 30), fetchFn: hang, timeoutMs: 50, log: (r) => rows.push(r) });
  const t0 = Date.now();
  assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(rows[0].why, 'timeout after 50 ms');
  // two pages
  const urls = [];
  const paged = async (url) => {
    urls.push(url);
    const second = /page_token=p2/.test(url);
    const t = second ? at(DAY, 15, 35) : at(DAY, 15, 30);
    return { status: 200, json: async () => ({ bars: { SPY: [{ t: new Date(t).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 }] }, next_page_token: second ? null : 'p2' }) };
  };
  const r = await fetchAlpacaBars({ symbols: ['SPY'], startMs: at(DAY, 9, 30), endMs: at(DAY, 15, 40), headers: KEYS, fetchFn: paged });
  assert.equal(r.ok, true); assert.equal(r.pages, 2); assert.equal(urls.length, 2);
  assert.deepEqual(r.bars.SPY.map((b) => b.timestamp), [new Date(at(DAY, 15, 30)).toISOString(), new Date(at(DAY, 15, 35)).toISOString()]);
  assert.equal(etInstant(DAY, 570), Date.parse('2026-11-05T14:30:00Z'));
  assert.equal(etInstant('2026-10-30', 570), Date.parse('2026-10-30T13:30:00Z'));
});

test('Alpaca no newer than Yahoo: nothing appended', async () => {
  const y = { bars: yahooSession(DAY, 15, 30) };
  const A = fakeAlpaca({ SPY: alpacaSeries(DAY, 15, 30) });   // stops at the same 15:25 bar
  const fb = createBarsFallback({ getBars: fakeYahoo({ SPY: y }).getBars, headers: KEYS, symbols: ['SPY'], now: () => at(DAY, 15, 55, 30), fetchFn: A.fetchFn });
  assert.strictEqual(await fb.getBars('SPY', '5m'), y);
  assert.equal(A.calls.length, 1); assert.equal(fb.stats.appended, 0);
});

test('the 10-30 case end to end: the overnight book and the close-IBS decision open on Alpaca\'s 15:50 bar', async () => {
  const now = at(DAY, 15, 55, 30);
  // daily closes rising 80 -> 100 over 250 sessions: the prior close is above its 200-session mean
  const daily = { bars: Array.from({ length: 250 }, (_, i) => ({ timestamp: new Date(Date.parse('2025-11-04T14:30:00Z') + i * 86400000).toISOString(), open: 1, high: 1, low: 1, close: 80 + i * 0.08 })) };
  daily.bars = daily.bars.filter((b) => b.timestamp.slice(0, 10) < DAY);
  const late5m = { bars: yahooSession(DAY, 15, 30) };   // Yahoo stopped at the 15:25 bar, IBS there 0.5
  const map = { 'SPY:5m': late5m, 'SPY:1d': daily };
  const series = { SPY: alpacaSeries(DAY, 16, 0, { late: { c: 99, h: 99.2, l: 98.9 }, from: [15, 30] }) };
  const run = async (mode) => {
    const A = fakeAlpaca(series); const rows = [];
    const Y = fakeYahoo(map);
    const getBars = mode === 'off' ? Y.getBars
      : createBarsFallback({ getBars: Y.getBars, headers: KEYS, symbols: ['SPY'], shadow: mode === 'shadow', now: () => now, fetchFn: A.fetchFn, log: (r) => rows.push(r) }).getBars;
    const O = await createOvernightScan({ symbols: ['SPY'], getBars }).scan(now);
    const C = await createCloseIbsScan({ symbols: ['SPY'], getBars, decisionBars: ONE_DECISION_BAR }).scan(now);
    return { o: O.signals[0], c: C.signals[0], oWin: O.overnight.window, cWin: C.closeIbs.window, rows, reads: A.calls.length };
  };
  // without it, as on 10-30: the book still reads its morning SELL window ("bearish, no long to exit"), never the entry window
  const off = await run('off');
  assert.equal(off.oWin, 'sell', 'no entry window: the 15:50 bar never came'); assert.equal(off.o.direction, 'BEARISH');
  assert.equal(off.c.convergence.decision, 'SKIP'); assert.equal(off.cWin, false);
  const armed = await run('armed');
  assert.equal(armed.oWin, 'entry'); assert.equal(armed.o.direction, 'BULLISH'); assert.equal(armed.o.convergence.decision, 'ENTER');
  assert.equal(armed.o.entry_price, 99); assert.equal(armed.o.decision_context.overnight_bar, '15:55');
  assert.equal(armed.cWin, true); assert.equal(armed.c.direction, 'BULLISH'); assert.equal(armed.c.convergence.decision, 'ENTER');
  assert.ok(armed.c.decision_context.ibs <= 0.15, `IBS ${armed.c.decision_context.ibs}`);
  assert.equal(armed.reads, 1, 'the cache served the second scan');
  const shadow = await run('shadow');
  assert.equal(shadow.oWin, 'sell'); assert.equal(shadow.o.direction, 'BEARISH'); assert.equal(shadow.c.convergence.decision, 'SKIP');
  assert.equal(shadow.rows.length, 1); assert.equal(shadow.rows[0].event, 'bars_fallback_shadow'); assert.equal(shadow.rows[0].newest_bar, '15:55');
});

test('the scan worker: off unless the knob is set, inert without keys, its mode and feed in the ready row', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'barsfb-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = (...p) => path.resolve(__dirname, '..', 'lib', ...p).replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'monthend-scan.js'), `module.exports = require(${JSON.stringify(real('two-sleeve', 'monthend-scan.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), `module.exports = require(${JSON.stringify(real('file-queue.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async (s, tf) => ({ bars: tf === '1d' ? [] : [bar(Date.parse('2026-11-06T20:55:00Z'), 90)] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsfb-dir-'));
  const NO_KEYS = { ALPACA_API_KEY_ID: '', ALPACA_API_KEY: '', APCA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '', ALPACA_API_SECRET: '', ALPACA_SECRET_KEY: '', APCA_API_SECRET_KEY: '' };
  const FAKE_KEYS = { ...NO_KEYS, ALPACA_API_KEY_ID: 'test-id', ALPACA_API_SECRET_KEY: 'test-secret' };
  const log = [];
  // a Saturday clock: the fallback, where on, never reaches the network in this test
  const mk = (id, env) => new ScanWorker({ id, app, envFile: null, env, universe: ['TLT'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'monthend', fakeNow: '2026-11-07T17:00:00.000Z' });
  const W = [mk('T0', { ...FAKE_KEYS }), mk('T1', { ...FAKE_KEYS, TRADER_BARS_ALPACA_FALLBACK: 'shadow' }), mk('T2', { ...FAKE_KEYS, TRADER_BARS_ALPACA_FALLBACK: '1', TRADER_BARS_ALPACA_FEED: 'sip' }),
    mk('T3', { ...NO_KEYS, TRADER_BARS_ALPACA_FALLBACK: '1' })];
  try {
    for (const w of W) { const r = await w.scan(); assert.deepEqual(r.signals.map((x) => x.symbol), ['TLT']); }
    const ready = (id) => log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === id);
    assert.equal(ready('T0').barsFallback, null);
    assert.equal(ready('T1').barsFallback, 'shadow (iex)');
    assert.equal(ready('T2').barsFallback, 'armed (sip)');
    assert.equal(ready('T3').barsFallback, 'armed: no Alpaca keys, inert');
    assert.ok(!JSON.stringify(log).includes('test-secret'), 'no key in the engine journal');
  } finally { for (const w of W) w.stop(); }
});
