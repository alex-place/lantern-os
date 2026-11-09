'use strict';
/**
 * trade-plan.test.js — the trade plan on every entry journals, and only journals (2026-11-08).
 *
 * These pin: the plan's kind from the signal; the expected move (the median |return| of the traded fund over the same clock
 * window in the 14 prior sessions, at least 10 with both prices; the leg never counts its own entry day, close-IBS counts the
 * window that ends today before its 15:55 entry, the month-end book does not count the window that ends at its entry); each
 * kind's planned exit and in-between checkpoints, on a full day and on the 13:00 close after Thanksgiving; the in-between
 * action HOLD with the ledger row that tested it; the write contract (off unless TRADER_TRADE_PLAN=shadow, nothing from a
 * replay's clock unless TWO_SLEEVE_FAKE_NOW, a failed bars read or a failing journal never throws); and in the brain: off by
 * default, and on, the entry places exactly as before while the plan row lands under the user 'trade-plan'.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tp = require('../lib/trade-plan');
const cal = require('../lib/market-calendar');

const at = (day, hh, mm = 0) => tp.msOf(day, hh * 60 + mm);
/** The `n` trading sessions before `day`, oldest first. */
function sessionsBefore(day, n) { const out = []; let d = day; while (out.length < n) { d = cal.prevTradingDay(d); out.unshift(d); } return out; }
/** Yahoo-shaped 5m bars: the bar starting m closes at px(i, m + 5) (the price at clock m + 5); the last day stops at lastClock. */
function bars5m(days, px, lastClock = 960) {
  const out = [];
  days.forEach((d, i) => {
    for (let m = 570; m < cal.closeMin(d); m += 5) {
      if (i === days.length - 1 && m + 5 > lastClock) break;
      const c = px(i, m + 5, d);
      out.push({ timestamp: new Date(tp.msOf(d, m)).toISOString(), open: c, high: c, low: c, close: c });
    }
  });
  out.push({ timestamp: new Date(tp.msOf(days[0], 480)).toISOString(), open: 1, high: 1, low: 1, close: 1 });   // pre-market: ignored
  return out;
}
const DAY = '2026-09-22';   // a Tuesday (EDT)
// the leg's fixture: flat to 10:00, then a drift of +/-0.3 % an hour alternating by session
const legPx = (i, clock) => 100 * (1 + (i % 2 ? 0.003 : -0.003) * Math.max(0, clock - 600) / 60);
const legSignal = { symbol: 'TQQQ', direction: 'BULLISH', noise_leg: true, decision_context: { ibs: 0.8, noise: 'up', noise_proxy: 'QQQ', noise_side: 'up', noise_bar: '10:00', noise_decision: true }, convergence: { decision: 'ENTER', p_win: 0.6 } };
const LEG_ENV = { TRADER_TRADE_PLAN: 'shadow', TRADER_STOP_MIN_PCT: '8', TRADER_DECARRY_MIN: '955', TRADER_CARRY_DOWNDAY_SPY_PCT: '-1.5', TRADER_NOISE_LATE_GATE: '1', TRADER_EOD_FLAT: 'weekend' };

test('the kind comes from the signal the brain entered on', () => {
  assert.strictEqual(tp.kindOf({ noise_leg: true }), 'M');
  assert.strictEqual(tp.kindOf({ close_ibs: true }), 'C');
  assert.strictEqual(tp.kindOf({ overnight: true }), 'O');
  assert.strictEqual(tp.kindOf({ monthend: true }), 'T');
  assert.strictEqual(tp.kindOf({ symbol: 'QQQ' }), 'S');
  assert.strictEqual(tp.kindOf(null), 'S');
});

test('the expected move: the median |return| of the same window over the 14 prior sessions, at least 10', () => {
  const days = [...sessionsBefore(DAY, 15), DAY];
  const S = tp.sessionsOf(bars5m(days, legPx, 600));
  assert.strictEqual(S.days.length, 16, 'the pre-market bar is not a session of its own');
  const m = tp.expectedMove(S, { entryDay: DAY, entryClock: 600, startClock: 600, endClock: 955, delta: 0 });
  assert.strictEqual(m.move, 0.01775); assert.strictEqual(m.n, 14);
  assert.strictEqual(tp.expectedMove(S, { entryDay: DAY, entryClock: 600, startClock: 600, endClock: 630, delta: 0 }).move, 0.0015);
  // the entry day's own window is never counted (it ends after the entry): 9 prior sessions are too few
  const S9 = tp.sessionsOf(bars5m([...sessionsBefore(DAY, 9), DAY], legPx, 960));
  const m9 = tp.expectedMove(S9, { entryDay: DAY, entryClock: 600, startClock: 600, endClock: 955, delta: 0 });
  assert.strictEqual(m9.move, undefined); assert.match(m9.why, /9 of 9 prior windows/);
});

test('a window that ends today before the entry counts; one that ends at the entry does not', () => {
  const days = [...sessionsBefore(DAY, 10), DAY];
  const S = tp.sessionsOf(bars5m(days, (i) => 100 * (1 + 0.01 * i), 960));
  // close-IBS at 15:55 -> the next session's 12:00: ten windows, the last ending today at 12:00
  const c = tp.expectedMove(S, { entryDay: DAY, entryClock: 955, startClock: 955, endClock: 720, delta: 1 });
  assert.strictEqual(c.n, 10); assert.ok(c.move > 0);
  // the month-end book at 15:55 -> the next session's 15:55: the window ending today at 15:55 is the entry itself
  const t = tp.expectedMove(S, { entryDay: DAY, entryClock: 955, startClock: 955, endClock: 955, delta: 1 });
  assert.strictEqual(t.move, undefined); assert.match(t.why, /of 9 prior windows/);
});

test('the leg: thesis, expected path, its own exits, and the in-between checkpoints with HOLD', () => {
  const days = [...sessionsBefore(DAY, 15), DAY];
  const now = at(DAY, 10, 0) + 25000;
  const scan = { noise: { pairs: [{ proxy: 'QQQ', state: 'up', bar: '10:00', close: 600.5, upper: 600, lower: 590 }] } };
  const p = tp.buildPlan({ entry: { symbol: 'TQQQ', price: 50, qty: 100, stop: 46, now, order_id: 'o-1', account: 'acct' }, signal: legSignal, scan, bars: bars5m(days, legPx, 600), env: LEG_ENV });
  assert.strictEqual(p.event, 'trade_plan'); assert.strictEqual(p.mode, 'shadow'); assert.strictEqual(p.kind, 'M'); assert.strictEqual(p.v, tp.VERSION);
  assert.strictEqual(p.entry.clock, '10:00'); assert.strictEqual(p.entry.notional, 5000); assert.strictEqual(p.order_id, 'o-1');
  assert.strictEqual(p.thesis.signal, 'noise_band_break');
  assert.strictEqual(p.thesis.reading.upper, 600); assert.strictEqual(p.thesis.reading.proxy, 'QQQ');
  assert.strictEqual(p.thesis.context.tags_ref, 'o-1'); assert.strictEqual(p.thesis.context.why, 'no entry-tags reading');
  assert.strictEqual(p.expected.exit_by, new Date(at(DAY, 15, 55)).toISOString());
  assert.strictEqual(p.expected.move, 0.01775); assert.strictEqual(p.expected.target, 50.8875);
  assert.doesNotMatch(p.if_expected.rule, /carried overnight/, 'the down-day carry is for the inverse wrappers only');
  assert.match(p.if_expected.rule, /late-reversal gate/); assert.match(p.if_expected.rule, /flat before a weekend/);
  assert.strictEqual(p.if_wrong.stop, 46); assert.strictEqual(p.if_wrong.stop_pct, 8); assert.match(p.if_wrong.invalidation, /noise band/);
  assert.strictEqual(p.if_neither.action, 'HOLD'); assert.strictEqual(p.if_neither.tested, tp.TESTED);
  assert.deepStrictEqual(p.if_neither.checks.map((c) => c.id), ['M+30', 'M+60', 'M+120']);
  assert.deepStrictEqual(p.if_neither.checks.map((c) => c.expected_move), [0.0015, 0.003, 0.006]);
  assert.deepStrictEqual(p.if_neither.checks.map((c) => c.behind_plan_below), [50.0375, 50.075, 50.15]);
  assert.ok(p.if_neither.checks.every((c) => c.not_in_profit_below === 50));
  assert.strictEqual(p.if_neither.checks[0].at, new Date(at(DAY, 10, 30)).toISOString());
  // a 15:00 entry keeps only the 15:30 check; a 15:30 entry has none (the de-carry and the late gate own that time)
  const late = (bar, min) => tp.buildPlan({ entry: { symbol: 'TQQQ', price: 50, qty: 1, now: at(DAY, 15, min) + 25000 }, signal: { ...legSignal, decision_context: { ...legSignal.decision_context, noise_bar: bar } }, env: LEG_ENV });
  assert.deepStrictEqual(late('15:00', 0).if_neither.checks.map((c) => c.id), ['M+30']);
  assert.deepStrictEqual(late('15:30', 30).if_neither.checks.map((c) => c.id), []);
  assert.strictEqual(late('15:30', 30).expected.why, 'no bars');
  // the 15:50 limit holds even when the de-carry is set later: a 15:20 clock gets no 15:50 check
  const odd = tp.buildPlan({ entry: { symbol: 'TQQQ', price: 50, qty: 1, now: at(DAY, 15, 20) + 25000 }, signal: { ...legSignal, decision_context: { ...legSignal.decision_context, noise_bar: '15:20' } }, env: { ...LEG_ENV, TRADER_DECARRY_MIN: '960' } });
  assert.deepStrictEqual(odd.if_neither.checks.map((c) => c.id), []);
});

test('close-IBS before the 13:00 close after Thanksgiving: two checks, the sale at 12:50', () => {
  const p = tp.buildPlan({ entry: { symbol: 'IWM', price: 220, qty: 10, stop: 202.4, now: at('2026-11-25', 15, 55) + 25000 },
    signal: { symbol: 'IWM', close_ibs: true, decision_context: { ibs: 0.12, close_ibs_bar: '15:55' } }, env: { TRADER_STOP_MIN_PCT: '8', TRADER_MAX_HOLD_SESSIONS: '1' } });
  assert.strictEqual(p.kind, 'C'); assert.strictEqual(p.thesis.signal, 'close_ibs_washout');
  assert.strictEqual(cal.closeMin('2026-11-27'), 780, 'the day after Thanksgiving closes at 13:00');
  assert.strictEqual(p.expected.exit_by, new Date(at('2026-11-27', 12, 50)).toISOString());
  assert.deepStrictEqual(p.if_neither.checks.map((c) => c.id), ['C@10:00', 'C@12:00']);
  assert.strictEqual(p.if_neither.checks[0].at, new Date(at('2026-11-27', 10, 0)).toISOString());
  assert.strictEqual(p.if_neither.action, 'HOLD');
  assert.match(p.if_wrong.invalidation, /measured optimum/);
});

test('the overnight book has no in-between; the month-end book checks + 1 and + 2 sessions', () => {
  const o = tp.buildPlan({ entry: { symbol: 'SPY', price: 735, qty: 7, now: at('2026-11-06', 15, 55) + 25000 }, signal: { symbol: 'SPY', overnight: true, decision_context: { overnight_bar: '15:55', overnight_above: true } }, env: {} });
  assert.strictEqual(o.kind, 'O'); assert.strictEqual(o.expected.exit_by, new Date(at('2026-11-09', 9, 40)).toISOString());
  assert.deepStrictEqual(o.if_neither.checks, []); assert.strictEqual(o.if_neither.action, 'HOLD'); assert.match(o.if_neither.why, /market is closed/);
  const t = tp.buildPlan({ entry: { symbol: 'TLT', price: 88, qty: 100, now: at('2026-11-24', 15, 55) + 25000 }, signal: { symbol: 'TLT', monthend: true, decision_context: { monthend_role: 'entry', monthend_bar: '15:55' } }, env: { TRADER_MAX_HOLD_SESSIONS: '4' } });
  assert.strictEqual(t.kind, 'T'); assert.strictEqual(tp.sessionsLeft('2026-11-24'), 3);
  assert.strictEqual(t.expected.exit_by, new Date(at('2026-11-30', 15, 55)).toISOString());
  assert.deepStrictEqual(t.if_neither.checks.map((c) => [c.id, c.at]), [['T+1', new Date(at('2026-11-25', 15, 55)).toISOString()], ['T+2', new Date(at('2026-11-27', 12, 55)).toISOString()]]);
});

test('the write contract: off unless shadow, silent on a replay clock, never throws', async () => {
  assert.strictEqual(tp.enabled({ TRADER_TRADE_PLAN: 'shadow' }), true);
  assert.strictEqual(tp.enabled({ TRADER_TRADE_PLAN: ' SHADOW ' }), true);
  assert.strictEqual(tp.enabled({ TRADER_TRADE_PLAN: '1' }), false, 'only shadow turns it on: no acting mode exists');
  assert.strictEqual(tp.enabled({}), false);
  const rows = []; const asked = [];
  const getBars = async (s, tf) => { asked.push([s, tf]); return { bars: [] }; };
  const entry = { symbol: 'TQQQ', price: 50, qty: 1, now: at(DAY, 10, 0) + 25000, order_id: 9 };
  assert.strictEqual(await tp.write(entry, { log: (r) => rows.push(r), getBars, env: {}, signal: legSignal }), null);
  assert.deepStrictEqual([rows.length, asked.length], [0, 0], 'a pass off the real clock (a replay) writes nothing and reads nothing');
  const env = { ...LEG_ENV, TWO_SLEEVE_FAKE_NOW: new Date(entry.now).toISOString() };
  await tp.write(entry, { log: (r) => rows.push(r), getBars, env, signal: legSignal });
  assert.deepStrictEqual(asked, [['TQQQ', '5m'], ['QQQ', '5m']], 'the fund, then the leg\'s proxy for its band');
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].event, 'trade_plan'); assert.strictEqual(rows[0].order_id, '9');
  assert.strictEqual(rows[0].expected.why, 'no bars from the feed');
  await tp.write(entry, { log: (r) => rows.push(r), getBars: async () => { throw new Error('boom'); }, env, signal: legSignal });
  assert.match(rows[1].expected.why, /bars read failed: boom/);
  await tp.write(entry, { log: () => { throw new Error('disk full'); }, getBars, env, signal: legSignal });   // must not throw
  await tp.write(entry, { log: (r) => rows.push(r), getBars, env, signal: legSignal, readContext: () => { throw new Error('bad file'); } });
  assert.strictEqual(rows[2].thesis.context.why, 'no entry-tags reading');
  const live = { ...entry, now: Date.now() };
  await tp.write(live, { log: (r) => rows.push(r), getBars, env: LEG_ENV, signal: legSignal });
  assert.strictEqual(rows.length, 4, 'a pass on the real clock writes without the rehearsal flag');
});

test('the brain: off by default; on, the entry places as before and the plan lands under the user trade-plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-plan-brain-'));
  const log = path.join(dir, 'trades.jsonl');
  Object.assign(process.env, {
    TRADER_TRADES_LOG: log, TRADER_STATE_FILE: path.join(dir, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
    TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
    TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
    TRADER_ENTRY_TAGS_DIR: path.join(dir, 'no-tags'),
  });
  delete process.env.TRADER_MANAGE_EXITS; delete process.env.TRADER_ENTRY_REQUOTE; delete process.env.TRADER_ENTRY_TAGS;
  delete process.env.TRADER_TREND_SHADOW; delete process.env.TRADER_NOISE_SHADOW; delete process.env.TRADER_RISE_SHADOW;
  const barsAsked = [];
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getQuotes: async (tickers) => tickers.map((t) => ({ ticker: t, price: 500, chg_pct: 0 })),
    getBars: async (sym, tf) => { barsAsked.push([sym, tf]); return { bars: [] }; }, getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => ({ bars: [] }),
    getBarsWindow: async () => ({ bars: [] }), getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true } };
  const brain = require('../lib/auto-trader');
  const rows = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
  const NOW = at(DAY, 15);
  const signal = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, close_ibs: true, decision_context: { ibs: 0.1, close_ibs_bar: '15:00' }, convergence: { decision: 'ENTER', p_win: 0.8 } };
  const bridge = () => {
    const placed = [];
    return { placed, getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRPositions: async () => [], getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0,
      placeIBKROrder: async (_u, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; }, cancelIBKROrder: async () => ({ ok: true }) };
  };
  const settle = async (n) => { for (let i = 0; i < 40 && rows().filter((r) => r.event === 'trade_plan').length < n; i++) await new Promise((r) => setTimeout(r, 25)); };

  delete process.env.TRADER_TRADE_PLAN; process.env.TWO_SLEEVE_FAKE_NOW = new Date(NOW).toISOString();
  const off = bridge();
  await brain.runAutoTrade({ signals: [signal] }, { bridge: off, userId: 'local-owner', now: NOW });
  await new Promise((r) => setTimeout(r, 50));
  const offBuys = off.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
  assert.strictEqual(offBuys.length, 1, 'the trader buys QQQ');
  assert.ok(!rows().some((r) => r.event === 'trade_plan'), 'off by default: no plan');
  assert.deepStrictEqual(barsAsked, [], 'off by default: no bars read');

  brain._resetCooldowns(); fs.unlinkSync(log);
  process.env.TRADER_TRADE_PLAN = 'shadow';
  const on = bridge();
  await brain.runAutoTrade({ signals: [signal] }, { bridge: on, userId: 'local-owner', now: NOW });
  const onBuys = on.placed.filter((o) => o.side === 'buy' && o.ticker === 'QQQ');
  assert.deepStrictEqual(onBuys, offBuys, 'the entry is the same order, plan on or off');
  await settle(1);
  const plans = rows().filter((r) => r.event === 'trade_plan');
  assert.strictEqual(plans.length, 1);
  const p = plans[0];
  assert.strictEqual(p.user, 'trade-plan', 'kept out of every account view');
  assert.strictEqual(p.kind, 'C'); assert.strictEqual(p.symbol, 'QQQ'); assert.strictEqual(p.account, 'local-owner'); assert.strictEqual(p.entry.qty, onBuys[0].qty);
  assert.strictEqual(p.entry.clock, '15:00'); assert.strictEqual(p.order_id, '1');
  assert.deepStrictEqual(p.if_neither.checks.map((c) => c.id), ['C@10:00', 'C@12:00', 'C@14:00']);
  assert.strictEqual(p.if_neither.checks[0].at, new Date(at('2026-09-23', 10, 0)).toISOString());
  assert.deepStrictEqual(barsAsked, [['QQQ', '5m']]);
  assert.strictEqual(p.v, 2);
  assert.ok(p.exits.some((x) => x.rule === 'loss_cap') && p.exits.some((x) => x.rule === 'max_hold'), 'every exit rule, with its level');
  assert.strictEqual(p.scenarios.n, 0, 'the sleeve journal was read (no closed trades in it yet)');
  assert.strictEqual(p.today.entries_before, 0, 'the entry itself is not an earlier try');
  const real = rows().find((r) => r.event === 'entry');
  assert.ok(real && real.user === 'local-owner' && real.kind === undefined, 'the entry row itself is untouched');

  // a replay's clock: the knob on, no rehearsal flag -> nothing
  brain._resetCooldowns(); fs.unlinkSync(log); delete process.env.TWO_SLEEVE_FAKE_NOW;
  await brain.runAutoTrade({ signals: [signal] }, { bridge: bridge(), userId: 'local-owner', now: NOW });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!rows().some((r) => r.event === 'trade_plan'), 'a replay writes no plan');
  delete process.env.TRADER_TRADE_PLAN;
});

// ---- version 2: every exit rule with its level, what usually happens, today's tries ------------------------------------------
const { noiseBand } = require('../lib/trend-shadow');
const inverseSignal = { symbol: 'SQQQ', direction: 'BULLISH', noise_leg: true, decision_context: { ibs: 0.8, noise: 'dn', noise_proxy: 'QQQ', noise_side: 'dn', noise_bar: '10:00', noise_decision: true }, convergence: { decision: 'ENTER', p_win: 0.6 } };

test('v2: every exit rule of the leg, with the proxy band at each half hour and the cap that also sells in the extended hours', () => {
  const days = [...sessionsBefore(DAY, 15), DAY];
  const proxyBars = bars5m(days, legPx, 600);
  const now = at(DAY, 10, 0) + 25000;
  const p = tp.buildPlan({ entry: { symbol: 'SQQQ', price: 20, qty: 300, stop: 18.4, now, order_id: 'o-2' }, signal: inverseSignal, bars: bars5m(days, legPx, 600), proxyBars, history: [], env: LEG_ENV });
  assert.strictEqual(p.v, 2);
  assert.deepStrictEqual(p.exits.map((x) => x.rule), ['band_exit', 'stop', 'loss_cap', 'late_gate', 'decarry', 'carry_downday']);
  const band = p.exits[0];
  assert.match(band.when, /QQQ at or over its lower band/);
  assert.deepStrictEqual(band.levels.map((x) => x.clock), ['10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
  const nb = noiseBand(proxyBars, DAY), p0 = tp.priceAt(tp.sessionsOf(proxyBars), DAY, 600);
  assert.strictEqual(band.levels[0].proxy, Math.round(nb.at(625).lower * 1e4) / 1e4, 'the scan band at the 10:30 bar');
  assert.strictEqual(band.levels[0].wrapper_approx, Math.round(20 * (1 - 3 * (nb.at(625).lower / p0 - 1)) * 1e4) / 1e4);
  const cap = p.exits.find((x) => x.rule === 'loss_cap');
  assert.strictEqual(cap.price, 18.4); assert.strictEqual(cap.pct, 8); assert.match(cap.acts, /extended hours/); assert.strictEqual(cap.in_replay, false);
  assert.strictEqual(p.exits.find((x) => x.rule === 'late_gate').at, new Date(at(DAY, 15, 30)).toISOString());
  assert.match(p.if_expected.rule, /carried overnight instead when SPY's session is at or below -1.5 %/);
  assert.match(p.if_wrong.invalidation, /10:30 \d/); assert.match(p.if_wrong.loss_cap, /also sells in the extended hours/);
  assert.strictEqual(p.if_neither.checks[0].band_exit_proxy, band.levels[0].proxy, 'the check at 10:30 names the band line it would face');
  const rth = tp.buildPlan({ entry: { symbol: 'SQQQ', price: 20, qty: 1, now }, signal: inverseSignal, env: { ...LEG_ENV, TRADER_MAX_LOSS_RTH_ONLY: '1' } });
  const cap2 = rth.exits.find((x) => x.rule === 'loss_cap');
  assert.strictEqual(cap2.acts, 'regular hours only'); assert.strictEqual(cap2.in_replay, true);
  assert.strictEqual(rth.exits[0].levels, null); assert.strictEqual(rth.exits[0].levels_why, 'no proxy bars');
});

test('v2: the Friday weekend flat: no weekend carry for the leg; first when it starts earlier; close-IBS bought Thursday meets it', () => {
  const env = { ...LEG_ENV, TRADER_EOD_FLAT: 'weekend' };
  // the leg's flat starts at its de-carry minute (TRADER_EOD_FLAT_MIN defaults to TRADER_DECARRY_MIN, 955 here): same time, and no carry
  const fri = tp.buildPlan({ entry: { symbol: 'SQQQ', price: 20, qty: 1, now: at('2026-11-06', 10, 0) + 25000 }, signal: inverseSignal, env });
  assert.strictEqual(fri.expected.exit_by, new Date(at('2026-11-06', 15, 55)).toISOString());
  assert.deepStrictEqual(fri.exits.filter((x) => x.type === 'time').map((x) => [x.rule, x.at]), [['late_gate', new Date(at('2026-11-06', 15, 30)).toISOString()], ['decarry', new Date(at('2026-11-06', 15, 55)).toISOString()], ['weekend_flat', new Date(at('2026-11-06', 15, 55)).toISOString()]]);
  const carry = fri.exits.find((x) => x.rule === 'carry_downday');
  assert.strictEqual(carry.applies, false); assert.match(carry.why, /no weekend carry/);
  assert.strictEqual(tp.buildPlan({ entry: { symbol: 'SQQQ', price: 20, qty: 1, now: at(DAY, 10, 0) + 25000 }, signal: inverseSignal, env }).exits.find((x) => x.rule === 'carry_downday').applies, true, 'a Tuesday can carry');
  // a flat that starts before the de-carry becomes the exit
  const early = tp.buildPlan({ entry: { symbol: 'TQQQ', price: 50, qty: 1, now: at('2026-11-06', 10, 0) + 25000 }, signal: legSignal, env: { ...env, TRADER_EOD_FLAT_MIN: '945' } });
  assert.strictEqual(early.expected.exit_by, new Date(at('2026-11-06', 15, 45)).toISOString());
  assert.match(early.expected.exit_rule, /Friday weekend flat at 15:45/);
  assert.deepStrictEqual(early.if_neither.checks.map((c) => c.id), ['M+30', 'M+60', 'M+120']);
  const tue = tp.buildPlan({ entry: { symbol: 'TQQQ', price: 50, qty: 1, now: at(DAY, 10, 0) + 25000 }, signal: legSignal, env });
  assert.ok(!tue.exits.some((x) => x.rule === 'weekend_flat'), 'no flat on a Tuesday');
  const thu = tp.buildPlan({ entry: { symbol: 'IWM', price: 220, qty: 10, now: at('2026-11-05', 15, 55) + 25000 }, signal: { symbol: 'IWM', close_ibs: true, decision_context: { close_ibs_bar: '15:55' } }, env: { TRADER_MAX_HOLD_SESSIONS: '1', TRADER_EOD_FLAT: 'weekend' } });
  assert.strictEqual(thu.expected.exit_by, new Date(at('2026-11-06', 15, 50)).toISOString());
  assert.match(thu.expected.exit_rule, /max-hold/);
  assert.deepStrictEqual(thu.exits.filter((x) => x.type === 'time').map((x) => [x.rule, x.at]), [['max_hold', new Date(at('2026-11-06', 15, 50)).toISOString()], ['weekend_flat', new Date(at('2026-11-06', 15, 50)).toISOString()]]);
});

test('v2: what usually happens (the sleeve own closed trades by branch) and earlier tries on the same fund today', () => {
  const d1 = '2026-09-17', d2 = '2026-09-18', d3 = '2026-09-21';
  const row = (event, sym, day, hh, mm, ex = {}) => ({ ts: new Date(at(day, hh, mm) + 20000).toISOString(), user: 'local-owner', event, symbol: sym, ...ex });
  const rows = [
    row('entry', 'TQQQ', d1, 10, 0), row('exit', 'TQQQ', d1, 10, 20, { reason: 'signal_exit', pnl: -40, pnl_pct: -0.8 }),
    row('entry', 'UPRO', d1, 11, 0), row('exit', 'UPRO', d1, 15, 30, { reason: 'signal_exit', pnl: 90, pnl_pct: 1.2 }),
    row('entry', 'SOXL', d1, 15, 0), row('exit', 'SOXL', d1, 15, 55, { reason: 'eod_decarry (leveraged)', pnl: 120, pnl_pct: 2.0 }),
    row('entry', 'SOXS', d1, 15, 0), row('exit', 'SOXS', d2, 9, 35, { reason: 'signal_exit', pnl: 300, pnl_pct: 4.0 }),
    row('entry', 'SQQQ', d2, 15, 0), row('exit', 'SQQQ', d3, 4, 12, { reason: 'max_loss (-8.2% <= -8%)', pnl: -500, pnl_pct: -8.2 }),
    row('entry', 'UPRO', d3, 10, 30), row('exit', 'UPRO', d3, 11, 5, { reason: 'broker fill', pnl: -310, pnl_pct: -8.0 }),
    row('entry', 'SQQQ', DAY, 10, 0), row('exit', 'SQQQ', DAY, 10, 25, { reason: 'signal_exit', pnl: -50, pnl_pct: -0.9 }),
    { ts: new Date(at(DAY, 10, 0) + 21000).toISOString(), user: 'local-owner', event: 'entry_fill', symbol: 'SQQQ' },
    { ts: new Date(at(DAY, 10, 0) + 22000).toISOString(), user: 'trade-plan', event: 'trade_plan', symbol: 'SQQQ' },
  ];
  const h = tp.historyStats('M', rows, { now: at(DAY, 11, 0) + 25000, symbol: 'SQQQ' });
  const by = Object.fromEntries(h.scenarios.branches.map((b) => [b.branch, b]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['band_exit', 'carried', 'carried_then_cap', 'decarry', 'late_gate', 'stop']);
  assert.strictEqual(by.band_exit.n, 2); assert.strictEqual(by.band_exit.mean_pct, -0.85); assert.strictEqual(by.band_exit.win_rate, 0);
  assert.strictEqual(by.band_exit.median_min, 23);   // 20 and 25 minutes
  assert.strictEqual(h.scenarios.n, 7); assert.strictEqual(by.carried.median_min, 1115);
  assert.deepStrictEqual(h.today, { entries_before: 1, same_fund_before: 1, reentry: true, same_fund_closed_pnl: -50, last_same_exit: { at: rows[13].ts, reason: 'signal_exit', pnl: -50 } });
  // the journal text: only entry and exit rows are parsed, a torn line is skipped
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"ts":"2026-09-22T14:00:00Z","event":"exit","sym';
  assert.strictEqual(tp.parseHistory(text).length, 14);
  // the overnight book's sales and close-IBS's own exits
  assert.strictEqual(tp.branchOf('O', rows[0], { ...rows[1], reason: 'signal_exit' }), 'sale_0940');
  assert.strictEqual(tp.branchOf('C', rows[0], { ...rows[1], reason: 'max_hold (1 sessions >= 1)' }), 'max_hold');
  assert.strictEqual(tp.branchOf('C', rows[0], { ...rows[1], reason: 'eod_flat_weekend (no weekend holds, 2026-08-24)' }), 'weekend_flat');
});

test('v2: the writer reads the leg proxy (live and settled) and the sleeve journal; close-IBS reads no proxy', async () => {
  const days = [...sessionsBefore(DAY, 15), DAY];
  const asked = [], hist = []; let journalReads = 0;
  const getBars = async (s, tf) => { asked.push([s, tf]); return { bars: bars5m(s === 'QQQ' ? days.slice(-9) : days, legPx, 600) }; };
  const getHistory = async (s, from, to) => { hist.push([s, (to - from) / 86400000]); return { bars: bars5m(days.slice(0, 7), legPx, 960) }; };
  const readJournal = async () => { journalReads++; return ''; };
  const env = { ...LEG_ENV, TWO_SLEEVE_FAKE_NOW: 'x' }; const rows = [];
  await tp.write({ symbol: 'SQQQ', price: 20, qty: 1, now: at(DAY, 10, 0) + 25000 }, { log: (r) => rows.push(r), getBars, getHistory, readJournal, env, signal: inverseSignal });
  assert.deepStrictEqual(asked, [['SQQQ', '5m'], ['QQQ', '5m']]);
  assert.deepStrictEqual(hist, [['QQQ', 21]], 'the settled window 28 -> 7 days back, as the noise scan merges it');
  assert.strictEqual(journalReads, 1);
  assert.strictEqual(rows[0].exits[0].levels.length, 11, 'live + settled sessions are enough for the band');
  assert.strictEqual(rows[0].scenarios.why, 'no closed trades in the journal yet');
  asked.length = 0; hist.length = 0;
  await tp.write({ symbol: 'IWM', price: 220, qty: 1, now: at(DAY, 15, 55) + 25000 }, { log: (r) => rows.push(r), getBars, getHistory, readJournal, env, signal: { symbol: 'IWM', close_ibs: true, decision_context: { close_ibs_bar: '15:55' } } });
  assert.deepStrictEqual(asked, [['IWM', '5m']]); assert.deepStrictEqual(hist, []); assert.strictEqual(journalReads, 2);
  await tp.write({ symbol: 'IWM', price: 220, qty: 1, now: at(DAY, 15, 55) + 25000 }, { log: (r) => rows.push(r), getBars, readJournal: async () => { throw new Error('locked'); }, env, signal: { symbol: 'IWM', close_ibs: true } });
  assert.match(rows[2].scenarios.why, /journal read failed: locked/);
});
