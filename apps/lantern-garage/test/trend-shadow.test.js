'use strict';
/**
 * trend-shadow.test.js — the trend-day shadow journals, and only journals (2026-09-30).
 *
 * The rule: at the first checkpoint (bars closing 10:30 / 11:30 / 13:00; v1 adds 10:00) at which a
 * name sits in the top fifth of its session range AND the range is at least its median absolute
 * daily move over the 60 prior sessions, "buy" at the live quote; "sell" at 15:50, or at the stop
 * 8% under the entry. Days are synthetic; the rally is modelled on SOXL 2026-09-22 (opened at its
 * low, +7% by 10:30, drifted up the rest of the day).
 *
 * These pin: the scale and the read; one check row per checkpoint and one entry per rule per day
 * however often the pass runs; the stop; the 15:50 sale at the live quote; a restart mid-session
 * repeats nothing; a late process reads the checkpoints from the bars and says so; no row is ever
 * a trade ('entry'/'exit'); and the brain's kick is off without TRADER_TREND_SHADOW and tags every
 * row with the user 'trend-shadow' when on.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('../lib/trend-shadow');

const DAY = '2026-09-22';                                  // a Tuesday, EDT (ET = UTC-4)
const T0 = Date.parse(`${DAY}T13:30:00Z`);                 // 09:30 ET
const at = (hh, mm, ss = 0) => Date.parse(`${DAY}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const MAD = 0.063;                                         // SOXL's median daily move then

/** 61 prior daily closes whose |moves| are all MAD, plus today's partial bar (which must be ignored). */
function dailyBars() {
  const out = []; let c = 100;
  for (let k = 70; k >= 1; k--) {
    const d = new Date(Date.parse(`${DAY}T13:30:00Z`) - k * 86400000);
    c = c * (k % 2 ? 1 + MAD : 1 - MAD);   // |move| = MAD both ways
    out.push({ timestamp: d.toISOString(), open: c, high: c, low: c, close: c });
  }
  out.push({ timestamp: new Date(T0).toISOString(), open: 1, high: 1, low: 1, close: 1 });   // today, partial: excluded
  return out;
}
/** A session of 5m bars from a close path: closes[i] is the bar starting 09:30 + 5i. */
function sessionFrom(closes, { lowAt = {} } = {}) {
  return closes.map((c, i) => ({ t: T0 + i * 300000, open: c, high: c * 1.001, low: lowAt[i] != null ? lowAt[i] : c * 0.999, close: c }));
}
function rallyCloses() {                                   // +7.15% by the bar closing 10:30, then a slow drift up
  const out = [];
  for (let i = 0; i < 78; i++) out.push(i <= 11 ? 137.7 * (1 + 0.0065 * i) : 137.7 * 1.0715 * (1 + 0.0005 * (i - 11)));
  return out;
}
function feed(session) {
  return {
    getBars: async (sym, tf) => {
      if (tf === '1d') return { bars: dailyBars() };
      return { bars: session.filter((b) => b.t <= feed.now).map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close })) };
    },
    getQuote: async () => { const live = session.filter((b) => b.t <= feed.now); return live.length ? live[live.length - 1].close : null; },
  };
}
function shadow(session, stateFile) {
  const rows = [];
  const f = feed(session);
  const s = ts.createTrendShadow({ symbols: ['SOXL'], log: (r) => rows.push(r), stateFile, getBars: f.getBars, getQuote: f.getQuote });
  return { s, rows };
}
async function runDay(s, from, to, stepMs = 75000) {
  for (let t = from; t <= to; t += stepMs) { feed.now = t; await s.tick(t); }
}
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trend-shadow-')), 'state.json');

test('the scale: the median |daily move| of the 60 sessions before the day, today excluded', () => {
  assert.ok(Math.abs(ts.medianDailyMove(dailyBars(), DAY) - MAD) < 1e-9);
  assert.strictEqual(ts.medianDailyMove(dailyBars().slice(-30), DAY), null, 'short history');
  const split = dailyBars(); split[65].close = split[64].close * 2;
  assert.strictEqual(ts.medianDailyMove(split, DAY), null, 'an unadjusted split is dropped, not guessed');
});

test('the read: top fifth of a range at least one median daily move wide', () => {
  const bars = ts.sessionBars(sessionFrom(rallyCloses()).map((b) => ({ timestamp: new Date(b.t).toISOString(), high: b.high, low: b.low, close: b.close })), DAY);
  const r1030 = ts.checkpointRead(bars, 625, MAD);
  assert.ok(r1030.ok, r1030.why);
  assert.ok(r1030.ibs > 0.95 && r1030.range > MAD);
  const r1000 = ts.checkpointRead(bars, 595, MAD);
  assert.strictEqual(r1000.ok, false, 'at 10:00 the range is 3.5%, narrower than 6.3%');
  assert.match(r1000.why, /range/);
  assert.strictEqual(ts.checkpointRead(bars, 600, MAD).why !== 'no bar', true);
  assert.strictEqual(ts.checkpointRead(bars.filter((b) => b.min !== 625), 625, MAD).why, 'no bar');
});

test('a rally day: both rules buy at 10:30 at the live quote and sell at 15:50, once, however often the pass runs', async () => {
  const session = sessionFrom(rallyCloses());
  const { s, rows } = shadow(session, tmpState());
  await runDay(s, at(9, 29), at(16, 10), 60000);
  const checks = rows.filter((r) => r.event === 'trend_shadow_check');
  assert.deepStrictEqual(checks.map((r) => r.check), ['10:00', '10:30', '11:30', '13:00'], 'one read per checkpoint');
  assert.deepStrictEqual(checks.map((r) => r.qualifies), [false, true, true, true]);
  assert.deepStrictEqual(checks[1].fires, ['v0', 'v1']);
  assert.deepStrictEqual(checks[2].fires, [], 'a rule enters once a day');
  const entries = rows.filter((r) => r.event === 'trend_shadow_entry');
  assert.deepStrictEqual(entries.map((r) => r.rule), ['v0', 'v1']);
  for (const e of entries) { assert.strictEqual(e.late, false); assert.ok(e.quote > 0); assert.strictEqual(e.entry_px, e.quote, 'fresh read: the live quote is the entry'); }
  const exits = rows.filter((r) => r.event === 'trend_shadow_exit');
  assert.deepStrictEqual(exits.map((r) => [r.rule, r.why]), [['v0', 'close'], ['v1', 'close']]);
  assert.ok(exits[0].ret_pct > 2 && exits[0].ret_pct < 4, `the drift after 10:30: ${exits[0].ret_pct}%`);
  assert.ok(rows.every((r) => r.shadow === true && r.event !== 'entry' && r.event !== 'exit'), 'no row is a trade');
});

test('the stop: 8% under the entry, on a completed bar, and no second entry that day', async () => {
  const closes = rallyCloses();
  for (let i = 20; i < 78; i++) closes[i] = closes[11] * 0.9;          // from 11:10 the name sits 10% under the entry
  const session = sessionFrom(closes);
  const { s, rows } = shadow(session, tmpState());
  await runDay(s, at(9, 29), at(16, 10));
  const exits = rows.filter((r) => r.event === 'trend_shadow_exit');
  assert.deepStrictEqual(exits.map((r) => r.why), ['stop', 'stop']);
  for (const x of exits) assert.ok(x.ret_pct <= -8 && x.ret_pct > -10.5, `filled at the stop or the close of a bar wholly under it: ${x.ret_pct}`);
  assert.strictEqual(rows.filter((r) => r.event === 'trend_shadow_entry').length, 2, 'the rules do not re-enter after the stop');
});

test('a restart mid-session repeats nothing and still sells at 15:50', async () => {
  const session = sessionFrom(rallyCloses());
  const state = tmpState();
  const a = shadow(session, state);
  await runDay(a.s, at(9, 29), at(11, 0));
  const b = shadow(session, state);                          // a fresh process, same state file
  await runDay(b.s, at(11, 1), at(16, 10));
  const all = [...a.rows, ...b.rows];
  assert.deepStrictEqual(all.filter((r) => r.event === 'trend_shadow_check').map((r) => r.check), ['10:00', '10:30', '11:30', '13:00']);
  assert.strictEqual(all.filter((r) => r.event === 'trend_shadow_entry').length, 2);
  assert.deepStrictEqual(b.rows.filter((r) => r.event === 'trend_shadow_exit').map((r) => r.why), ['close', 'close']);
});

test('a process that starts late reads the missed checkpoints from the bars and says so', async () => {
  const session = sessionFrom(rallyCloses());
  const { s, rows } = shadow(session, tmpState());
  await runDay(s, at(10, 40), at(10, 45));
  const e = rows.filter((r) => r.event === 'trend_shadow_entry');
  assert.strictEqual(e.length, 2);
  for (const x of e) { assert.strictEqual(x.late, true); assert.strictEqual(x.quote, null); assert.strictEqual(x.entry_px, x.bar_close, 'late: the bar close, not a stale quote'); }
});

test('a fast morning: v1 buys at 10:00, v0 waits for 10:30', async () => {
  const closes = [];
  for (let i = 0; i < 78; i++) closes.push(i <= 5 ? 137.7 * (1 + 0.014 * i) : 137.7 * 1.07 * (1 + 0.0004 * (i - 5)));
  const { s, rows } = shadow(sessionFrom(closes), tmpState());
  await runDay(s, at(9, 29), at(16, 10));
  const e = rows.filter((r) => r.event === 'trend_shadow_entry').map((r) => [r.rule, r.check]);
  assert.deepStrictEqual(e, [['v1', '10:00'], ['v0', '10:30']]);
});

test('a falling day: four reads, no entry', async () => {
  const closes = [];
  for (let i = 0; i < 78; i++) closes.push(150 * (1 - 0.001 * i));
  const { s, rows } = shadow(sessionFrom(closes), tmpState());
  await runDay(s, at(9, 29), at(16, 10));
  assert.strictEqual(rows.filter((r) => r.event === 'trend_shadow_check').length, 4);
  assert.ok(rows.every((r) => r.event === 'trend_shadow_check' && r.qualifies === false));
});

test('the brain: off without TRADER_TREND_SHADOW; on, every row carries the user trend-shadow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-shadow-brain-'));
  const log = path.join(dir, 'trades.jsonl');
  process.env.TRADER_TRADES_LOG = log;
  process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
  // the market-data module is replaced before the brain loads it: no network in a test
  const session = sessionFrom(rallyCloses());
  const f = feed(session);
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getBars: f.getBars, getQuotes: async (syms) => [{ symbol: syms[0], price: await f.getQuote() }],
    getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => [] } };
  const brain = require('../lib/auto-trader');
  delete process.env.TRADER_TREND_SHADOW;
  feed.now = at(10, 31);
  await brain.runAutoTrade({ signals: [] }, { now: at(10, 31) });   // no bridge: returns early, after the kick
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('trend_shadow'), 'off by default');
  process.env.TRADER_TREND_SHADOW = 'SOXL';
  const res = await brain.runAutoTrade({ signals: [] }, { now: at(10, 31) });
  assert.deepStrictEqual(res.executed, [], 'the pass itself is untouched: it returns as it always did');
  for (let i = 0; i < 40 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('trend_shadow_entry')); i++) await new Promise((r) => setTimeout(r, 25));
  const rows = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.event).startsWith('trend_shadow'));
  assert.ok(rows.length >= 3, `rows: ${rows.map((r) => r.event).join(',')}`);
  assert.ok(rows.every((r) => r.user === 'trend-shadow'), 'kept out of every account view');
  assert.ok(fs.existsSync(path.join(dir, 'trend-shadow-state.json')), 'state beside the journal');
  delete process.env.TRADER_TREND_SHADOW;
});
