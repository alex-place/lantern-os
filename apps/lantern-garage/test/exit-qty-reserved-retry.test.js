'use strict';
/**
 * exit-qty-reserved-retry.test.js — an exit the broker refuses because the cancelled
 * protective stop still reserves the shares is RETRIED, and if it stays refused the
 * position keeps its clocks (2026-10-24, week-1 review).
 *
 * Alpaca, 2026-10-22 15:55:18: eod_decarry SOXS -> "insufficient qty available for order
 * (requested: 154, available: 0)"; the 3x position rode the night unintended.
 * 2026-10-23 15:50:35-40: max_hold SMH / SOXL / XLK -> the same refusal x3; the positions
 * left only at 15:59 through the weekend flat, and on any Mon-Thu the dropped hold clock
 * would have held them a whole extra session. Fifteen such refusals 10-02..10-23.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exitqty-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
// hermetic exits (#3459): pin the exit-authority switches so a real ticker's tape cannot decide this suite
process.env.TRADER_MOMENTUM_EXIT = '0'; process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0'; process.env.TRADER_EXIT_MIN_PWIN = '0'; process.env.TRADER_EOD_DECARRY = '0';
process.env.TRADER_EXIT_QTY_RETRIES = '3';
process.env.TRADER_EXIT_QTY_RETRY_MS = '5';   // the production default is 1000 ms
const at = require('../lib/auto-trader');

const REFUSAL = 'insufficient qty available for order (requested: 15, available: 0)';
const ET_AT = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).getTime();
const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { at._resetCooldowns(); if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG); };

// A broker with one resting protective stop on SMH. `refuse` = how many market sells it refuses with
// the reserved-shares error before accepting; Infinity = refuse them all. `otherError` = refuse every
// market sell with that text instead.
function world({ refuse = 0, otherError = null } = {}) {
  const placed = [], cancels = [];
  const stops = [{ orderId: 'STP1', symbol: 'SMH', side: 'SELL', orderType: 'stop', status: 'Submitted', qty: 15 }];
  const marketSells = () => placed.filter((o) => o.side === 'sell' && !/stop/i.test(o.type || ''));
  return {
    placed, cancels, marketSells,
    bridge: {
      getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
      getIBKRPositions: async () => [{ symbol: 'SMH', qty: 15, avg_entry_price: 522.56, current_price: 526.96, market_value: 7904.4, unrealized_pl: 66 }],
      getIBKROpenOrders: async () => stops.filter((s) => !/cancel/i.test(s.status)),
      getIBKRDayPnl: async () => 0,
      getIBKROrderStatus: async () => null,
      cancelIBKROrder: async (uid, id) => { cancels.push(id); const o = stops.find((x) => x.orderId === id); if (o) o.status = 'Cancelled'; return { status: 'cancelled', ok: true }; },
      placeIBKROrder: async (uid, o) => {
        placed.push(o);
        if (/stop/i.test(o.type || '')) return { status: 'submitted', order_id: 'S' + placed.length };   // re-protection stops pass
        const n = marketSells().length;
        if (otherError) return { status: 'error', reason: otherError };
        if (n <= refuse) return { status: 'error', reason: REFUSAL };
        return { status: 'submitted', order_id: 'X' + n };
      },
    },
  };
}
const HP = { avg_entry_price: 522.56, current_price: 526.96 };
const close = (w, reason = 'max_hold (1 sessions ≥ 1 — the lab\'s timeoutS, flat into the close)') =>
  at._closeLongForTest(w.bridge, 'u', 'SMH', 15, HP, reason, { skipped: [], executed: [] }, Date.now(), { extended: false, refPrice: 526.96 });

test('the refusal detector matches the broker text and nothing ambiguous', () => {
  assert.strictEqual(at._isQtyReservedReject({ status: 'error', reason: REFUSAL }), true);
  assert.strictEqual(at._isQtyReservedReject({ status: 'error', error: 'insufficient quantity available' }), true);
  assert.strictEqual(at._isQtyReservedReject({ status: 'error', reason: 'socket hang up' }), false, 'a timeout may hide a live order');
  assert.strictEqual(at._isQtyReservedReject({ status: 'error', reason: 'market is closed' }), false);
  assert.strictEqual(at._isQtyReservedReject({ status: 'submitted', order_id: 'X' }), false);
  assert.strictEqual(at._isQtyReservedReject(null), false);
});

test('one refusal, then the retry sells (the 10-22 SOXS de-carry would have left the book)', async () => {
  reset();
  const w = world({ refuse: 1 });
  at._entryAtSet('SMH', ET_AT('2026-10-22', 15, 50));
  const r = await close(w, 'eod_decarry (leveraged overnight gap risk #3298) — flat into the close');
  assert.strictEqual(w.marketSells().length, 2, 'refused once, retried once');
  assert.strictEqual(r.status, 'submitted');
  assert.ok(!r.keptOpen);
  const ei = rows().filter((x) => x.event === 'exit_intent');
  assert.strictEqual(ei.length, 1, 'one exit decision, one journal row');
  assert.strictEqual(ei[0].status, 'submitted');
  assert.strictEqual(ei[0].retries, 1, 'the retry is on the record');
  assert.strictEqual(at._entryAtGet('SMH'), undefined, 'a placed exit clears the position state as before');
  assert.ok(at._exitAtGet('SMH') > 0, 'and arms the re-attempt debounce as before');
});

test('refused through every retry: the position keeps its clocks and no cooldown is armed', async () => {
  reset();
  const w = world({ refuse: Infinity });
  const entered = ET_AT('2026-10-22', 15, 50);
  at._entryAtSet('SMH', entered);
  const r = await close(w);
  assert.strictEqual(w.marketSells().length, 4, 'the first attempt plus TRADER_EXIT_QTY_RETRIES=3');
  assert.ok(w.cancels.length >= 1, 'the stop is cancelled first (and re-checked before each retry)');
  assert.strictEqual(r.keptOpen, true);
  assert.strictEqual(at._entryAtGet('SMH'), entered, 'the entry time survives -- max-hold keeps counting from the real entry');
  assert.strictEqual(at._exitAtGet('SMH'), undefined, 'no exitReattemptMs debounce: no order rests, the next scan may retry at once');
  assert.match(String(at._exitStatusGet('SMH')), /error/, 'the failure still feeds the MAX_EXIT_FAILURES backoff');
  assert.ok(at._exitKeptOpen.has('SMH'), 'flagged for the same scan\'s entry loop');
  const ei = rows().filter((x) => x.event === 'exit_intent');
  assert.strictEqual(ei.length, 1);
  assert.strictEqual(ei[0].kept_open, true);
  assert.strictEqual(ei[0].retries, 3);
  assert.match(ei[0].error, /insufficient qty/);
});

test('any other error keeps the old path (an order may exist behind a timeout)', async () => {
  reset();
  const w = world({ otherError: 'socket hang up' });
  at._entryAtSet('SMH', ET_AT('2026-10-22', 15, 50));
  const r = await close(w);
  assert.strictEqual(w.marketSells().length, 1, 'no retry on an ambiguous error');
  assert.ok(!r.keptOpen);
  assert.strictEqual(at._entryAtGet('SMH'), undefined, 'state cleared as before');
  assert.ok(at._exitAtGet('SMH') > 0, 'debounce armed as before -- protects against selling twice');
  assert.ok(!at._exitKeptOpen.has('SMH'));
});

test('END TO END: a refused 15:50 max-hold sells on the 15:51 scan, not a session later', async () => {
  const prev = process.env.TRADER_MAX_HOLD_SESSIONS;
  process.env.TRADER_MAX_HOLD_SESSIONS = '1';
  try {
    reset();
    at._entryAtSet('SMH', ET_AT('2026-10-21', 15, 50));     // Wednesday's close-IBS buy
    const refusing = world({ refuse: Infinity });
    await at.runAutoTrade({ signals: [] }, { bridge: refusing.bridge, userId: 't', now: ET_AT('2026-10-22', 15, 50) });
    assert.strictEqual(refusing.marketSells().length, 4, 'Thursday 15:50: the max-hold sell is refused through every retry');
    const accepting = world({ refuse: 0 });
    await at.runAutoTrade({ signals: [] }, { bridge: accepting.bridge, userId: 't', now: ET_AT('2026-10-22', 15, 51) });
    assert.strictEqual(accepting.marketSells().length, 1, 'Thursday 15:51: the next scan sells -- no 8-minute debounce, no clock reset');
    assert.strictEqual(rows().filter((x) => x.event === 'max_hold_clock_adopted').length, 0,
      'the hold clock was never lost (before the fix it re-adopted at zero and held another session)');
    const ei = rows().filter((x) => x.event === 'exit_intent');
    assert.strictEqual(ei.length, 2);
    assert.strictEqual(ei[0].kept_open, true);
    assert.match(ei[1].reason, /^max_hold/);
    assert.strictEqual(ei[1].status, 'submitted');
  } finally {
    if (prev === undefined) delete process.env.TRADER_MAX_HOLD_SESSIONS; else process.env.TRADER_MAX_HOLD_SESSIONS = prev;
  }
});

test('the entry loop refuses a symbol whose exit was refused this scan, before the already-long check -- source pin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  const guard = src.indexOf("if (_exitKeptOpen.has(sym)) { out.skipped.push({ ...record, why: 'exit refused this scan");
  const alreadyLong = src.indexOf("why: 'already long' }); continue; }");
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(alreadyLong > guard, 'and runs before already-long, which reads the heldQty the exit path just deleted');
  assert.ok(src.indexOf('_exitKeptOpen.clear();   // per scan') > 0, 'the flag lives for one scan only');
});
