'use strict';
/**
 * rise-shadow.test.js — the after-the-rise shadow journals, and only journals (2026-10-30).
 *
 * The reading: the prior session's close-to-close return over the sample sd of the 20 daily returns before it
 * (at least 10); would_skip at 1.5 sds, z >= 2 recorded beside it. Daily bars are synthetic: twenty alternating
 * +1 % / -1 % sessions (sd 1.026 %) and then the prior session.
 *
 * These pin: the reading (today's partial bar ignored, a day listed twice read once, short / flat / split-like
 * history gives a reason instead of a number); one check row a session from 09:00 ET, none before it, none on a
 * weekend or a holiday, none repeated after a restart, none from a pass with no scan; one daily fetch per name per
 * session, shared by the check and the entries, and an empty answer asked again after five minutes; the entry row's
 * fields; and in the brain: off without TRADER_RISE_SHADOW, and on, the entry places exactly as before while its row
 * and the check row land under the user 'rise-shadow' with the state file beside the journal.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rs = require('../lib/rise-shadow');

const DAY = '2026-09-22';                                   // a Tuesday, EDT (ET = UTC-4)
const at = (day, hh, mm = 0) => Date.parse(`${day}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

/** Weekday daily bars before `day`: 21 alternating +/-1 % sessions, then the prior session's `lastRet`; plus today's partial bar. */
function daily(lastRet, { day = DAY, sessions = 22, partial = true } = {}) {
  const days = [];
  for (let t = Date.parse(`${day}T13:30:00Z`) - 86400000; days.length < sessions + 1; t -= 86400000) {
    const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) days.unshift(t);
  }
  const out = []; let c = 100;
  days.forEach((t, i) => {
    if (i > 0) c *= i === days.length - 1 ? 1 + lastRet : (i % 2 ? 1.01 : 0.99);
    out.push({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });
  });
  if (partial) out.push({ timestamp: new Date(Date.parse(`${day}T13:30:00Z`)).toISOString(), open: 1, high: 1, low: 1, close: 1 });
  return out;
}
const SD = 0.01 * Math.sqrt(20 / 19);                       // the sample sd of ten +1 % and ten -1 % returns
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rise-shadow-')), 'state.json');
function shadow(bySym, stateFile = tmpState()) {
  const rows = [], calls = [];
  const s = rs.createRiseShadow({ log: (r) => rows.push(r), stateFile,
    getDaily: async (sym, from, to) => { calls.push({ sym, from, to }); const b = bySym[sym]; return { bars: typeof b === 'function' ? b() : (b || []) }; } });
  return { s, rows, calls };
}

test('the reading: the prior session over the sd of the 20 before it; today is never read', () => {
  const r = rs.riseReading(daily(0.02), DAY);
  assert.strictEqual(r.prior_day, '2026-09-21');
  assert.strictEqual(r.n, 20);
  assert.ok(Math.abs(r.ret - 0.02) < 1e-12);
  assert.ok(Math.abs(r.sd - SD) < 1e-9, `sd ${r.sd}`);
  assert.ok(Math.abs(r.z - 0.02 / SD) < 1e-9, `z ${r.z}`);   // 1.949: flagged at 1.5, not at 2
  const twice = daily(0.02); twice.splice(twice.length - 1, 0, { ...twice[twice.length - 2], timestamp: '2026-09-21T20:00:00.000Z' });
  assert.ok(Math.abs(rs.riseReading(twice, DAY).z - r.z) < 1e-12, 'a day listed twice is one session');
});

test('no honest reading, a reason instead of a number', () => {
  assert.strictEqual(rs.riseReading(daily(0.02, { sessions: 10 }), DAY).why, 'short history');
  assert.strictEqual(rs.riseReading(daily(0.02, { sessions: 11 }), DAY).n, 10, 'ten returns are enough (the replay floor)');
  const split = daily(0.02); split[10].close = split[9].close * 3;
  assert.strictEqual(rs.riseReading(split, DAY).why, 'split-like move');
  const flat = daily(0).map((b) => ({ ...b, close: 50 }));
  assert.strictEqual(rs.riseReading(flat, DAY).why, 'flat history');
  assert.strictEqual(rs.riseReading([], DAY).why, 'short history');
});

test('one check row a session from 09:00 ET, with the flagged names and the missing ones', async () => {
  const { s, rows, calls } = shadow({ QQQ: daily(0.02), SPY: daily(0.005), SOXL: daily(0.03) });
  await s.check(at(DAY, 8, 59), ['QQQ', 'SPY', 'SOXL', 'XLE']);
  assert.strictEqual(rows.length, 0, 'not before 09:00');
  await s.check(at(DAY, 9, 0), ['qqq', 'SPY', 'SOXL', 'XLE', 'QQQ']);
  await s.check(at(DAY, 11, 0), ['QQQ', 'SPY', 'SOXL', 'XLE']);
  assert.strictEqual(rows.length, 1, 'once a session');
  const c = rows[0];
  assert.strictEqual(c.event, 'rise_shadow_check'); assert.strictEqual(c.day, DAY); assert.strictEqual(c.prior_day, '2026-09-21');
  assert.strictEqual(c.names, 4); assert.strictEqual(c.k, 1.5);
  assert.deepStrictEqual(c.flagged, ['QQQ', 'SOXL']);
  assert.deepStrictEqual(c.flagged_2, ['SOXL']);
  assert.deepStrictEqual(c.missing, ['XLE']); assert.strictEqual(c.readings.XLE.why, 'no daily bars');
  assert.strictEqual(c.readings.QQQ.z, 1.949); assert.strictEqual(c.readings.QQQ.ret_pct, 2);
  assert.strictEqual(c.shadow, true);
  assert.strictEqual(calls.filter((x) => x.sym === 'QQQ').length, 1, 'one fetch per name');
  assert.ok(calls[0].to - calls[0].from >= 60 * 86400000, 'a window deep enough for 22 sessions');
});

test('no check row on a weekend, a holiday, or from a pass with no scan; a restart repeats nothing', async () => {
  const state = tmpState();
  const a = shadow({ QQQ: daily(0.02) }, state);
  await a.s.check(at('2026-09-26', 10), ['QQQ']);            // a Saturday
  await a.s.check(at('2026-09-07', 10), ['QQQ']);            // Labor Day
  await a.s.check(at(DAY, 10), []);                          // a pass with no scan
  assert.strictEqual(a.rows.length, 0);
  await a.s.check(at(DAY, 10), ['QQQ']);
  assert.strictEqual(a.rows.length, 1);
  const b = shadow({ QQQ: daily(0.02) }, state);             // a fresh process, same state file
  await b.s.check(at(DAY, 14), ['QQQ']);
  assert.strictEqual(b.rows.length, 0, 'the restart repeats nothing');
  await b.s.check(at('2026-09-23', 9, 5), ['QQQ']);
  assert.strictEqual(b.rows.length, 1, 'the next session writes its own');
});

test('the entry row: the name s reading and would_skip, from the fetch the check already made', async () => {
  const { s, rows, calls } = shadow({ QQQ: daily(0.02), SPY: daily(0.005), SOXL: daily(0.03) });
  await s.check(at(DAY, 9, 1), ['QQQ', 'SPY', 'SOXL']);
  await s.tag({ symbol: 'qqq', account: 'local-owner', qty: 230, price: 500.25, now: at(DAY, 11, 2) });
  await s.tag({ symbol: 'SPY', account: 'local-owner', qty: 10, price: 700, now: at(DAY, 11, 3) });
  await s.tag({ symbol: 'SOXL', account: 'local-owner', qty: 5, price: 40, now: at(DAY, 11, 4) });
  const e = rows.filter((r) => r.event === 'rise_shadow_entry');
  assert.deepStrictEqual(e.map((r) => [r.symbol, r.would_skip, r.z_ge_2]), [['QQQ', true, false], ['SPY', false, false], ['SOXL', true, true]]);
  const q = e[0];
  assert.strictEqual(q.account, 'local-owner'); assert.strictEqual(q.qty, 230); assert.strictEqual(q.entry_px, 500.25); assert.strictEqual(q.notional, 115058);
  assert.strictEqual(q.prior_day, '2026-09-21'); assert.strictEqual(q.prior_ret_pct, 2); assert.strictEqual(q.sd20_pct, 1.026); assert.strictEqual(q.z, 1.949); assert.strictEqual(q.n, 20);
  assert.strictEqual(q.shadow, true);
  assert.strictEqual(calls.length, 3, 'the entries reuse the session s fetches');
  assert.ok(rows.every((r) => r.event !== 'entry' && r.event !== 'exit'), 'no row is a trade');
});

test('an empty daily answer: the entry says why, and the name is asked again after five minutes', async () => {
  let n = 0;
  const { s, rows, calls } = shadow({ GLD: () => (n++ === 0 ? [] : daily(0.02)) });
  await s.tag({ symbol: 'GLD', qty: 1, price: 380, now: at(DAY, 11, 0) });
  await s.tag({ symbol: 'GLD', qty: 1, price: 380, now: at(DAY, 11, 2) });
  await s.tag({ symbol: 'GLD', qty: 1, price: 380, now: at(DAY, 11, 6) });
  assert.deepStrictEqual(rows.map((r) => r.why || null), ['no daily bars', 'no daily bars', null]);
  assert.strictEqual(rows[0].z, null); assert.strictEqual(rows[0].would_skip, null);
  assert.strictEqual(rows[2].would_skip, true);
  assert.strictEqual(calls.length, 2, 'asked again only after five minutes');
});

test('the brain: off without TRADER_RISE_SHADOW; on, the entry places as before and the rows carry the user rise-shadow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rise-shadow-brain-'));
  const log = path.join(dir, 'trades.jsonl');
  Object.assign(process.env, {
    TRADER_TRADES_LOG: log, TRADER_STATE_FILE: path.join(dir, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
    TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
    TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
  });
  delete process.env.TRADER_MANAGE_EXITS; delete process.env.TRADER_ENTRY_REQUOTE;
  delete process.env.TRADER_TREND_SHADOW; delete process.env.TRADER_NOISE_SHADOW;
  // the market-data module is replaced before the brain loads it: no network in a test
  const dailyAsked = [];
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getQuotes: async (tickers) => tickers.map((t) => ({ ticker: t, price: 500, chg_pct: 0 })),
    getBars: async () => ({ bars: [] }), getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => ({ bars: [] }),
    getBarsWindow: async (sym, tf) => { if (tf === '1d') dailyAsked.push(sym); return { bars: tf === '1d' && sym === 'QQQ' ? daily(0.02) : [] }; },
    getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true } };
  const brain = require('../lib/auto-trader');
  const rows = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
  const NOW = at(DAY, 15);                                    // a Tuesday 15:00 ET
  const signal = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, decision_context: { ibs: 0.1 }, convergence: { decision: 'ENTER', p_win: 0.8 } };
  const bridge = () => {
    const placed = [];
    return { placed, getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRPositions: async () => [], getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0,
      placeIBKROrder: async (_u, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; }, cancelIBKROrder: async () => ({ ok: true }) };
  };

  delete process.env.TRADER_RISE_SHADOW;
  const off = bridge();
  await brain.runAutoTrade({ signals: [signal] }, { bridge: off, userId: 'local-owner', now: NOW });
  await new Promise((r) => setTimeout(r, 50));
  const offBuys = off.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
  assert.strictEqual(offBuys.length, 1, 'the trader buys QQQ');
  assert.ok(!rows().some((r) => String(r.event).startsWith('rise_shadow')), 'off by default: no rows');
  assert.deepStrictEqual(dailyAsked, [], 'off by default: no daily fetch');

  brain._resetCooldowns(); fs.unlinkSync(log);
  process.env.TRADER_RISE_SHADOW = '1';
  const on = bridge();
  await brain.runAutoTrade({ signals: [signal] }, { bridge: on, userId: 'local-owner', now: NOW });
  const onBuys = on.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
  assert.deepStrictEqual(onBuys, offBuys, 'the entry is the same order, shadow on or off');
  for (let i = 0; i < 40 && rows().filter((r) => String(r.event).startsWith('rise_shadow')).length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  const shadowRows = rows().filter((r) => String(r.event).startsWith('rise_shadow'));
  assert.deepStrictEqual(shadowRows.map((r) => r.event).sort(), ['rise_shadow_check', 'rise_shadow_entry']);
  assert.ok(shadowRows.every((r) => r.user === 'rise-shadow'), 'kept out of every account view');
  const e = shadowRows.find((r) => r.event === 'rise_shadow_entry');
  assert.strictEqual(e.symbol, 'QQQ'); assert.strictEqual(e.account, 'local-owner'); assert.strictEqual(e.would_skip, true); assert.strictEqual(e.z, 1.949);
  assert.strictEqual(e.qty, onBuys[0].qty);
  const real = rows().find((r) => r.event === 'entry');
  assert.ok(real && real.user === 'local-owner' && real.would_skip === undefined, 'the entry row itself is untouched');
  assert.deepStrictEqual(dailyAsked, ['QQQ'], 'one daily fetch, shared by the check and the entry');
  assert.ok(fs.existsSync(path.join(dir, 'rise-shadow-state.json')), 'state beside the journal');
  delete process.env.TRADER_RISE_SHADOW;
});
