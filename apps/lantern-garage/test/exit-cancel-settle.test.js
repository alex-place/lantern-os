'use strict';
/**
 * exit-cancel-settle.test.js — the exit path WAITS for the resting stop's cancel to finish
 * (within a per-scan budget) instead of selling into the reservation, when
 * TRADER_EXIT_CANCEL_SETTLE_MS is set. Unset, nothing changes.
 *
 * Engine, Alpaca paper, 2026-10-26..11-13: of 15 clock-time exits that needed a retry, 6 stayed
 * refused through all three ("insufficient qty available ... available: 0") and sold on the next
 * scan 65-76 s later: the leg's 15:55 de-carry on 11-02 (SOXS), 11-09 (SOXL) and 11-13 (SOXS);
 * close-IBS max-hold on 11-03 (QQQ, XLK) and 11-04 (IWM). The broker's order history: at
 * 15:50-15:55 the resting stop took 4-17 s to finish cancelling (11-13 SOXS: the stop read
 * canceled at 15:55:44.9, about nine seconds after the last retry), and the patience in the
 * exit path ends after about seven.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exitsettle-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
// hermetic exits (#3459): pin the exit-authority switches so a real ticker's tape cannot decide this suite
process.env.TRADER_MOMENTUM_EXIT = '0'; process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0'; process.env.TRADER_EXIT_MIN_PWIN = '0'; process.env.TRADER_EOD_DECARRY = '0';
process.env.TRADER_EXIT_QTY_RETRIES = '3';
process.env.TRADER_EXIT_QTY_RETRY_MS = '5';   // the production default is 1000 ms
delete process.env.TRADER_EXIT_CANCEL_SETTLE_MS;
delete process.env.TRADER_EXIT_CANCEL_POLL_MS;
const at = require('../lib/auto-trader');

const REFUSAL = (n) => `insufficient qty available for order (requested: ${n}, available: 0)`;
const ET_AT = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`).getTime();
const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { at._resetCooldowns(); if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG); };
const withEnv = async (vars, fn) => {
  const prev = {}; for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = String(vars[k]); }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

// A broker that cancels slowly, as Alpaca does near the close. Each resting stop is a row of the
// engine's order feed. A cancel request moves it to 'pending_cancel'; it reads 'canceled' only after
// `reads` more reads of the feed (Infinity = never). While a symbol's stop is not fully cancelled the
// shares are reserved and a market sell is refused with the broker's own text.
function world(specs = { SMH: { reads: 8 } }) {
  const placed = [], cancels = [];
  let feedReads = 0;
  const stops = Object.entries(specs).map(([symbol, s], i) => ({ orderId: 'STP' + (i + 1), symbol, side: 'SELL', orderType: 'stop',
    status: s.status || 'submitted', qty: 15, _need: s.reads ?? 0, _seen: 0 }));
  const advance = () => { for (const s of stops) if (s.status === 'pending_cancel' && ++s._seen >= s._need) s.status = 'canceled'; };
  const reserved = (sym) => stops.some((s) => s.symbol === sym && s.status !== 'canceled');
  const marketSells = (sym) => placed.filter((o) => o.side === 'sell' && !/stop/i.test(o.type || '') && (!sym || o.ticker === sym));
  return {
    placed, cancels, marketSells, stops, feedReads: () => feedReads,
    accepted: (sym) => marketSells(sym).filter((o) => o._ok),
    bridge: {
      getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
      getIBKRPositions: async () => Object.keys(specs).map((symbol) => ({ symbol, qty: 15, avg_entry_price: 522.56, current_price: 526.96, market_value: 7904.4, unrealized_pl: 66 })),
      getIBKROpenOrders: async () => { feedReads++; advance(); return stops.map((s) => ({ orderId: s.orderId, symbol: s.symbol, side: s.side, orderType: s.orderType, status: s.status, qty: s.qty })); },
      getIBKRDayPnl: async () => 0,
      getIBKROrderStatus: async () => null,
      cancelIBKROrder: async (uid, id) => { cancels.push(id); const o = stops.find((x) => x.orderId === id); if (o && o.status === 'submitted') { o.status = o._need > 0 ? 'pending_cancel' : 'canceled'; } return true; },
      placeIBKROrder: async (uid, o) => {
        placed.push(o);
        if (/stop/i.test(o.type || '')) return { status: 'submitted', order_id: 'S' + placed.length };   // re-protection stops pass
        if (reserved(o.ticker)) return { status: 'error', reason: REFUSAL(o.qty) };
        o._ok = true;
        return { status: 'submitted', order_id: 'X' + placed.length };
      },
    },
  };
}
const HP = { avg_entry_price: 522.56, current_price: 526.96 };
const DECARRY = 'eod_decarry (leveraged overnight gap risk #3298) — flat into the close';
const close = (w, sym = 'SMH', reason = DECARRY) =>
  at._closeLongForTest(w.bridge, 'u', sym, 15, HP, reason, { skipped: [], executed: [] }, Date.now(), { extended: false, refPrice: 526.96 });

test('switch unset: a stop still cancelling outlasts the three retries (the 11-13 SOXS de-carry, as it happened)', async () => {
  reset();
  const w = world({ SMH: { reads: 8 } });
  at._entryAtSet('SMH', ET_AT('2026-11-13', 10, 0));
  const r = await close(w);
  assert.strictEqual(w.marketSells().length, 4, 'the first attempt and three retries, all refused');
  assert.strictEqual(w.accepted().length, 0);
  assert.strictEqual(r.keptOpen, true, 'the sale waits for the next scan');
  assert.strictEqual(w.feedReads(), 7, 'one read to find the stop, three settle checks, one read a retry: the stop needed an eighth');
  const ei = rows().filter((x) => x.event === 'exit_intent');
  assert.strictEqual(ei.length, 1);
  assert.strictEqual(ei[0].kept_open, true);
  assert.ok(!('cancel_settle_ms' in ei[0]), 'the journal row is the row of today');
  assert.strictEqual(at._exitSettleSpent(), 0, 'no budget exists while the switch is unset');
});

test('switch unset: cancelRestingStops returns the shape it always did', async () => {
  reset();
  const w = world({ SMH: { reads: 0 } });
  const r = await at.cancelRestingStops(w.bridge, 'u', 'SMH');
  assert.deepStrictEqual(r, { cancelled: ['STP1'] });
});

test('switch set: the same broker — the engine waits for the cancel and sells once, in the same scan', async () => {
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 5000, TRADER_EXIT_CANCEL_POLL_MS: 5 }, async () => {
    reset();
    const w = world({ SMH: { reads: 8 } });
    at._entryAtSet('SMH', ET_AT('2026-11-13', 10, 0));
    const r = await close(w);
    assert.strictEqual(w.marketSells().length, 1, 'no sale is sent into the reservation');
    assert.strictEqual(w.accepted().length, 1);
    assert.strictEqual(r.status, 'submitted');
    assert.ok(!r.keptOpen);
    assert.deepStrictEqual(w.cancels, ['STP1'], 'the stop is cancelled once');
    const ei = rows().filter((x) => x.event === 'exit_intent');
    assert.strictEqual(ei.length, 1, 'one exit decision, one journal row');
    assert.strictEqual(ei[0].status, 'submitted');
    assert.ok(!('retries' in ei[0]), 'nothing was refused, so nothing was retried');
    assert.ok(ei[0].cancel_settle_ms > 0, 'the wait is on the record');
    assert.strictEqual(at._entryAtGet('SMH'), undefined, 'a placed exit clears the position state as before');
    assert.ok(at._exitAtGet('SMH') > 0, 'and arms the re-attempt debounce as before');
    assert.ok(at._exitSettleSpent() > 0);
  });
});

test('switch set: a cancel that settles at once costs one read and no wait', async () => {
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 5000, TRADER_EXIT_CANCEL_POLL_MS: 5 }, async () => {
    reset();
    const w = world({ SMH: { reads: 0 } });
    const r = await close(w);
    assert.strictEqual(w.marketSells().length, 1);
    assert.strictEqual(r.status, 'submitted');
    assert.strictEqual(w.feedReads(), 2, 'the read that finds the stop and one settle check, as before');
  });
});

test('switch set: a cancel that never finishes costs the budget once, then the old path — the close cannot hang', async () => {
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 150, TRADER_EXIT_CANCEL_POLL_MS: 5 }, async () => {
    reset();
    const w = world({ SMH: { reads: Infinity } });
    const entered = ET_AT('2026-11-13', 10, 0);
    at._entryAtSet('SMH', entered);
    const t0 = Date.now();
    const r = await close(w);
    const took = Date.now() - t0;
    assert.strictEqual(w.marketSells().length, 4, 'after the wait: the first attempt and the three retries of the old path');
    assert.strictEqual(r.keptOpen, true);
    assert.ok(took >= 140 && took < 2000, `the wait is the budget, not more (took ${took} ms)`);
    assert.strictEqual(at._entryAtGet('SMH'), entered, 'the position keeps its clocks, as before');
    const ei = rows().filter((x) => x.event === 'exit_intent');
    assert.strictEqual(ei[0].kept_open, true);
    assert.ok(ei[0].cancel_settle_ms >= 140, 'the spent wait is on the kept-open row');
  });
});

test('switch set: the budget is one per scan — a second exit of the same scan gets only what is left', async () => {
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 200, TRADER_EXIT_CANCEL_POLL_MS: 5 }, async () => {
    reset();
    const w = world({ SMH: { reads: Infinity }, SOXL: { reads: Infinity } });
    await close(w, 'SMH');
    const afterFirst = at._exitSettleSpent();
    assert.ok(afterFirst >= 190, `the first exit used the budget (${afterFirst} ms)`);
    const t0 = Date.now();
    const r2 = await close(w, 'SOXL');
    const took = Date.now() - t0;
    assert.strictEqual(r2.keptOpen, true);
    // With nothing left, SOXL takes the old path: three 700 ms settle checks, then the retries.
    assert.ok(took < 200 + 2100 + 1500, `the second exit did not get a budget of its own (took ${took} ms)`);
    assert.ok(at._exitSettleSpent() - afterFirst < 50, 'and added nothing to the scan\'s spend');
    const ei = rows().filter((x) => x.event === 'exit_intent' && x.symbol === 'SOXL');
    assert.ok(!('cancel_settle_ms' in ei[0]), 'its row is the row of today');
  });
});

test('switch set: a stop whose cancel was asked for EARLIER is waited on too (it reads pending-cancel)', async () => {
  // Unset: the cancel loop skips a pending-cancel stop as terminal, so nothing is waited on and every sale is refused.
  reset();
  const before = world({ SMH: { status: 'pending_cancel', reads: 6 } });
  const r0 = await close(before);
  assert.strictEqual(r0.keptOpen, true);
  assert.strictEqual(before.cancels.length, 0);
  assert.strictEqual(before.marketSells().length, 4);
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 5000, TRADER_EXIT_CANCEL_POLL_MS: 5 }, async () => {
    reset();
    const w = world({ SMH: { status: 'pending_cancel', reads: 6 } });
    const r = await close(w);
    assert.strictEqual(w.cancels.length, 0, 'no second cancel is sent for a stop that is already cancelling');
    assert.strictEqual(w.marketSells().length, 1, 'the sale waits for it and goes out once');
    assert.strictEqual(r.status, 'submitted');
  });
});

test('END TO END: with the switch set a 15:50 max-hold whose stop cancels slowly sells on the 15:50 scan; the budget refills on the next scan', async () => {
  await withEnv({ TRADER_EXIT_CANCEL_SETTLE_MS: 5000, TRADER_EXIT_CANCEL_POLL_MS: 5, TRADER_MAX_HOLD_SESSIONS: 1 }, async () => {
    reset();
    at._entryAtSet('SMH', ET_AT('2026-11-03', 15, 55));     // Tuesday's close-IBS buy
    const slow = world({ SMH: { reads: 8 } });
    await at.runAutoTrade({ signals: [] }, { bridge: slow.bridge, userId: 't', now: ET_AT('2026-11-04', 15, 50) });
    assert.strictEqual(slow.accepted('SMH').length, 1, 'Wednesday 15:50: sold on this scan');
    assert.strictEqual(slow.marketSells('SMH').length, 1, 'with no refused attempt before it');
    const ei = rows().filter((x) => x.event === 'exit_intent');
    assert.strictEqual(ei.length, 1);
    assert.match(ei[0].reason, /^max_hold/);
    assert.strictEqual(ei[0].status, 'submitted');
    assert.ok(!ei[0].kept_open);
    assert.strictEqual(rows().filter((x) => x.event === 'max_hold_clock_adopted').length, 0);
    const spent = at._exitSettleSpent();
    assert.ok(spent > 0);
    // The next scan starts with the whole budget again.
    at._entryAtSet('SOXL', ET_AT('2026-11-03', 15, 55));
    const next = world({ SOXL: { reads: 0 } });
    await at.runAutoTrade({ signals: [] }, { bridge: next.bridge, userId: 't', now: ET_AT('2026-11-04', 15, 51) });
    assert.strictEqual(next.accepted('SOXL').length, 1);
    assert.ok(at._exitSettleSpent() < spent, 'the spend was reset at the top of the scan');
  });
});

test('the switch is read from the environment only, off unless set — source pin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  assert.ok(src.includes('const v = Number(process.env.TRADER_EXIT_CANCEL_SETTLE_MS); return Number.isFinite(v) && v > 0 ? v : 0;'), 'unset, zero or junk = off');
  assert.ok(src.includes('_exitSettle.spent = 0;   // per scan'), 'the budget is reset every scan');
  assert.ok(src.includes('return settleMs > 0 ? { cancelled: canceled, settled, waitedMs: Date.now() - t0 } : { cancelled: canceled };'), 'the default return shape is unchanged');
});
