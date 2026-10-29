'use strict';
/**
 * overnight-book.test.js — the stable server's overnight book (lib/overnight-book.js, 2026-10-28).
 *
 * The engine's sleeve O on the server's day-trader: SPY/QQQ/SMH bought at the 15:55 print when above their 200-session
 * mean, sold at the 09:40 print. These tests pin the knobs, the two windows (and no market-data read outside them), the
 * one-owner rule (no buy of a name the account holds), the room under the gross cap, the once-a-session buy and sale,
 * the release of a sold name only after two reads show it gone, and the day-trader's side of the partition: it never
 * sells the book's names, never counts them as a slot, does count them as gross exposure, does not read the morning
 * sale as a dropout, does not book the book's sale as its own exit, and keeps the book out of its session record.
 * Each partition test has a control.
 *
 * Run: node --test test/overnight-book.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-book-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const ob = require('../lib/overnight-book');
const at = require('../lib/auto-trader');

const USER = 'local-owner';
// 2026-10-28 is a Wednesday, 10-29 a Thursday; EDT (UTC-4) until 11-01.
const D1 = '2026-10-28', D2 = '2026-10-29';
const AT = (day, hhmm, ss = 0) => Date.parse(`${day}T${hhmm}:${String(ss).padStart(2, '0')}-04:00`);
const ARMED = { TRADER_AUTO_EXECUTE: '1', TRADER_OVERNIGHT_BOOK_PCT: '5.5', TRADER_MAX_GROSS_PCT: '60' };
let _n = 0;
const stateFile = () => path.join(DIR, `book-${++_n}.json`);
function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const done = () => { process.env = saved; };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}

// The market: 5m session bars for both days and 260 daily closes before D1. SPY and QQQ rose into their last close
// (above the 200-session mean), SMH fell into it (below).
const session = (day, lvl) => Array.from({ length: 78 }, (_, i) => ({ timestamp: new Date(Date.parse(`${day}T13:30:00Z`) + i * 300000).toISOString(), open: lvl, high: lvl + 0.05, low: lvl - 0.05, close: lvl }));
function daily(day, slope, last) {
  const out = []; let t = Date.parse(`${day}T12:00:00Z`); let k = 0;
  while (out.length < 260) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; k++; out.unshift({ timestamp: d.toISOString(), close: last - slope * k }); }
  return out;
}
const LVL = { SPY: 690, QQQ: 610, SMH: 300 };
function market() {
  const calls = [];
  const S5 = {}, S1 = {};
  for (const s of Object.keys(LVL)) { S5[s] = [...session(D1, LVL[s]), ...session(D2, LVL[s] * 1.004)]; S1[s] = daily(D1, s === 'SMH' ? -0.2 : 0.2, LVL[s]); }
  // Bars only up to `now` (the scan reads completed bars); the daily list is the sessions before D1.
  const getBars = async (sym, tf) => { calls.push(`${sym}:${tf}`); return { bars: tf === '1d' ? S1[sym] : S5[sym] }; };
  return { getBars, calls };
}

// A stable-like account: equity $966k; the day-trader holds UCO; tests override the book.
function account({ pos = {}, answer = null } = {}) {
  const st = { equity: 966000, pos: { UCO: { qty: 1795, price: 36.2 }, ...pos }, placed: [] };
  return {
    st,
    getIBKRAccount: async () => ({ equity: st.equity, cash: 300000 }),
    getIBKRPositions: async () => Object.entries(st.pos).filter(([, p]) => p.qty !== 0)
      .map(([symbol, p]) => ({ symbol, qty: p.qty, current_price: p.price, market_value: p.qty * p.price })),
    placeIBKROrder: async (u, o) => {
      st.placed.push(o);
      const a = typeof answer === 'function' ? answer(o) : answer;
      if (a) return a;
      const cur = (st.pos[o.ticker] && st.pos[o.ticker].qty) || 0;
      st.pos[o.ticker] = { qty: cur + (o.side === 'buy' ? o.qty : -o.qty), price: o.refPrice || LVL[o.ticker] || 100 };
      return { status: 'submitted', orderId: 'O' + st.placed.length };
    },
  };
}
const run = (acct, when, extra = {}) => withEnv({ ...ARMED, ...(extra.env || {}) }, () => {
  const rows = extra.rows || [];
  return ob.maybeRun({ facade: acct, userId: extra.user || USER, at: when, getBars: extra.getBars || market().getBars,
    journal: (r) => rows.push(r), stateFile: extra.stateFile, env: process.env });
});

test('knobs: absent, blank, junk or out of range = off; 0 = no new buys (the unwind); symbols default SPY/QQQ/SMH', () => {
  assert.equal(ob.config({}), null);
  assert.equal(ob.config({ TRADER_OVERNIGHT_BOOK_PCT: '' }), null);
  assert.equal(ob.config({ TRADER_OVERNIGHT_BOOK_PCT: 'x' }), null);
  assert.equal(ob.config({ TRADER_OVERNIGHT_BOOK_PCT: '40' }), null, 'more than a third of equity per name is refused');
  assert.deepEqual(ob.config({ TRADER_OVERNIGHT_BOOK_PCT: '5.5' }), { pct: 5.5, symbols: ['SPY', 'QQQ', 'SMH'] });
  assert.deepEqual(ob.config({ TRADER_OVERNIGHT_BOOK_PCT: '0', TRADER_OVERNIGHT_BOOK_SYMBOLS: 'spy, qqq' }), { pct: 0, symbols: ['SPY', 'QQQ'] });
  assert.equal(ob.grossCapPct({}), 80, 'the day-trader\'s default cap');
  assert.equal(ob.grossCapPct({ TRADER_MAX_GROSS_PCT: '100' }), null);
});

test('15:55: the names above their trend are bought at 5.5 % of equity in whole shares, the one below is not; once a session, restart included', async () => {
  ob._reset();
  const acct = account(); const sf = stateFile(); const rows = [];
  const early = await run(acct, AT(D1, '15:55', 5), { stateFile: sf, rows });
  assert.equal(acct.st.placed.length, 0, 'the 15:50 bar is read 20 s after it closes');
  assert.deepEqual(early.bought, [], 'until then the scan still reads the sell window, and the book holds nothing to sell');
  await run(acct, AT(D1, '15:56'), { stateFile: sf, rows });
  assert.deepEqual(acct.st.placed.map((o) => [o.ticker, o.side, o.qty]), [['SPY', 'buy', 77], ['QQQ', 'buy', 87]], '5.5 % of $966k = $53,130 per name');
  for (const o of acct.st.placed) { assert.equal(o.type, 'market'); assert.equal(o.acceptWarnings, true); assert.equal(o.reserve, undefined); }
  const skip = rows.find((r) => r.event === 'overnight_book_skip' && r.symbol === 'SMH');
  assert.equal(skip.why, 'below the trend'); assert.equal(skip.gate.above, false);
  assert.deepEqual(ob.partition(USER, { env: ARMED }).symbols.sort(), ['QQQ', 'SPY']);
  await run(acct, AT(D1, '15:58'), { stateFile: sf, rows });
  ob._reset();   // a restart inside the window reads the state file
  await run(acct, AT(D1, '15:59'), { stateFile: sf, rows });
  assert.equal(acct.st.placed.length, 2, 'no second buy in the session');
  const late = await run(account(), AT(D1, '16:00', 30), { stateFile: stateFile(), rows: [] });
  assert.equal(late.ran, false, 'nothing at or after the bell');
});

test('one owner per name: a name the account already holds at 15:55 is the day-trader\'s and is not bought', async () => {
  ob._reset();
  const acct = account({ pos: { SPY: { qty: 150, price: 690 } } }); const rows = [];
  await run(acct, AT(D1, '15:56'), { stateFile: stateFile(), rows });
  assert.deepEqual(acct.st.placed.map((o) => o.ticker), ['QQQ']);
  assert.equal(rows.find((r) => r.symbol === 'SPY').why, 'held by the day-trader');
});

test('the gross cap: the book buys only into the room the cap leaves; the reserve fund is not exposure', async () => {
  ob._reset();
  // UCO $65k + XLE $435k = $500k of the trader's exposure (51.8 %) + BOXX $338k: under a 60 % cap, $79.6k of room.
  const pos = { XLE: { qty: 6280, price: 69.27 }, BOXX: { qty: 2846, price: 118.77 } };
  const acct = account({ pos }); const rows = [];
  await run(acct, AT(D1, '15:56'), { stateFile: stateFile(), rows, env: { TRADER_RESERVE_FUND_PCT: '35' } });
  assert.deepEqual(acct.st.placed.map((o) => [o.ticker, o.qty]), [['SPY', 77], ['QQQ', 43]], 'SPY in full, QQQ in the room left');
  const open = account({ pos });
  await run(open, AT(D1, '15:56'), { stateFile: stateFile(), rows: [], env: { TRADER_RESERVE_FUND_PCT: '35', TRADER_MAX_GROSS_PCT: '100' } });
  assert.deepEqual(open.st.placed.map((o) => [o.ticker, o.qty]), [['SPY', 77], ['QQQ', 87]], 'control: no cap, full size');
  const full = account({ pos: { XLE: { qty: 8360, price: 69.27 } } }); const fr = [];
  await run(full, AT(D1, '15:56'), { stateFile: stateFile(), rows: fr });
  assert.equal(full.st.placed.length, 0);
  assert.match(fr.find((r) => r.symbol === 'SPY').why, /no room under the gross cap/);
});

test('09:40 the next session: the held names are sold once; a refused sale is retried; a name is released after two reads show it gone', async () => {
  ob._reset();
  const acct = account(); const sf = stateFile(); const rows = [];
  await run(acct, AT(D1, '15:56'), { stateFile: sf, rows });
  await run(acct, AT(D2, '09:39'), { stateFile: sf, rows });
  assert.equal(acct.st.placed.filter((o) => o.side === 'sell').length, 0, 'held through the open');
  let refuse = true;
  const flaky = { ...acct, placeIBKROrder: (u, o) => (o.side === 'sell' && refuse ? (refuse = false, Promise.resolve({ status: 'error', reason: 'rejected' })) : acct.placeIBKROrder(u, o)) };
  await run(flaky, AT(D2, '09:40', 25), { stateFile: sf, rows });
  const sells = () => acct.st.placed.filter((o) => o.side === 'sell').map((o) => [o.ticker, o.qty]);
  assert.deepEqual(sells(), [['QQQ', 87]], 'SPY refused, QQQ sold');
  await run(flaky, AT(D2, '09:42'), { stateFile: sf, rows });
  assert.deepEqual(sells(), [['QQQ', 87], ['SPY', 77]], 'the refused sale is sent again; the sold one is not');
  assert.deepEqual(ob.partition(USER, { env: ARMED }).symbols.sort(), ['QQQ', 'SPY'], 'still the book\'s: one read shows them gone');
  await run(acct, AT(D2, '09:43'), { stateFile: sf, rows });
  assert.deepEqual(ob.partition(USER, { env: ARMED }).symbols, ['SPY'], 'QQQ released after its second read; SPY, sold at 09:42, has had one');
  await run(acct, AT(D2, '09:44'), { stateFile: sf, rows });
  assert.deepEqual(ob.partition(USER, { env: ARMED }).symbols, [], 'and SPY after its second');
  assert.equal(rows.filter((r) => r.event === 'overnight_book_gone' && r.sold).length, 2);
  assert.ok(ob.partition(USER, { env: ARMED }).sells.length >= 2, 'the sale order ids stay on record for the fill filter');
  const quiet = market();
  const r = await run(acct, AT(D2, '11:00'), { stateFile: sf, rows, getBars: quiet.getBars });
  assert.equal(r.ran, false); assert.equal(quiet.calls.length, 0, 'nothing held, outside the entry window: no market-data read');
});

test('only the operator\'s armed book; pct 0 buys nothing but still sells what the book holds', async () => {
  ob._reset();
  assert.equal(await run(account(), AT(D1, '15:56'), { user: 'u-other', stateFile: stateFile() }), null);
  assert.equal(await run(account(), AT(D1, '15:56'), { stateFile: stateFile(), env: { TRADER_AUTO_EXECUTE: '0' } }), null);
  assert.equal(await run(account(), AT(D1, '15:56'), { stateFile: stateFile(), env: { TRADER_OVERNIGHT_BOOK_PCT: '' } }), null);
  const acct = account(); const sf = stateFile();
  await run(acct, AT(D1, '15:56'), { stateFile: sf });
  await run(acct, AT(D1, '15:57'), { stateFile: sf, env: { TRADER_OVERNIGHT_BOOK_PCT: '0' } });
  await run(acct, AT(D2, '09:41'), { stateFile: sf, env: { TRADER_OVERNIGHT_BOOK_PCT: '0' } });
  assert.equal(acct.st.placed.filter((o) => o.side === 'buy').length, 2, 'the unwind buys nothing');
  assert.equal(acct.st.placed.filter((o) => o.side === 'sell').length, 2, 'and sells what is held');
});

// ── the day-trader's side of the partition ──────────────────────────────────────
const enter = (sym) => ({
  symbol: sym, direction: 'BULLISH', entry_price: 100, atr: 1,
  zones: [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }],
  convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 },
});
const pos = (sym, mv, px = 100, entry = px) => ({ symbol: sym, qty: mv / px, avg_entry_price: entry, current_price: px, market_value: mv });
function traderBridge(positions, orders = []) {
  const buys = [], sells = [];
  return {
    buys, sells, positions,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => orders.map((o) => ({ ...o })),
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
// The book holds `names` (bought at `since`), loaded into the process's book the way the server's first pass loads it.
function bookHolds(names, since = Date.now() - 3600000) {
  ob._reset();
  const sf = stateFile();
  const held = {}; for (const s of names) held[s] = { qty: 10, day: D1, px: 100, at: since };
  fs.writeFileSync(sf, JSON.stringify({ held, tried: { day: null, syms: [] }, sells: [] }));
  ob.partition(USER, { env: ARMED, stateFile: sf });
}
const pass = (bridge, signals, env, now = 1_700_000_000_000) => withEnv({ ...TRADER_ENV, ...env }, () =>
  at.runAutoTrade({ signals }, { bridge, userId: USER, accountId: 'ACC-onb', now }));

test('the trader never sells the book\'s names: the scan pass and the fast-exit tick leave them alone', async () => {
  const book = () => [pos('SPY', 9000, 90, 100)];   // 10 % under its basis trips the -8 % backstop
  bookHolds(['SPY']);
  at._resetCooldowns();
  const ctl = traderBridge(book());
  await pass(ctl, [], {});
  assert.equal(ctl.sells.length, 1, 'control: without the knob it is an ordinary long, and the backstop sells it');
  at._resetCooldowns();
  const b = traderBridge(book());
  await pass(b, [], ARMED);
  assert.equal(b.sells.length, 0, 'the scan pass leaves the book\'s name alone');
  await withEnv({ ...TRADER_ENV, ...ARMED }, async () => {
    at._resetCooldowns();
    const f = traderBridge(book());
    await at.fastExitTick({ bridge: f, userId: USER, accountId: 'ACC-onb', now: 1_700_000_100_000 });
    assert.equal(f.sells.length, 0, 'and so does the fast-exit loop');
  });
});

test('slots and gross: the book\'s names are not a slot, but they are gross exposure', async () => {
  bookHolds(['SPY']);
  at._resetCooldowns();
  const slots = { TRADER_MAX_CONCURRENT: '1', TRADER_MAX_GROSS_PCT: '0', TRADER_SLOT_RESERVE: '0' };
  const ctl = traderBridge([pos('SPY', 5500)]);
  const c = await pass(ctl, [enter('GLD')], slots);
  assert.equal(ctl.buys.length, 0, 'control: without the knob SPY takes the one slot');
  assert.ok(c.skipped.some((s) => /concurrent cap/.test(s.why)));
  at._resetCooldowns();
  const b = traderBridge([pos('SPY', 5500)]);
  await pass(b, [enter('GLD')], { ...ARMED, ...slots });
  assert.equal(b.buys.length, 1, 'the book\'s SPY is not one of the trader\'s slots');
  at._resetCooldowns();
  // $100k equity, cap 60 %: GLD $40k + the book's SPY $19.9k = $59.9k, so any new entry passes 60 % when the book counts.
  const g = traderBridge([pos('GLD', 40000), pos('SPY', 19900)]);
  const r = await pass(g, [enter('XLK')], { ...ARMED, TRADER_MAX_CONCURRENT: '0' });
  assert.equal(g.buys.length, 0, 'the book\'s notional counts toward the cash floor');
  assert.ok(r.skipped.some((s) => s.symbol === 'XLK' && /cash reserve: gross/.test(s.why)));
});

test('the morning sale is not a dropout: three names leaving while still the book\'s do not hold the trader\'s entries', async () => {
  const before = [pos('GLD', 20000, 380), pos('SPY', 5500, 690), pos('QQQ', 5500, 610), pos('SMH', 5500, 300)];
  const after = [pos('GLD', 20000, 380)];
  const twoPasses = async (env) => {
    at._resetCooldowns();
    await pass(traderBridge(before), [], env, 1_700_000_000_000);
    const b = traderBridge(after);
    const out = await pass(b, [enter('XLK')], env, 1_700_000_060_000);
    return { b, out };
  };
  bookHolds(['SPY', 'QQQ', 'SMH']);
  const ctl = await twoPasses({});
  assert.equal(ctl.b.buys.length, 0, 'control: without the knob, three names gone at once with no exit read as a dropout');
  assert.ok(ctl.out.skipped.some((s) => /entries wait/.test(String(s.why))));
  bookHolds(['SPY', 'QQQ', 'SMH']);
  const book = await twoPasses(ARMED);
  assert.equal(book.b.buys.length, 1, `the book's sale is explained: ${JSON.stringify(book.out.skipped.slice(0, 3))}`);
});

test('the book\'s sale is not the trader\'s exit: its filled sell order is never booked, now or after the name is released', async () => {
  const fill = { orderId: 'B77', symbol: 'SPY', side: 'SELL', status: 'Filled', filledQty: 77, avgPrice: 693.1, orderType: 'MKT', time: Date.now() };
  const exits = () => fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.event === 'exit' && r.symbol === 'SPY' && String(r.order_id) === 'B77').length;
  bookHolds(['SPY']);
  at._resetCooldowns();
  await pass(traderBridge([pos('GLD', 20000, 380)], [fill]), [], ARMED);
  assert.equal(exits(), 0, 'while the name is still the book\'s');
  ob._reset();   // released: the name is gone from the book, the sale order id is on record
  const sf = stateFile();
  fs.writeFileSync(sf, JSON.stringify({ held: {}, tried: { day: null, syms: [] }, sells: [{ symbol: 'SPY', orderId: 'B77', qty: 77, at: Date.now() }] }));
  ob.partition(USER, { env: ARMED, stateFile: sf });
  at._resetCooldowns();
  await pass(traderBridge([pos('GLD', 20000, 380)], [{ ...fill, orderId: 'B78' }, fill]), [], ARMED);
  assert.equal(exits(), 0, 'nor after the release');
  ob._reset();
  at._resetCooldowns();
  await pass(traderBridge([pos('GLD', 20000, 380)], [{ ...fill, orderId: 'B79' }]), [], {});
  const ctl = fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.event === 'exit' && r.symbol === 'SPY' && String(r.order_id) === 'B79').length;
  assert.equal(ctl, 1, 'control: without the book, a filled sell in the feed is booked as an exit');
});

test('the session record is the trader\'s book: the book and the fund are listed apart, not carried, not day P&L', async () => {
  // Stable 2026-10-28: the book's SPY is on the scan list and the ledger's last SPY entry is an old one, so the book's
  // 15:55 buy was valued from the prior close as the trader's carry. Here 10 SPY, prior close 690, mark 700 = +$100.
  // Past dates, so no row this file stamps with the real clock lands on them.
  const DAYS = ['2026-10-21', '2026-10-22'];
  const md = require('../lib/market-data-yahoo');
  const savedQuotes = md.getQuotes;
  md.getQuotes = async (syms) => syms.map((s) => ({ ticker: s, price: s === 'SPY' ? 700 : 380, chg_pct: s === 'SPY' ? (700 / 690 - 1) * 100 : 0 }));
  const book = () => [
    { symbol: 'GLD', qty: 50, avg_entry_price: 375, current_price: 380, market_value: 19000, unrealized_pl: 250 },
    { symbol: 'SPY', qty: 10, avg_entry_price: 699.5, current_price: 700, market_value: 7000, unrealized_pl: 5 },
    { symbol: 'BOXX', qty: 300, avg_entry_price: 118.7, current_price: 118.8, market_value: 35640, unrealized_pl: 30 },
  ];
  const watch = (sym) => ({ symbol: sym, direction: 'NEUTRAL', convergence: { decision: 'WAIT' } });
  const seed = (r) => fs.appendFileSync(process.env.TRADER_TRADES_LOG, JSON.stringify(r) + '\n');
  const sessionOf = (day) => fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.event === 'session' && r.date === day).pop();
  const FUND = { TRADER_RESERVE_FUND_PCT: '35', TRADER_RESERVE_FUND_SYMBOL: 'BOXX' };
  try {
    for (const [day, env] of [[DAYS[0], {}], [DAYS[1], { ...ARMED, ...FUND }]]) {
      seed({ ts: new Date(AT('2026-10-13', '10:00')).toISOString(), event: 'entry', symbol: 'SPY', qty: 10, entry: 690 });
      seed({ ts: new Date(AT(day, '10:00')).toISOString(), event: 'entry', symbol: 'GLD', qty: 50, entry: 375 });
      bookHolds(['SPY']);
      at._resetCooldowns();
      await pass(traderBridge(book()), [enter('GLD'), watch('SPY'), watch('BOXX')], env, AT(day, '16:00', 30));   // the row is written past the entries
    }
  } finally { md.getQuotes = savedQuotes; }
  const ctl = sessionOf(DAYS[0]);
  assert.ok(ctl, 'control: a session row was written');
  assert.deepStrictEqual(ctl.carried_out.map((p) => p.symbol), ['BOXX', 'GLD', 'SPY'], 'control: without the knobs all three are the trader\'s');
  assert.equal(ctl.day_pnl, 380, 'control: GLD +250 since entry, SPY +100 from the prior close, BOXX +30');
  const r = sessionOf(DAYS[1]);
  assert.ok(r, 'a session row was written');
  assert.deepStrictEqual(r.carried_out.map((p) => p.symbol), ['GLD'], 'the book\'s SPY and the fund\'s BOXX are not the trader\'s carries');
  assert.equal(r.open_risk, 250);
  assert.equal(r.day_pnl, 250, 'the trader\'s day is its GLD; the book\'s +$100 is not');
  assert.deepStrictEqual(r.partition_out.map((p) => [p.symbol, p.qty]), [['BOXX', 300], ['SPY', 10]]);
});
