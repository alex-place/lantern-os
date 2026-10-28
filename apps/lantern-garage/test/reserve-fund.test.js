'use strict';
/**
 * reserve-fund.test.js — the stable server's cash reserve (lib/reserve-fund.js, 2026-10-28).
 *
 * The engine's reserve (lib/two-sleeve/reserve.js) on the server's day-trader: the cash the gross cap keeps
 * (stable: gross 60, so at least 40 % cash) is parked in one T-bill fund. These tests pin the knobs (a blank knob
 * is absent, never the pct-0 unwind), the once-a-session decision for the operator's armed book only, the order
 * guard's reserve ceiling (a T-bill fund at up to 90 % of equity, every other symbol refused), the flag's path
 * through the bridge and the IBKR client, and the partition: the day-trader never sells the fund and never counts
 * it as a slot, a bucket or gross exposure.
 *
 * Run: node --test test/reserve-fund.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-fund-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const rf = require('../lib/reserve-fund');
const at = require('../lib/auto-trader');
const { orderGate } = require('../lib/trading-guard');

// 2026-10-28 is a Wednesday; EDT (UTC-4) until 11-01.
const AT = (hhmm, day = '2026-10-28') => Date.parse(`${day}T${hhmm}:00-04:00`);
const ARMED = { TRADER_AUTO_EXECUTE: '1', TRADER_RESERVE_FUND_PCT: '35' };
function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const done = () => { process.env = saved; };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}

// The stable book at the 10-27 close: four oil funds, 48 % of $966k, the rest cash.
function stableFacade({ cash = 502000, pos = {}, answer = null } = {}) {
  const st = { equity: 966000, cash, pos: { UCO: { qty: 1795, price: 36.2 }, ...pos }, placed: [] };
  return {
    st,
    getIBKRAccount: async () => ({ equity: st.equity, cash: st.cash }),
    getIBKRPositions: async () => Object.entries(st.pos).map(([symbol, p]) => ({ symbol, qty: p.qty, current_price: p.price, market_value: p.qty * p.price })),
    placeIBKROrder: async (u, o) => {
      st.placed.push(o);
      if (answer) return answer;
      const px = o.refPrice, cur = (st.pos[o.ticker] && st.pos[o.ticker].qty) || 0;
      st.pos[o.ticker] = { qty: cur + (o.side === 'buy' ? o.qty : -o.qty), price: px };
      st.cash += (o.side === 'buy' ? -1 : 1) * o.qty * px;
      return { status: 'placed', order_id: 'R' + st.placed.length };
    },
  };
}
const quote = async () => 114.5;

test('knobs: absent, blank or junk = no fund; a blank pct is never read as the pct-0 unwind', () => {
  assert.equal(rf.config({}), null);
  assert.equal(rf.config({ TRADER_RESERVE_FUND_PCT: '' }), null, 'TRADER_RESERVE_FUND_PCT= must not sell the whole holding');
  assert.equal(rf.config({ TRADER_RESERVE_FUND_PCT: '  ' }), null);
  assert.equal(rf.config({ TRADER_RESERVE_FUND_PCT: 'x' }), null);
  assert.equal(rf.config({ TRADER_RESERVE_FUND_PCT: '95' }), null, 'never park the whole book');
  const c = rf.config({ TRADER_RESERVE_FUND_PCT: '35', TRADER_RESERVE_FUND_BAND_PCT: '' });
  assert.equal(c.symbol, 'BOXX'); assert.equal(c.pct, 35); assert.equal(c.minCashPct, 5); assert.equal(c.window, '12:00-12:30');
  assert.equal(c.bandPct, 10, 'a blank band falls back to the default, not to 0');
  assert.deepEqual(rf.symbols({ TRADER_RESERVE_FUND_PCT: '35', TRADER_RESERVE_FUND_SYMBOL: 'sgov' }), ['SGOV']);
  assert.deepEqual(rf.symbols({}), []);
  assert.deepEqual(rf.symbols({ TRADER_RESERVE_FUND_PCT: '0' }), ['BOXX'], 'during the unwind the fund stays off-limits to the trader');
});

test('the first decision buys 35 % of equity in whole shares, flagged as a reserve order; once a session, restart included', async () => {
  rf._reset();
  const stateFile = path.join(DIR, 'first.state.json');
  const rows = [], f = stableFacade();
  const r = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), journal: (x) => rows.push(x), quote, stateFile, env: ARMED });
  assert.equal(r.ran, true);
  assert.equal(f.st.placed.length, 1);
  // target 35 % x 966,000 = 338,100 -> 2,952 shares at 114.50 = 338,004; the cash floor (48,300) is not in play
  assert.deepEqual(
    (({ ticker, side, qty, type, timeInForce, refPrice, equity, reserve, acceptWarnings }) => ({ ticker, side, qty, type, timeInForce, refPrice, equity, reserve, acceptWarnings }))(f.st.placed[0]),
    { ticker: 'BOXX', side: 'buy', qty: 2952, type: 'market', timeInForce: 'day', refPrice: 114.5, equity: 966000, reserve: true, acceptWarnings: true },
    'IBKR stops a buy this size at its Size Limit notice, which the trader\'s entries accept too');
  assert.deepEqual(rows.map((x) => x.event), ['reserve_plan', 'reserve_order']);
  assert.equal(rows[1].ok, true);
  const again = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:10'), quote, stateFile, env: ARMED });
  assert.equal(again.why, 'already decided today');
  rf._reset();   // a server restart inside the window
  const restarted = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:15'), quote, stateFile, env: ARMED });
  assert.equal(restarted.why, 'already decided today', 'the state file carries the decision across a restart');
  const next = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05', '2026-10-29'), quote, stateFile, env: ARMED });
  assert.equal(next.plan.action, 'hold', 'at target the next session holds');
  assert.equal(f.st.placed.length, 1);
});

test('only the operator\'s book, only armed for entries, only inside the window', async () => {
  rf._reset();
  const f = stableFacade(), stateFile = path.join(DIR, 'gates.state.json');
  assert.equal(await rf.maybeRun({ facade: f, userId: 'u-pilot-1', at: AT('12:05'), quote, stateFile, env: ARMED }), null, 'a hosted user\'s cash is theirs');
  assert.equal(await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), quote, stateFile, env: { TRADER_RESERVE_FUND_PCT: '35', TRADER_MANAGE_EXITS: '1' } }), null, 'an exits-only server never buys');
  assert.equal(await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), quote, stateFile, env: { TRADER_AUTO_EXECUTE: '1' } }), null, 'no knob, no fund');
  assert.equal((await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('11:59'), quote, stateFile, env: ARMED })).why, 'outside the window');
  assert.equal((await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:30'), quote, stateFile, env: ARMED })).why, 'outside the window');
  assert.equal(f.st.placed.length, 0);
});

test('a cash balance that reads 0 is unreadable: skip and retry inside the window, never sell the fund for it', async () => {
  rf._reset();
  const rows = [], stateFile = path.join(DIR, 'cash0.state.json');
  const f = stableFacade({ cash: 0, pos: { BOXX: { qty: 2952, price: 114.6 } } });
  const r = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:01'), journal: (x) => rows.push(x), quote, stateFile, env: ARMED });
  assert.equal(r.why, 'unreadable');
  assert.deepEqual(rows.map((x) => x.event), ['reserve_skip']);
  assert.equal(f.st.placed.length, 0, 'cash 0 would read as under the floor and sell the fund');
  f.st.cash = 164000;
  const later = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:02'), quote, stateFile, env: ARMED });
  assert.equal(later.ran, true, 'the next scan inside the window decides');
  assert.equal(later.plan.action, 'hold');
});

// Cash two ways: IBKR's cash field reads LOW after a day's buys (equity - cash - positions ran $0-351k on stable's
// trading days), and equity minus the marked positions reads HIGH when the positions feed drops rows.
const CASH_BOOK = { BOXX: { qty: 2950, price: 114.6 }, XLE: { qty: 7999, price: 70 } };   // $338,070 fund + $559,930 trader; true cash $68,000
test('cash field reading low after the day\'s buys: no sale of the fund for a floor the account is not under', async () => {
  rf._reset();
  const rows = [], f = stableFacade({ cash: 68000 - 188000, pos: CASH_BOOK });
  delete f.st.pos.UCO;
  const r = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), journal: (x) => rows.push(x), quote, stateFile: path.join(DIR, 'low.state.json'), env: ARMED });
  assert.equal(r.plan.action, 'hold', `the cash field alone would sell ~1,470 shares: ${JSON.stringify(r.plan)}`);
  assert.equal(f.st.placed.length, 0);
  const plan = rows.find((x) => x.event === 'reserve_plan');
  assert.equal(plan.broker_cash, -120000); assert.equal(plan.derived_cash, 68000);
});

test('a positions dropout: buys are sized from the lower reading, never into margin', async () => {
  rf._reset();
  const f = stableFacade({ cash: 68000, pos: {} });
  delete f.st.pos.UCO;   // the feed shows nothing, the fund and the trader's $560k included
  const r = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), quote, stateFile: path.join(DIR, 'drop.state.json'), env: ARMED });
  assert.equal(r.plan.action, 'buy');
  assert.ok(f.st.placed[0].qty * 114.5 <= 68000 - 48300, `bounded by the broker's cash above the floor, got ${f.st.placed[0].qty} shares`);
});

test('a real shortfall, both readings under the floor: sell the smaller shortfall', async () => {
  rf._reset();
  const f = stableFacade({ cash: -12000, pos: { BOXX: { qty: 2950, price: 114.6 }, XLE: { qty: 9143, price: 70 } } });
  delete f.st.pos.UCO;
  const r = await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), quote, stateFile: path.join(DIR, 'short.state.json'), env: ARMED });
  assert.equal(r.plan.action, 'sell');
  // floor 48,300; broker -12,000, derived 966,000 - 338,070 - 640,010 = -12,080: hi = -12,000 -> ceil(60,300 / 114.6) = 527
  assert.equal(f.st.placed[0].qty, 527);
});

test('an IBKR order warning is not a fill: the order row says ok false and carries the warning', async () => {
  rf._reset();
  const rows = [], stateFile = path.join(DIR, 'warn.state.json');
  const f = stableFacade({ answer: { status: 'needs_confirmation', warnings: [{ id: 'w1', message: 'Size exceeds a % of average daily volume' }] } });
  await rf.maybeRun({ facade: f, userId: 'local-owner', at: AT('12:05'), journal: (x) => rows.push(x), quote, stateFile, env: ARMED });
  const o = rows.find((x) => x.event === 'reserve_order');
  assert.equal(o.ok, false);
  assert.equal(o.status, 'needs_confirmation');
  assert.match(o.warnings[0].message, /average daily volume/);
});

test('guard: a reserve buy of a T-bill fund is capped at 90 % of equity, not at the trader\'s 12 % position cap', () => {
  withEnv({ TRADER_LIVE: '1', TRADER_MAX_POSITION_PCT: '12', TRADER_STRESS_MULT: '1.5' }, () => {
    const order = { mode: 'paper', side: 'buy', qty: 2952, refPrice: 114.5, equity: 966000 };
    assert.equal(orderGate({ ...order, symbol: 'BOXX', reserve: true }).allowed, true, '35 % of equity in BOXX');
    const plain = orderGate({ ...order, symbol: 'BOXX' });
    assert.equal(plain.allowed, false, 'unflagged, the same buy is an oversized position');
    assert.match(plain.reason, /exceeds cap/);
    const soxl = orderGate({ ...order, symbol: 'SOXL', reserve: true });
    assert.equal(soxl.allowed, false, 'the flag can never carry risk past the cap');
    assert.match(soxl.reason, /only a T-bill fund/);
    const huge = orderGate({ ...order, qty: 7700, symbol: 'BOXX', reserve: true });   // $881,650 = 91 % of equity
    assert.equal(huge.allowed, false);
    assert.match(huge.reason, /90% of equity/);
    assert.equal(orderGate({ ...order, side: 'sell', symbol: 'SOXL', reserve: true }).allowed, true, 'a sell is never capped, flagged or not');
  });
  withEnv({ TRADER_LIVE: '0' }, () => {
    assert.equal(orderGate({ mode: 'paper', side: 'buy', qty: 10, refPrice: 114.5, equity: 966000, symbol: 'BOXX', reserve: true }).allowed, false, 'a dry server stays dry');
  });
});

test('the flag rides the bridge into the IBKR client, and the client hands it to the guard', async () => {
  const TradingAPIBridge = require('../lib/trading-api-bridge');
  const seen = [];
  const b = new TradingAPIBridge();
  b.ibkrForUser = () => ({ getStatus: async () => ({ connected: true, accountId: 'DU1' }), placeOrder: async (o) => { seen.push(o); return { status: 'submitted', orderId: 'X1' }; } });
  await b.placeIBKROrder('local-owner', { ticker: 'BOXX', side: 'buy', qty: 2952, type: 'market', refPrice: 114.5, equity: 966000, reserve: true });
  await b.placeIBKROrder('local-owner', { ticker: 'SPY', side: 'buy', qty: 10, type: 'market', refPrice: 680, equity: 966000 });
  assert.equal(seen[0].reserve, true);
  assert.equal(seen[1].reserve, false, 'an ordinary order is never a reserve order');

  const IbkrCpapi = require('../lib/ibkr-cpapi');
  const client = new IbkrCpapi({});
  const posts = [];
  client.getStatus = async () => ({ connected: true, authenticated: true, mode: 'paper', accountId: 'DUR000000' });
  client.searchContract = async () => ({ conid: 1234 });
  client.resolveAccountId = async () => 'DUR000000';
  client._request = async (method, pathname, body) => { posts.push(body); return { ok: true, json: [{ order_id: '777', order_status: 'PreSubmitted' }] }; };
  await withEnv({ TRADER_LIVE: '1', TRADER_MAX_POSITION_PCT: '12' }, async () => {
    const ok = await client.placeOrder({ symbol: 'BOXX', side: 'BUY', qty: 2952, orderType: 'MKT', equity: 966000, refPrice: 114.5, reserve: true });
    assert.equal(ok.status, 'submitted', `a reserve buy reaches the broker, got ${ok.status} (${ok.note || ok.error || ''})`);
    const capped = await client.placeOrder({ symbol: 'BOXX', side: 'BUY', qty: 2952, orderType: 'MKT', equity: 966000, refPrice: 114.5 });
    assert.equal(capped.status, 'dry_run', 'without the flag the position cap refuses it');
  });
  assert.equal(posts.length, 1);
});

// ── the day-trader's partition ───────────────────────────────────────────────
const enter = (sym) => ({
  symbol: sym, direction: 'BULLISH', entry_price: 100, atr: 1,
  zones: [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }],
  convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 },
});
const pos = (sym, mv, px = 100, entry = px) => ({ symbol: sym, qty: mv / px, avg_entry_price: entry, current_price: px, market_value: mv });
function traderBridge(positions) {
  const buys = [], sells = [];
  return {
    buys, sells,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    sellPreflight: async () => ({ allowed: true, reason: 'armed on paper account' }),
    placeIBKROrder: async (uid, o) => { (/buy/i.test(o.side) ? buys : sells).push(o); return { status: 'placed', order_id: 'T' + (buys.length + sells.length) }; },
  };
}
const TRADER_ENV = {
  TRADER_AUTO_EXECUTE: '1', TRADER_MANAGE_EXITS: '1', TRADER_REQUIRE_PERSIST: '0', TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0',
  TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_LOG_SKIPS: '0',
};
const scan = (positions, signals, env, uid) => withEnv({ ...TRADER_ENV, ...env }, async () => {
  at._resetCooldowns();
  const b = traderBridge(positions);
  const out = await at.runAutoTrade({ signals }, { bridge: b, userId: uid, accountId: 'ACC-' + uid, now: 1_700_000_000_000 });
  return { out, b };
});

test('gross cap: the fund is the cash the cap keeps, not gross exposure', async () => {
  // $100k equity, cap 60 %: BOXX $35k + SPY $24.9k = $59.9k. Counted, any new entry breaches the cap; it is not counted.
  const book = [pos('BOXX', 35000, 114.5), pos('SPY', 24900)];
  const env = { TRADER_MAX_GROSS_PCT: '60', TRADER_MAX_CONCURRENT: '0' };
  const counted = await scan(book, [enter('GLD')], env, 'u-gross-a');
  assert.equal(counted.b.buys.length, 0, 'without the knob BOXX is just another position');
  assert.ok(counted.out.skipped.some((s) => s.symbol === 'GLD' && /cash reserve: gross/.test(s.why)));
  const parked = await scan(book, [enter('GLD')], { ...env, TRADER_RESERVE_FUND_PCT: '35' }, 'u-gross-b');
  assert.equal(parked.b.buys.length, 1, 'with the fund configured the trader sees $24.9k of gross, not $59.9k');
  assert.equal(parked.b.buys[0].ticker, 'GLD');
});

test('concurrency cap: the fund is not a slot', async () => {
  const book = [pos('BOXX', 35000, 114.5)];
  const env = { TRADER_MAX_CONCURRENT: '1', TRADER_MAX_GROSS_PCT: '0', TRADER_SLOT_RESERVE: '0' };
  const counted = await scan(book, [enter('GLD')], env, 'u-slot-a');
  assert.equal(counted.b.buys.length, 0);
  assert.ok(counted.out.skipped.some((s) => /concurrent cap/.test(s.why)));
  const parked = await scan(book, [enter('GLD')], { ...env, TRADER_RESERVE_FUND_PCT: '35' }, 'u-slot-b');
  assert.equal(parked.b.buys.length, 1, 'one slot, and the fund does not take it');
});

test('the trader never sells the fund: the scan pass and the fast-exit tick both leave it alone', async () => {
  // A fund 15 % under its basis is impossible in practice; it is here because it trips the -8 % backstop.
  const book = [pos('BOXX', 30000, 97.3, 114.5)];
  const unparked = await scan(book, [], {}, 'u-sell-a');
  assert.equal(unparked.b.sells.length, 1, 'unconfigured, the backstop sells it like any long');
  const parked = await scan(book, [], { TRADER_RESERVE_FUND_PCT: '35' }, 'u-sell-b');
  assert.equal(parked.b.sells.length, 0, 'configured, no scan pass touches it');
  await withEnv({ ...TRADER_ENV, TRADER_RESERVE_FUND_PCT: '35' }, async () => {
    at._resetCooldowns();
    const b = traderBridge(book);
    await at.fastExitTick({ bridge: b, userId: 'u-sell-c', accountId: 'ACC-u-sell-c', now: 1_700_000_100_000 });
    assert.equal(b.sells.length, 0, 'nor does the fast-exit loop');
  });
});
