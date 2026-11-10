'use strict';
/**
 * stable-ibkr-bars-fallback.test.js — IBKR's 5m bars behind a late Yahoo feed for the stable box's overnight book (2026-11-09, off by
 * default; lib/two-sleeve/bars-fallback.js stableIbkrBars). Pinned on synthetic sessions and a fake IBKR client:
 *   - IbkrCpapi.getHistory asks for one contract's session bars, read-only; the history body becomes bars in Yahoo's shape, with what
 *     IBKR says about its data (mdAvailability, mktDataDelay);
 *   - every request goes through one pacer: one at a time, a gap between starts, a cap per minute, nothing during a 429 cool-down,
 *     and it refuses rather than queues;
 *   - conids are looked up once; a symbol IBKR cannot resolve costs no bar request;
 *   - the shadow never holds the pass: Yahoo's bars at once, the row when IBKR answers;
 *   - armed, IBKR's newer bars are appended, and a batch at the wrong price scale is refused;
 *   - IBKR refusing (no market data, 401, 429) leaves Yahoo's bars and one failed row; a 429 silences IBKR for the cool-down;
 *   - the probe runs at its three slots, each once, never catching up, and shows a bar labelled by its end;
 *   - the wiring is off unless TRADER_BARS_IBKR_FALLBACK is set and the broker is IBKR; armed, the 10-30 case opens the book's entry
 *     window on IBKR's 15:50 bar, the shadow leaves it shut.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const IbkrCpapi = require('../lib/ibkr-cpapi');
const {
  createBarsFallback, createIbkrPacer, ibkrBarsFromHistory, fetchIbkrBars, createIbkrProbe, stableIbkrBars, _resetStableForTests, MAX_STEP,
} = require('../lib/two-sleeve/bars-fallback');
const { createOvernightScan } = require('../lib/two-sleeve/overnight-scan');
const { etOf } = require('../lib/market-calendar');

const pad = (n) => String(n).padStart(2, '0');
/** The instant of an ET wall-clock time on `day`. */
function at(day, hh, mm, ss = 0) {
  for (const off of [4, 5]) { const ms = Date.parse(`${day}T${pad(hh + off)}:${pad(mm)}:${pad(ss)}Z`); const e = etOf(ms); if (e.day === day && e.min === hh * 60 + mm) return ms; }
  throw new Error(`no ET instant for ${day} ${hh}:${mm}`);
}
const MIN5 = 300000;
const iso = (ms) => new Date(ms).toISOString();
const DAY = '2026-11-05';   // a Thursday, EST
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Bars of `day` from 09:30 up to (not including) hh:mm: closes `c` (or base + 0.1 a bar with `ramp`), the ones from `from` at `late`. */
function series(day, hh, mm, { c = 100, ramp = false, late = null, from = null } = {}) {
  const out = []; let k = 0;
  for (let t = at(day, 9, 30); t < at(day, hh, mm); t += MIN5, k++) {
    const close = ramp ? +(c + k * 0.1).toFixed(2) : c;
    const p = late && from && t >= at(day, from[0], from[1]) ? late : { c: close, h: +(close + 0.05).toFixed(2), l: +(close - 0.05).toFixed(2) };
    out.push({ t, ...p });
  }
  return out;
}
/** Yahoo-shaped bars from a series. */
const yahooOf = (rows) => ({ bars: rows.map((b) => ({ timestamp: iso(b.t), open: b.c, high: b.h, low: b.l, close: b.c, volume: 1000 })) });
/** A fake Yahoo over a map sym -> bars (the same object every call, as a cached read would be). */
function fakeYahoo(map) { const calls = []; return { calls, getBars: async (sym, tf) => { calls.push([sym, tf]); return map[`${sym}:${tf}`] || map[sym] || { bars: [] }; } }; }
/** A fake IBKR client over `rows` (sym -> series): conids from `conids`; `label: 'end'` stamps a bar with its END, as a check. */
function fakeIbkr(rows, { conids = { SPY: 756733, QQQ: 320227571, SMH: 237937002, TLT: 15547841 }, status = 200, body = null, availability = 'RpB', delayMs = 0, label = 'start' } = {}) {
  const calls = { search: [], history: [] };
  return {
    calls,
    searchContract: async (sym) => { calls.search.push(sym); const id = conids[sym]; return id ? { conid: id, symbol: sym, description: 'ARCA' } : null; },
    getHistory: async (conid, opts) => {
      calls.history.push({ conid, ...opts });
      if (status !== 200) return { ok: false, status, json: null, error: `http_${status}` };
      if (body) return { ok: true, status: 200, json: body };
      const sym = Object.keys(conids).find((k) => conids[k] === conid);
      const data = (rows[sym] || []).map((b) => ({ t: label === 'end' ? b.t + MIN5 : b.t, o: b.c, h: b.h, l: b.l, c: b.c, v: 100 }));
      return { ok: true, status: 200, json: { symbol: sym, mdAvailability: availability, mktDataDelay: delayMs, priceFactor: 100, data } };
    },
  };
}
const freePacer = (now = Date.now) => createIbkrPacer({ gapMs: 0, perMinute: 1000, now });
/** The stable-style wrapper around a fake client (the options stableIbkrBars passes). */
function stableFb({ yahoo, client, shadow = false, now, log, pacer = freePacer(), conids = new Map() }) {
  return createBarsFallback({ getBars: fakeYahoo(yahoo).getBars, feed: 'ibkr', src: 'ibkr', sourceKey: 'ibkr', shadow, detach: true, maxStep: MAX_STEP,
    symbols: Object.keys(yahoo), now, log, fetchBars: (q) => fetchIbkrBars({ ...q, client, pacer, conids }) });
}

test('IbkrCpapi.getHistory asks for one contract\'s session bars, read-only, and refuses a bad conid', async () => {
  const c = new IbkrCpapi({ baseUrl: 'https://localhost:5000/v1/api' });
  const seen = [];
  c._request = async (method, p, body) => { seen.push({ method, p, body }); return { ok: true, status: 200, json: { data: [] } }; };
  const r = await c.getHistory(756733);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ method: 'GET', p: '/iserver/marketdata/history?conid=756733&period=1d&bar=5min&outsideRth=false', body: undefined }]);
  const bad = await c.getHistory('x');
  assert.equal(bad.ok, false); assert.equal(bad.error, 'bad_conid'); assert.equal(seen.length, 1, 'no request for a bad conid');
});

test('the history body becomes bars in Yahoo\'s shape, with what IBKR says about its data; an error body and bad rows are handled', () => {
  const p = ibkrBarsFromHistory({ mdAvailability: 'RpB', mktDataDelay: 0, priceFactor: 100, data: [
    { t: at(DAY, 9, 35), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: at(DAY, 9, 30), o: 1, h: 1, l: 1, c: 1, v: 5 }, { t: 'x', o: 1 }, { t: at(DAY, 9, 40), o: 0, h: 1, l: 1, c: 1 }] });
  assert.deepEqual(p.bars.map((b) => b.timestamp), [iso(at(DAY, 9, 30)), iso(at(DAY, 9, 35))]);
  assert.deepEqual(p.bars[1], { timestamp: iso(at(DAY, 9, 35)), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, src: 'ibkr' });
  assert.equal(p.availability, 'RpB'); assert.equal(p.delay_ms, 0); assert.equal(p.price_factor, 100); assert.equal(p.error, null);
  const e = ibkrBarsFromHistory({ error: 'Chart data unavailable', mdAvailability: 'N' });
  assert.equal(e.error, 'Chart data unavailable'); assert.equal(e.bars.length, 0); assert.equal(e.availability, 'N');
  assert.equal(ibkrBarsFromHistory(null).error, 'empty body');
});

test('fetchIbkrBars: one paced request per symbol, conids looked up once, the session window kept', async () => {
  const rows = { SPY: series(DAY, 16, 0), QQQ: series(DAY, 16, 0, { c: 500 }) };
  const C = fakeIbkr(rows);
  const pacer = freePacer(); const conids = new Map();
  const win = { startMs: at(DAY, 9, 30), endMs: at(DAY, 15, 55, 30) };
  const r = await fetchIbkrBars({ client: C, symbols: ['spy', 'QQQ', 'BTC-USD'], ...win, pacer, conids });
  assert.equal(r.ok, true);
  assert.deepEqual(C.calls.search, ['SPY', 'QQQ'], 'a non-stock symbol is never asked');
  assert.deepEqual(C.calls.history.map((h) => [h.conid, h.period, h.bar, h.outsideRth]), [[756733, '1d', '5min', false], [320227571, '1d', '5min', false]]);
  assert.equal(r.bars.SPY.length, 78, '09:30 through the forming 15:55 bar'); assert.equal(r.bars.QQQ[0].close, 500);
  assert.ok(r.bars.SPY.every((b) => b.src === 'ibkr'));
  assert.deepEqual(r.md.SPY, { availability: 'RpB', delay_ms: 0 });
  const early = await fetchIbkrBars({ client: C, symbols: ['SPY'], startMs: at(DAY, 9, 30), endMs: at(DAY, 10, 0), pacer, conids });
  assert.equal(early.bars.SPY.length, 7, 'bars past endMs are left out');
  assert.equal(C.calls.search.length, 2, 'the conid is kept');
  // a symbol IBKR cannot resolve: no bar request for it, and it is not asked again inside 30 minutes
  const C2 = fakeIbkr(rows, { conids: { SPY: 756733 } });
  const cx = new Map();
  const r2 = await fetchIbkrBars({ client: C2, symbols: ['SPY', 'XYZ'], ...win, pacer, conids: cx });
  assert.equal(r2.ok, true); assert.deepEqual(r2.md.XYZ, { error: 'no conid' }); assert.equal(C2.calls.history.length, 1);
  await fetchIbkrBars({ client: C2, symbols: ['SPY', 'XYZ'], ...win, pacer, conids: cx });
  assert.deepEqual(C2.calls.search, ['SPY', 'XYZ'], 'the miss is remembered');
  assert.equal((await fetchIbkrBars({ client: null, symbols: ['SPY'], ...win, pacer, conids })).why, 'no IBKR client');
});

test('the pacer: one request at a time, a gap between starts, a cap a minute, a cool-down after a 429, and it never throws', async () => {
  let clock = 0; const slept = [];
  const pacer = createIbkrPacer({ gapMs: 1100, perMinute: 3, coolMs: 900000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  let active = 0, most = 0;
  const job = (status = 200) => pacer.run(async () => { active++; most = Math.max(most, active); await new Promise((r) => setImmediate(r)); active--; return { ok: status === 200, status }; });
  const rs = await Promise.all([job(), job(), job(), job()]);
  assert.equal(most, 1, 'one at a time');
  assert.deepEqual(slept, [1100, 1100], 'the second and third wait for the gap');
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true, false]);
  assert.equal(rs[3].paced, true); assert.match(rs[3].error, /3 requests in the last minute/);
  clock += 60000;
  assert.equal((await job(429)).status, 429);
  const cooled = await job();
  assert.equal(cooled.paced, true); assert.match(cooled.error, /cool-down/);
  clock += 900000;
  assert.equal((await job()).ok, true);
  assert.deepEqual(pacer.stats, { requests: 5, refused: 2, cooled: 1 });
  const thrown = await pacer.run(async () => { throw new Error('boom'); });
  assert.equal(thrown.ok, false); assert.equal(thrown.error, 'boom');
});

test('the shadow never holds the pass: Yahoo\'s bars at once, one row when IBKR answers', async () => {
  const y = { SPY: yahooOf(series(DAY, 15, 30)) };   // newest 15:25 at 15:55:30
  const C = fakeIbkr({ SPY: series(DAY, 16, 0) });
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { ...C, getHistory: async (...a) => { await gate; return C.getHistory(...a); } };
  const rows = [];
  const fb = stableFb({ yahoo: y, client: slow, shadow: true, now: () => at(DAY, 15, 55, 30), log: (r) => rows.push(r) });
  assert.strictEqual(await fb.getBars('SPY', '5m'), y.SPY, 'Yahoo\'s own result, at once');
  assert.equal(rows.length, 0, 'IBKR has not answered yet');
  release(); await settle();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'bars_fallback_shadow'); assert.equal(rows[0].feed, 'ibkr'); assert.equal(rows[0].shadow, true);
  assert.equal(rows[0].newest_bar, '15:55'); assert.equal(rows[0].lag_s, 25 * 60 + 30);
  assert.deepEqual(rows[0].symbols, { SPY: { yahoo: '15:25', ibkr: '15:55' } });
  assert.equal(fb.stats.appended, 0);
});

test('armed: IBKR\'s newer bars are appended; a batch at the wrong price scale is refused, once a day in the journal', async () => {
  const y = { SPY: yahooOf(series(DAY, 15, 30)) };
  const C = fakeIbkr({ SPY: series(DAY, 16, 0, { late: { c: 99, h: 99.2, l: 98.9 }, from: [15, 30] }) });
  const rows = [];
  const r = await stableFb({ yahoo: y, client: C, now: () => at(DAY, 15, 55, 30), log: (x) => rows.push(x) }).getBars('SPY', '5m');
  const n = y.SPY.bars.length;
  assert.equal(r.bars.length, n + 6, '15:30 through the forming 15:55 bar');
  assert.deepEqual(r.bars.slice(0, n), y.SPY.bars, 'Yahoo\'s own bars untouched');
  assert.ok(r.bars.slice(n).every((b) => b.src === 'ibkr'));
  assert.equal(r.bars[n + 4].close, 99); assert.equal(r.fallback.src, 'ibkr'); assert.equal(r.fallback.appended, 6);
  assert.equal(rows.length, 1); assert.equal(rows[0].event, 'bars_fallback');
  // prices in cents (x100): refused
  const cents = fakeIbkr({ SPY: series(DAY, 16, 0, { c: 10000 }) });
  const rows2 = [];
  const fb2 = stableFb({ yahoo: y, client: cents, now: () => at(DAY, 15, 55, 30), log: (x) => rows2.push(x) });
  assert.strictEqual(await fb2.getBars('SPY', '5m'), y.SPY);
  await fb2.getBars('SPY', '5m');
  const refused = rows2.filter((x) => x.event === 'bars_fallback_refused');
  assert.equal(refused.length, 1); assert.equal(refused[0].symbol, 'SPY'); assert.match(refused[0].why, /9900\.0 % from Yahoo's newest \(limit 20 %\)/);
  assert.equal(fb2.stats.appended, 0);
});

test('IBKR refusing: no market data, a 401, a 429; Yahoo\'s bars, one failed row; a 429 silences IBKR for the cool-down', async () => {
  const y = { SPY: yahooOf(series(DAY, 15, 30)) };
  for (const [client, why] of [
    [fakeIbkr({}, { body: { error: 'Chart data unavailable', mdAvailability: 'N' } }), /^SPY: Chart data unavailable$/],
    [fakeIbkr({}, { status: 401 }), /^SPY: http_401$/],
  ]) {
    const rows = [];
    const fb = stableFb({ yahoo: y, client, now: () => at(DAY, 15, 55, 30), log: (r) => rows.push(r) });
    assert.strictEqual(await fb.getBars('SPY', '5m'), y.SPY);
    assert.equal(rows.length, 1); assert.equal(rows[0].event, 'bars_fallback_failed'); assert.equal(rows[0].feed, 'ibkr'); assert.match(rows[0].why, why);
  }
  let clock = at(DAY, 15, 55, 30);
  const C = fakeIbkr({}, { status: 429 });
  const pacer = createIbkrPacer({ gapMs: 0, perMinute: 1000, now: () => clock }); const conids = new Map();
  const win = { startMs: at(DAY, 9, 30), endMs: clock };
  const r = await fetchIbkrBars({ client: C, symbols: ['SPY', 'QQQ', 'SMH'], ...win, pacer, conids });
  assert.equal(r.ok, false); assert.equal(r.status, 429); assert.equal(C.calls.history.length, 1, 'the read stops at the first 429');
  clock += 60000;
  const again = await fetchIbkrBars({ client: C, symbols: ['SPY'], ...win, pacer, conids });
  assert.equal(C.calls.history.length, 1, 'nothing during the cool-down'); assert.match(again.why, /paced/);
});

test('the probe: three slots a session, each once and never caught up; what IBKR says, its newest bar, the gaps against Yahoo', async () => {
  const ramp = (c) => series(DAY, 10, 10, { c, ramp: true });
  const Y = { SPY: yahooOf(ramp(100)), QQQ: yahooOf(ramp(500)), SMH: yahooOf(ramp(300)) };
  const ids = { SPY: 1, QQQ: 2, SMH: 3 };
  const run = async (client, clock) => {
    const rows = []; let t = clock;
    const P = createIbkrProbe({ clientOf: () => client, getBars: fakeYahoo(Y).getBars, pacer: freePacer(() => t), conids: new Map(), log: (r) => rows.push(r), now: () => t });
    return { P, rows, set: (x) => { t = x; } };
  };
  const C = fakeIbkr({ SPY: ramp(100), QQQ: ramp(500), SMH: ramp(300) }, { conids: ids });
  const A = await run(C, at(DAY, 10, 0, 30));
  assert.equal(A.P.kick(at(DAY, 10, 0, 30)), null, '10:00: before the first slot');
  A.set(at(DAY, 10, 6, 10)); await A.P.kick(at(DAY, 10, 6, 10));
  assert.equal(A.rows.length, 1);
  const row = A.rows[0];
  assert.equal(row.event, 'bars_ibkr_probe'); assert.equal(row.slot, '10:05'); assert.equal(row.day, DAY); assert.equal(row.shadow, true);
  assert.deepEqual(Object.keys(row.symbols), ['SPY', 'QQQ', 'SMH']);
  const s = row.symbols.SPY;
  assert.equal(s.conid, 1); assert.equal(s.availability, 'RpB'); assert.equal(s.delay_ms, 0); assert.equal(s.price_factor, 100);
  assert.equal(s.ibkr_newest, '10:05'); assert.equal(s.yahoo_newest, '10:05'); assert.equal(s.ibkr_lag_s, -230, 'the forming bar is there');
  assert.equal(s.n, 7, 'the settled bars 09:30..10:00'); assert.equal(s.close_med_bp, 0); assert.equal(s.close_max_bp, 0);
  assert.ok(s.close_med_bp_shift > 5, `a one-bar shift shows: ${s.close_med_bp_shift}`);
  assert.equal(row.pacer.requests, 6, 'a search and a history request per name');
  A.set(at(DAY, 10, 20)); assert.equal(A.P.kick(at(DAY, 10, 20)), null, 'the 10:05 slot ran: not again');
  assert.equal(A.P.kick(at(DAY, 12, 30)), null, '12:30: past the 12:05 window, not caught up');
  A.set(at(DAY, 15, 52, 5)); await A.P.kick(at(DAY, 15, 52, 5));
  assert.equal(A.rows.length, 2); assert.equal(A.rows[1].slot, '15:52');
  // a bar stamped with its END: the same-time gaps are a bar's move, the shifted ones are zero
  const B = await run(fakeIbkr({ SPY: ramp(100), QQQ: ramp(500), SMH: ramp(300) }, { conids: ids, label: 'end' }), at(DAY, 10, 6, 10));
  await B.P.kick(at(DAY, 10, 6, 10));
  const e = B.rows[0].symbols.SPY;
  assert.ok(e.close_med_bp > 5, `same-time gap ${e.close_med_bp}`); assert.equal(e.close_med_bp_shift, 0);
  // no client: one row with the reason; outside the session nothing runs
  const N = await run(null, at(DAY, 10, 5, 30));
  await N.P.kick(at(DAY, 10, 5, 30));
  assert.deepEqual(N.rows[0].symbols.SPY, { error: 'no IBKR client' });
  assert.equal(N.P.kick(at('2026-11-07', 10, 6)), null, 'a Saturday');
  assert.equal(N.P.kick(at('2026-11-26', 10, 6)), null, 'Thanksgiving');
  // IBKR refusing the data: the row says so per name
  const R = await run(fakeIbkr({}, { conids: ids, body: { error: 'Chart data unavailable', mdAvailability: 'N' } }), at(DAY, 10, 5, 30));
  await R.P.kick(at(DAY, 10, 5, 30));
  assert.equal(R.rows[0].symbols.SPY.error, 'Chart data unavailable'); assert.equal(R.rows[0].symbols.SPY.availability, 'N');
});

test('the wiring: off unless TRADER_BARS_IBKR_FALLBACK is set, IBKR accounts only, one instance per user', () => {
  _resetStableForTests();
  const getBars = async () => ({ bars: [] });
  const facade = { ibkrForUser: () => fakeIbkr({}) };
  const on = { TRADER_BARS_IBKR_FALLBACK: 'shadow' };
  assert.equal(stableIbkrBars({ env: {}, facade, broker: 'ibkr', userId: 'local-owner', getBars }), null);
  assert.equal(stableIbkrBars({ env: { TRADER_BARS_IBKR_FALLBACK: 'yes' }, facade, broker: 'ibkr', userId: 'local-owner', getBars }), null);
  assert.equal(stableIbkrBars({ env: on, facade, broker: 'alpaca', userId: 'local-owner', getBars }), null, 'an Alpaca account');
  assert.equal(stableIbkrBars({ env: on, facade: {}, broker: 'ibkr', userId: 'local-owner', getBars }), null, 'no IBKR client to reach');
  const a = stableIbkrBars({ env: on, facade, broker: 'ibkr', userId: 'local-owner', getBars });
  assert.equal(a.mode, 'shadow'); assert.equal(typeof a.getBars, 'function'); assert.equal(typeof a.kick, 'function');
  assert.strictEqual(stableIbkrBars({ env: on, facade, broker: 'ibkr', userId: 'local-owner', getBars }), a, 'one instance per user');
  const b = stableIbkrBars({ env: { TRADER_BARS_IBKR_FALLBACK: '1' }, facade, broker: 'ibkr', userId: 'local-owner', getBars });
  assert.equal(b.mode, '1'); assert.notStrictEqual(b, a);
  _resetStableForTests();
});

test('the 10-30 case: armed, the overnight book opens its entry window on IBKR\'s 15:50 bar; the shadow leaves it shut', async () => {
  const now = at(DAY, 15, 55, 30);
  // daily closes rising 80 -> 100 over 250 sessions: the prior close is above its 200-session mean
  const daily = { bars: Array.from({ length: 250 }, (_, i) => ({ timestamp: new Date(Date.parse('2025-11-04T14:30:00Z') + i * 86400000).toISOString(), open: 1, high: 1, low: 1, close: 80 + i * 0.08 })) };
  daily.bars = daily.bars.filter((b) => b.timestamp.slice(0, 10) < DAY);
  const map = { 'SPY:5m': yahooOf(series(DAY, 15, 30)), 'SPY:1d': daily };   // Yahoo stopped at the 15:25 bar
  const run = async (mode) => {
    _resetStableForTests();
    const C = fakeIbkr({ SPY: series(DAY, 16, 0, { late: { c: 99, h: 99.2, l: 98.9 }, from: [15, 30] }) });
    const rows = [];
    const s = stableIbkrBars({ env: { TRADER_BARS_IBKR_FALLBACK: mode }, facade: { ibkrForUser: () => C }, broker: 'ibkr', userId: 'u1',
      getBars: fakeYahoo(map).getBars, log: (r) => rows.push(r), now: () => now });
    const O = await createOvernightScan({ symbols: ['SPY'], getBars: s.getBars }).scan(now);
    // the shadow's detached read waits out the real pacer's gap (1.1 s) between the conid search and the history request
    for (let i = 0; i < 150 && !rows.length; i++) await settle();
    return { o: O.signals[0], win: O.overnight.window, rows, C };
  };
  const armed = await run('1');
  assert.equal(armed.win, 'entry'); assert.equal(armed.o.direction, 'BULLISH'); assert.equal(armed.o.convergence.decision, 'ENTER');
  assert.equal(armed.o.entry_price, 99); assert.equal(armed.o.decision_context.overnight_bar, '15:55');
  assert.equal(armed.rows[0].event, 'bars_fallback');
  const shadow = await run('shadow');
  assert.equal(shadow.win, 'sell', 'the shadow changes nothing: no entry window'); assert.equal(shadow.o.direction, 'BEARISH');
  assert.equal(shadow.rows.length, 1); assert.equal(shadow.rows[0].event, 'bars_fallback_shadow');
  assert.ok(!JSON.stringify([...armed.rows, ...shadow.rows]).match(/oauth|token|secret|key/i), 'no credential words in the journal');
  _resetStableForTests();
});
