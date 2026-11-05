'use strict';
/**
 * max-loss-rth-only.test.js — TRADER_MAX_LOSS_RTH_ONLY: the loss cap may act in regular hours only.
 *
 * At 04:12 ET on 2026-11-05 the engine's -8 % cap sold C's 60 SOXL at 60.14 against a 65.36 entry, -$313.
 * On a 3x wrapper -8 % is a 2.67 % move in the 1x, and the replay the design was chosen on has no
 * extended-hours sale. Measured against the replay over 2016-2026 that sale costs $5.4k-9.4k and does not
 * help the worst week (ledger row tier0-loss-cap-in-extended-hours-2016-2026).
 *
 * The contract:
 *   - OFF unless the value is exactly '1', and off the rule is what it always was, so a box that does not
 *     set the switch (stable) changes nothing;
 *   - ON, outside regular hours: no order, the stop stays, one journal row;
 *   - ON, in regular hours: the cap sells as ever, on the price of that moment. Nothing is carried over from
 *     the extended session, so a position back above the cap stays held. It is not a deferral.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maxloss-rth-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '0';
process.env.TRADER_MAX_LOSS_PCT = '8';
// hermetic: pin the exit-authority switches so a real ticker's momentum cannot decide this suite
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
delete process.env.TRADER_MAX_LOSS_RTH_ONLY;
const at = require('../lib/auto-trader');
const { createOwnership } = require('../lib/two-sleeve/ownership');
const { createEngine } = require('../lib/two-sleeve/engine');

const PRE_MARKET = Date.parse('2026-11-05T09:12:34Z');    // 04:12:34 ET, the live sale's minute
const AFTER_HOURS = Date.parse('2026-11-04T22:00:00Z');   // 17:00 ET the evening before
const NEXT_PRE = Date.parse('2026-11-06T09:12:34Z');      // 04:12:34 ET the following day
const OPEN = Date.parse('2026-11-05T14:31:00Z');          // 09:31 ET
const ENTRY = 65.36;
const AT_CAP = 60.13;                                     // the live mark: -8.0 %

const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const heldRows = () => rows().filter((r) => r.event === 'max_loss_held');
const isExitOrder = (o) => o.side === 'sell' && !/stop/i.test(o.type || '');

function world() {
  at._resetCooldowns();
  at._deferredExit.clear();
  if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG);
  const placed = [], cancels = [];
  const stops = [{ orderId: 'STP1', symbol: 'SOXL', side: 'sell', orderType: 'STP', status: 'Submitted', qty: 60, stopPrice: 59.76 }];
  return {
    placed, cancels,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [],
    getIBKROpenOrders: async () => stops.map((o) => ({ ...o })),
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (uid, id) => {
      cancels.push(id);
      const o = stops.find((x) => x.orderId === id);
      if (o) o.status = 'Cancelled';
      return { status: 'cancelled', ok: true };
    },
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
}

/** One pass of the real exit rules over a held SOXL at this mark. */
async function pass(b, { now, extended, mark, entry = ENTRY, qty = 60 }) {
  const out = { skipped: [], executed: [] };
  await at._manageHeldExitsForTest({
    bridge: b, userId: 'u', c: at.cfg(), now, out, extended,
    heldPos: { SOXL: { symbol: 'SOXL', qty, avg_entry_price: entry, current_price: mark } },
    heldQty: { SOXL: qty },
  });
  return out;
}

/** Run with the switch at this value (undefined = unset), and put it back afterwards. */
async function withSwitch(value, fn) {
  const prev = process.env.TRADER_MAX_LOSS_RTH_ONLY;
  try {
    if (value === undefined) delete process.env.TRADER_MAX_LOSS_RTH_ONLY; else process.env.TRADER_MAX_LOSS_RTH_ONLY = value;
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TRADER_MAX_LOSS_RTH_ONLY; else process.env.TRADER_MAX_LOSS_RTH_ONLY = prev;
  }
}

test('the switch is off unless the value is exactly 1', async () => {
  for (const v of [undefined, '', '0', 'true', 'shadow', '01']) {
    await withSwitch(v, () => assert.strictEqual(at.cfg().maxLossRthOnly, false, `value ${String(v)} must leave it off`));
  }
  await withSwitch('1', () => assert.strictEqual(at.cfg().maxLossRthOnly, true));
});

for (const value of [undefined, '', '0']) {
  test(`SWITCH OFF (${JSON.stringify(value)}): past the cap in extended hours sells exactly as it does today`, async () => {
    await withSwitch(value, async () => {
      const b = world();
      const out = await pass(b, { now: PRE_MARKET, extended: true, mark: AT_CAP });
      const sells = b.placed.filter(isExitOrder);
      assert.strictEqual(sells.length, 1, 'a box that does not set the switch keeps its dark sale');
      assert.strictEqual(sells[0].type, 'limit');
      assert.strictEqual(sells[0].outsideRth, true);
      assert.strictEqual(sells[0].limitPrice, 60.01, 'marketable limit, 0.2 % under the mark');
      assert.deepStrictEqual(b.cancels, ['STP1'], 'the resting stop is cancelled first, as always');
      assert.ok(out.executed.some((e) => e.action === 'exit_long' && /^max_loss/.test(e.reason || '')));
      assert.strictEqual(heldRows().length, 0, 'and no new journal row');
    });
  });
}

for (const [window, now] of [['pre-market', PRE_MARKET], ['after hours', AFTER_HOURS]]) {
  test(`SWITCH ON, ${window}: past the cap places nothing, keeps the stop, journals one row`, async () => {
    await withSwitch('1', async () => {
      const b = world();
      const marks = [AT_CAP, 59.5, 58];
      for (let i = 0; i < marks.length; i++) {
        const out = await pass(b, { now: now + i * 60e3, extended: true, mark: marks[i] });
        assert.ok(out.skipped.some((s) => s.symbol === 'SOXL' && /max_loss held/.test(s.why)), 'the pass says why it held');
        assert.strictEqual(out.executed.length, 0);
      }
      assert.deepStrictEqual(b.placed, [], 'no order of any kind reaches the broker');
      assert.deepStrictEqual(b.cancels, [], 'the protective stop stays where it is');
      assert.strictEqual(at._deferredExit.size, 0, 'it is not a deferral: nothing waits for the open');
      assert.strictEqual(rows().filter((r) => /^exit/.test(r.event)).length, 0, 'no exit rows');
      const held = heldRows();
      assert.strictEqual(held.length, 1, 'one row, however many passes see it');
      assert.strictEqual(held[0].symbol, 'SOXL');
      assert.strictEqual(held[0].qty, 60);
      assert.strictEqual(held[0].entry, ENTRY);
      assert.strictEqual(held[0].mark, AT_CAP, 'the row keeps the first touch');
      assert.strictEqual(held[0].loss_pct, -8);
      assert.strictEqual(held[0].cap_pct, 8);
    });
  });
}

test('SWITCH ON, regular hours: past the cap sells as ever, at market', async () => {
  await withSwitch('1', async () => {
    const b = world();
    const out = await pass(b, { now: OPEN, extended: false, mark: AT_CAP });
    const sells = b.placed.filter(isExitOrder);
    assert.strictEqual(sells.length, 1);
    assert.strictEqual(sells[0].type, 'market');
    assert.ok(out.executed.some((e) => e.action === 'exit_long' && /^max_loss/.test(e.reason || '')));
    assert.strictEqual(heldRows().length, 0);
  });
});

test('SWITCH ON: back above the cap at the open stays held; the rule reads the price of that moment', async () => {
  await withSwitch('1', async () => {
    const b = world();
    await pass(b, { now: PRE_MARKET, extended: true, mark: 58 });
    await pass(b, { now: OPEN, extended: false, mark: 61 });
    assert.strictEqual(b.placed.filter(isExitOrder).length, 0, 'the 04:12 touch carries nothing into the session');
    assert.strictEqual(at._deferredExit.size, 0);
    await pass(b, { now: OPEN + 5 * 60e3, extended: false, mark: AT_CAP });
    assert.strictEqual(b.placed.filter(isExitOrder).length, 1, 'and the cap still acts later in the session');
  });
});

test('SWITCH ON: still past the cap at the open sells on the first regular-hours pass', async () => {
  await withSwitch('1', async () => {
    const b = world();
    await pass(b, { now: PRE_MARKET, extended: true, mark: 58 });
    assert.strictEqual(b.placed.filter(isExitOrder).length, 0);
    const out = await pass(b, { now: OPEN, extended: false, mark: 58.2 });
    const sells = b.placed.filter(isExitOrder);
    assert.strictEqual(sells.length, 1);
    assert.strictEqual(sells[0].type, 'market');
    assert.ok(out.executed.some((e) => /^max_loss/.test(e.reason || '')));
  });
});

test('SWITCH ON: a position inside the cap writes nothing', async () => {
  await withSwitch('1', async () => {
    const b = world();
    const out = await pass(b, { now: PRE_MARKET, extended: true, mark: 62 });
    assert.deepStrictEqual(b.placed, []);
    assert.strictEqual(heldRows().length, 0);
    assert.ok(!out.skipped.some((s) => /max_loss held/.test(s.why)));
  });
});

test('SWITCH ON: the rest of the pass still runs, so a trail past its trigger defers to the open as usual', async () => {
  await withSwitch('1', async () => {
    const b = world();
    at._peak.set('SOXL', 70);   // ran up 7 % first, so the trail is armed and far past its trigger
    await pass(b, { now: PRE_MARKET, extended: true, mark: AT_CAP });
    assert.strictEqual(b.placed.filter(isExitOrder).length, 0, 'still nothing in the dark');
    assert.ok(at._deferredExit.has('SOXL'), 'the trail decided, as it does for any position');
    assert.strictEqual(heldRows().length, 1, 'and the cap stood aside on the record');
    assert.ok(rows().some((r) => r.event === 'exit_deferred' && /^trailing_stop/.test(r.reason)));
    await pass(b, { now: OPEN, extended: false, mark: 61 });
    const sells = b.placed.filter(isExitOrder);
    assert.strictEqual(sells.length, 1, 'the deferred decision fills at the open');
    assert.strictEqual(sells[0].type, 'market');
  });
});

test('SWITCH ON: one row per position per ET day; the next day or a new entry price writes another', async () => {
  await withSwitch('1', async () => {
    const b = world();
    await pass(b, { now: PRE_MARKET, extended: true, mark: AT_CAP });
    await pass(b, { now: PRE_MARKET + 30 * 60e3, extended: true, mark: 59 });
    assert.strictEqual(heldRows().length, 1, 'the same morning is one row');
    await pass(b, { now: NEXT_PRE, extended: true, mark: 58 });
    assert.strictEqual(heldRows().length, 2, 'the same position the next day is a new row');
    await pass(b, { now: NEXT_PRE + 60e3, extended: true, mark: 60, entry: 66 });
    assert.strictEqual(heldRows().length, 3, 'a new entry price is a new position');
    assert.strictEqual(heldRows()[2].entry, 66);
  });
});

// ---------------------------------------------------------------------------
// through the real runAutoTrade and the real engine core: the switch is a sleeve's key
// ---------------------------------------------------------------------------
function engineBook() {
  const positions = [
    { symbol: 'SOXL', qty: 60, avg_entry_price: ENTRY, current_price: AT_CAP, market_value: 60 * AT_CAP, unrealized_pl: 60 * (AT_CAP - ENTRY) },
    { symbol: 'TQQQ', qty: 40, avg_entry_price: 100, current_price: 90, market_value: 3600, unrealized_pl: -400 },
  ];
  const placed = [];
  return {
    placed,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => [
      { orderId: 'S1', symbol: 'SOXL', side: 'sell', orderType: 'STP', status: 'Submitted', qty: 60, stopPrice: 59.76 },
      { orderId: 'S2', symbol: 'TQQQ', side: 'sell', orderType: 'STP', status: 'Submitted', qty: 40, stopPrice: 85 },
    ],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async () => ({ status: 'cancelled', ok: true }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'E' + placed.length }; },
  };
}

test('ENGINE: one sleeve on and one off in the same tick, each by its own env map', async () => {
  world();
  const facade = engineBook();
  const ownership = createOwnership({ file: path.join(DIR, 'ownership.json') });
  ownership.claim('SOXL', 'C');
  ownership.claim('TQQQ', 'S');
  const eng = createEngine({
    sleeves: [
      { id: 'S', brain: at, env: { TRADER_MAX_LOSS_RTH_ONLY: '' }, userId: 'u' },
      { id: 'C', brain: at, env: { TRADER_MAX_LOSS_RTH_ONLY: '1' }, userId: 'u' },
    ],
    order: ['S', 'C'], facade, ownership,
  });
  const res = await eng.tick({ signals: [] }, { now: PRE_MARKET, extended: true, protectiveOnly: true, userId: 'u' });
  assert.ok(!res.S.error && !res.C.error, 'both brains ran');
  assert.deepStrictEqual(facade.placed.filter(isExitOrder).map((o) => o.ticker), ['TQQQ'], 'only the sleeve without the switch sells');
  assert.deepStrictEqual(heldRows().map((r) => r.symbol), ['SOXL'], 'the sleeve with it holds, on the record');
  assert.strictEqual(process.env.TRADER_MAX_LOSS_RTH_ONLY, undefined, 'and the key does not leak out of the tick');
});

test('ENGINE: the same sleeve in regular hours sells as ever', async () => {
  world();
  const facade = engineBook();
  const ownership = createOwnership({ file: path.join(DIR, 'ownership-rth.json') });
  ownership.claim('SOXL', 'C');
  ownership.claim('TQQQ', 'C');
  const eng = createEngine({
    sleeves: [{ id: 'C', brain: at, env: { TRADER_MAX_LOSS_RTH_ONLY: '1' }, userId: 'u' }],
    order: ['C'], facade, ownership,
  });
  await eng.tick({ signals: [] }, { now: OPEN, extended: false, protectiveOnly: false, userId: 'u' });
  assert.deepStrictEqual(facade.placed.filter(isExitOrder).map((o) => o.ticker).sort(), ['SOXL', 'TQQQ']);
  assert.strictEqual(heldRows().length, 0);
});
