'use strict';
/**
 * stale-position-double-sale.test.js — the SOLD-RECENTLY GUARD (2026-11-23).
 *
 * Live on stable (IBKR paper), twice in one week, the account went SHORT because the positions read kept showing a long
 * this engine had already sold, for longer than one scan:
 *   XOP 2026-11-17: the stepped stop filled at 09:46:23; the 09:47 scan booked the fill (and the same-scan guard held);
 *     the 09:49 scan still read 451 shares, with the mark unchanged to eight decimals, saw no working stop, raised a new
 *     one and it sold at once: short 451.
 *   JNUG 2026-11-18: the pre-market max-loss sale filled at 07:43:16; the next scan still read 817 shares, the orders
 *     feed did not show the fill yet, and re-protect put a stop under a falling price: short 817.
 * The same-scan guard (same-scan-fill-oversell.test.js) covers only the scan that books the fill. A sale of ours must
 * block every sell-side order for the symbol until the positions read reflects it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'staledouble-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
// Hermetic exits, as step-floor.test.js: the fixture holds a REAL ticker, so the market-data-driven exits are pinned
// to their armed production values and cannot close the position out from under the behaviour being tested.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
// A fixed regular-hours clock (Tuesday 2026-11-17 11:00 ET), so no scan reads the wall clock.
const T0 = Date.parse('2026-11-17T16:00:00Z');
const MIN = 60000;

/** A world whose positions and orders the test moves by hand. A cancelled order STAYS in the feed as Cancelled (as on
 *  IBKR), so the orders read is never empty: an empty read would defer re-protect on its own and hide the defect. */
let WORLD = 0;
function world({ qty = 100, entry = 100, mark = 101.2, orders = [] } = {}) {
  const tag = 'W' + (++WORLD);
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty, entry, mark, ts: T0 } }, entryAt: { LNG: T0 - 3 * 3600000 } }));
  at._loadState();
  const w = { positions: [{ symbol: 'LNG', qty, avg_entry_price: entry, current_price: mark, market_value: qty * mark, unrealized_pl: qty * (mark - entry) }],
    orders: orders.slice(), placed: [], tag };
  w.bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => w.positions.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => w.orders.map((o) => ({ ...o })),
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => { const o = w.orders.find((x) => x.orderId === id); if (o) o.status = 'Cancelled'; return { status: 'cancelled' }; },
    placeIBKROrder: async (uid, o) => { const id = tag + 'X' + (w.placed.length + 1); w.placed.push({ ...o, order_id: id }); return { status: 'placed', order_id: id }; },
  };
  return w;
}
const scan = { signals: [] };
const run = (w, t) => at.runAutoTrade(scan, { bridge: w.bridge, userId: 't', now: t });
const sells = (w) => w.placed.filter((o) => String(o.ticker || o.symbol).toUpperCase() === 'LNG' && /sell/i.test(String(o.side)));
const ev = (name) => rows().filter((r) => r.event === name && r.symbol === 'LNG');
const withEnv = async (env, fn) => { const old = {}; for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const STEP = { TRADER_BE_RATCHET: '0.01', TRADER_BE_LOCK: '0.01', TRADER_STEP_FLOOR: '1' };
const filledStop = (id) => ({ orderId: id, symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Filled', qty: 100, price: 101, filledQty: 100, avgPrice: 101, filledAt: new Date(T0 - 5000).toISOString() });

test('XOP 11-17: a stop fill booked one scan ago gets NO new stop while the positions read still shows the shares', async () => {
  await withEnv(STEP, async () => {
    const w = world({ orders: [filledStop('F1')] });
    await run(w, T0);                                    // the scan that books the fill (the same-scan guard)
    assert.strictEqual(ev('exit').length, 1, 'the fill is booked once');
    assert.strictEqual(sells(w).length, 0, 'no sell in the booking scan');
    await run(w, T0 + 1.5 * MIN);                        // the NEXT scan: the read is still stale, the fill is old news
    assert.strictEqual(sells(w).length, 0, `no stop on shares already sold (placed: ${JSON.stringify(sells(w))})`);
    assert.strictEqual(ev('stop_resize').length, 0, 'no ratchet on a position that left the book');
    assert.strictEqual(ev('max_hold_clock_adopted').length, 0, 'the sold shares are not adopted as a new holding');
    assert.strictEqual(ev('sold_guard').length, 1, 'the guard is journaled once');
    await run(w, T0 + 3 * MIN);                          // still stale: still nothing, and no second journal row
    assert.strictEqual(sells(w).length, 0);
    assert.strictEqual(ev('sold_guard').length, 1);
    w.positions = [];                                    // the read catches up
    await run(w, T0 + 4 * MIN); await run(w, T0 + 5 * MIN); await run(w, T0 + 6 * MIN);
    assert.strictEqual(sells(w).length, 0, 'nothing is sold after the read went flat');
    assert.strictEqual(ev('exit').length, 1, 'no second, reconstructed exit row for the same shares');
    assert.strictEqual(at._soldGuard.has('LNG'), false, 'the guard is released once the read reflects the sale');
  });
});

test('JNUG 11-18: after an accepted exit, a read that still shows the shares gets no stop and no second exit', async () => {
  await withEnv({ TRADER_MAX_LOSS_PCT: '8' }, async () => {
    const stop = { orderId: 'S2', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Submitted', qty: 100, price: 97 };
    const w = world({ mark: 91, orders: [stop] });      // -9 %: past the 8 % cap
    await run(w, T0);
    assert.strictEqual(sells(w).length, 1, 'the max-loss exit sells once');
    assert.strictEqual(String(sells(w)[0].type), 'market');
    assert.strictEqual(w.orders[0].status, 'Cancelled', 'its stop was cancelled first');
    // next scan: positions still show 100, the orders feed does not show the exit order yet (only the cancelled stop)
    await run(w, T0 + 1.3 * MIN);
    assert.strictEqual(sells(w).length, 1, `no re-protect stop and no second exit on the sold shares (placed: ${JSON.stringify(sells(w))})`);
    assert.strictEqual(ev('sold_guard').length, 1);
    // the feed shows the exit FILLED, the positions read still lags
    w.orders.push({ orderId: w.tag + 'X1', symbol: 'LNG', side: 'SELL', orderType: 'Market', status: 'Filled', qty: 100, filledQty: 100, avgPrice: 91, filledAt: new Date(T0 + 2000).toISOString() });
    await run(w, T0 + 2.6 * MIN);
    assert.strictEqual(ev('exit').length, 1, 'the fill is booked once');
    assert.strictEqual(sells(w).length, 1);
    await run(w, T0 + 4 * MIN);                          // booked a scan ago, read still stale: the guard now rests on the fill
    assert.strictEqual(sells(w).length, 1);
    w.positions = [];
    await run(w, T0 + 5 * MIN); await run(w, T0 + 6 * MIN); await run(w, T0 + 7 * MIN);
    assert.strictEqual(sells(w).length, 1);
    assert.strictEqual(ev('exit').length, 1, 'no reconstructed second exit');
  });
});

test('the fast exit tick honours the guard too', async () => {
  await withEnv({ TRADER_MAX_LOSS_PCT: '8' }, async () => {
    const stop = { orderId: 'S3', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Submitted', qty: 100, price: 97 };
    const w = world({ mark: 91, orders: [stop] });
    await run(w, T0);
    assert.strictEqual(sells(w).length, 1);
    // past the 8-minute exit-reattempt debounce, the read still stale: the price-only tick must not sell again
    await at.fastExitTick({ bridge: w.bridge, userId: 't', now: T0 + 9 * MIN });
    assert.strictEqual(sells(w).length, 1, `the tick does not re-fire the exit (placed: ${JSON.stringify(sells(w))})`);
  });
});

test('an exit order that shows DEAD with nothing filled releases the guard: the long is real and is protected again', async () => {
  await withEnv({ TRADER_MAX_LOSS_PCT: '8', TRADER_EXIT_REATTEMPT_MIN: '30' }, async () => {
    const stop = { orderId: 'S4', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Submitted', qty: 100, price: 97 };
    const w = world({ mark: 91, orders: [stop] });
    await run(w, T0);
    assert.strictEqual(sells(w).length, 1);
    w.orders.push({ orderId: w.tag + 'X1', symbol: 'LNG', side: 'SELL', orderType: 'Market', status: 'Cancelled', qty: 100, filledQty: 0 });
    await run(w, T0 + 1.3 * MIN);
    assert.strictEqual(at._soldGuard.has('LNG'), false, 'the guard is released');
    const stops = sells(w).filter((o) => String(o.type) === 'stop');
    assert.strictEqual(stops.length, 1, `the still-held long gets its stop back (placed: ${JSON.stringify(sells(w))})`);
    assert.strictEqual(ev('sold_guard_expired').length, 0);
  });
});

test('past TRADER_SOLD_HOLD_SEC the guard lapses and says so (the fallback when a read never catches up)', async () => {
  await withEnv({ ...STEP, TRADER_SOLD_HOLD_SEC: '120' }, async () => {
    const w = world({ orders: [filledStop('F5')] });
    await run(w, T0);
    await run(w, T0 + 1.5 * MIN);
    assert.strictEqual(sells(w).length, 0, 'guarded inside the hold');
    await run(w, T0 + 3.5 * MIN);                        // 210 s: past the switch, but a BOOKED fill holds three times as long
    assert.strictEqual(sells(w).length, 0, 'a booked fill is certain: still guarded at 210 s of a 120 s switch');
    await run(w, T0 + 6.5 * MIN);                        // 390 s > 3 x 120 s
    assert.strictEqual(ev('sold_guard_expired').length, 1, 'the lapse is journaled');
    assert.ok(sells(w).length >= 1, 'the sell-side passes resume on the reading');
  });
});

test('TRADER_SOLD_HOLD_SEC=0 switches the guard off (the behaviour before this fix)', async () => {
  await withEnv({ ...STEP, TRADER_SOLD_HOLD_SEC: '0' }, async () => {
    const w = world({ orders: [filledStop('F6')] });
    await run(w, T0);
    await run(w, T0 + 1.5 * MIN);
    assert.strictEqual(sells(w).length, 1, 'with the guard off the second stop goes out, as it did on 11-17');
    assert.strictEqual(ev('sold_guard').length, 0);
  });
});

test('the guard survives a restart while the read still lags', async () => {
  await withEnv(STEP, async () => {
    const w = world({ orders: [filledStop('F7')] });
    await run(w, T0);
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.ok(saved.soldGuard && saved.soldGuard.LNG, 'the guard is in the state file');
    at._resetCooldowns();                                 // the process dies: memory is gone
    fs.writeFileSync(STATE, JSON.stringify(saved));
    at._loadState();
    await run(w, T0 + 1.5 * MIN);
    assert.strictEqual(sells(w).length, 0, 'no stop on the sold shares after the restart');
  });
});

test('a PARTIAL fill the read already shows does not block the remainder: its stop is resized next scan', async () => {
  const part = { orderId: 'S8', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Submitted', qty: 100, price: 97, filledQty: 40, avgPrice: 97, filledAt: new Date(T0 - 5000).toISOString() };
  const w = world({ qty: 60, mark: 97.5, orders: [part] });   // the read is fresh: 60 left of 100
  fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark: 99, ts: T0 - MIN } }, entryAt: { LNG: T0 - 3 * 3600000 },
    stopOrders: { LNG: { id: 'S8', px: 97, qty: 100, at: T0 - 3 * 3600000 } } }));
  at._resetCooldowns(); fs.writeFileSync(STATE, JSON.stringify({ lastPos: { LNG: { qty: 100, entry: 100, mark: 99, ts: T0 - MIN } }, entryAt: { LNG: T0 - 3 * 3600000 },
    stopOrders: { LNG: { id: 'S8', px: 97, qty: 100, at: T0 - 3 * 3600000 } } })); at._loadState();
  await run(w, T0);
  assert.strictEqual(ev('exit').length, 1);
  assert.strictEqual(Number(ev('exit')[0].qty), 40);
  assert.strictEqual(at._soldGuard.has('LNG'), false, 'the read already shows the remainder: nothing to guard');
  assert.strictEqual(ev('sold_guard').length, 0);
  await run(w, T0 + 1.5 * MIN);
  const stops = sells(w).filter((o) => String(o.type) === 'stop');
  assert.strictEqual(stops.length, 1, `the 60 remaining shares get a stop of their own size (placed: ${JSON.stringify(sells(w))})`);
  assert.strictEqual(Number(stops[0].qty), 60);
});

test('an accepted exit that never shows in the orders feed lapses at the switch itself (it is not certain)', async () => {
  await withEnv({ TRADER_MAX_LOSS_PCT: '8', TRADER_SOLD_HOLD_SEC: '120', TRADER_EXIT_REATTEMPT_MIN: '30' }, async () => {
    const stop = { orderId: 'S9', symbol: 'LNG', side: 'SELL', orderType: 'Stop', status: 'Submitted', qty: 100, price: 97 };
    const w = world({ mark: 91, orders: [stop] });
    await run(w, T0);
    await run(w, T0 + 1.5 * MIN);
    assert.strictEqual(sells(w).length, 1, 'guarded inside the switch');
    await run(w, T0 + 2.5 * MIN);                        // 150 s > 120 s: the read still shows the shares, the order never appeared
    assert.strictEqual(ev('sold_guard_expired').length, 1);
    assert.strictEqual(sells(w).filter((o) => String(o.type) === 'stop').length, 1, 'the shares the read insists on get a stop again');
  });
});
