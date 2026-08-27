'use strict';
/**
 * max-hold.test.js — TRADER_MAX_HOLD_SESSIONS: the lab's timeoutS, finally in the engine.
 *
 * Every armed number came from a lab config (armed_baseline MONDAY) that includes
 * timeoutS: 5 — "exit at the close of the 5th session." The engine never implemented
 * it, and the gap produced a live victim: SPXS on race held 3 sessions with ZERO exit
 * attempts — perma-BULLISH reads meant the bounce was never evaluated, peak +0.64%
 * never armed the +1% floor, −1.9% never hit the −3% stop. The DEAD ZONE.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maxhold-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
// hermetic exits (#3459): pin the five switches so a real ticker's tape can't decide this suite
process.env.TRADER_MOMENTUM_EXIT = '0'; process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0'; process.env.TRADER_EXIT_MIN_PWIN = '0'; process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const ET_AT = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).getTime();

test('sessions are counted in trading days, ET, entry day = 0', () => {
  const mon = ET_AT('2026-08-24', 10, 0);
  assert.strictEqual(at._sessionsHeld(mon, ET_AT('2026-08-24', 15, 50)), 0, 'same day');
  assert.strictEqual(at._sessionsHeld(mon, ET_AT('2026-08-25', 15, 50)), 1, 'Mon -> Tue');
  assert.strictEqual(at._sessionsHeld(mon, ET_AT('2026-08-27', 15, 50)), 3, 'Mon -> Thu = the SPXS case');
  assert.strictEqual(at._sessionsHeld(mon, ET_AT('2026-08-31', 15, 50)), 5, 'Mon -> next Mon, weekend skipped = the lab timeout');
  assert.strictEqual(at._sessionsHeld(ET_AT('2026-08-21', 10, 0), ET_AT('2026-08-24', 15, 50)), 1, 'Fri -> Mon = 1 session, not 3 days');
});

test('the rule fires only in the eod window of the Nth session', async () => {
  const world = () => {
    at._resetCooldowns();
    if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG);
    const placed = [];
    return { placed, bridge: {
      getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
      getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: 99, market_value: 9900, unrealized_pl: -100 }],
      getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0, getIBKROrderStatus: async () => null,
      cancelIBKROrder: async () => ({ status: 'cancelled' }),
      placeIBKROrder: async (u, o) => { placed.push(o); return { status: 'placed', order_id: 'X' + placed.length }; },
    } };
  };
  const sells = (w) => w.placed.filter((o) => o.side === 'sell' && !/stop/i.test(o.type || ''));
  const run = (w, nowMs) => at.runAutoTrade({ signals: [] }, { bridge: w.bridge, userId: 't', now: nowMs });
  const prev = process.env.TRADER_MAX_HOLD_SESSIONS;
  process.env.TRADER_MAX_HOLD_SESSIONS = '5'; process.env.TRADER_MANAGE_EXITS = '1';
  try {
    // held 5 sessions, 15:55 ET -> flatten
    let w = world(); at._entryAtSet('LNG', ET_AT('2026-08-24', 10, 0));
    await run(w, ET_AT('2026-08-31', 15, 55));
    assert.strictEqual(sells(w).length, 1, 'the 5th-session close flattens');
    // held 5 sessions but MID-day -> hold (the lab exits at the close, not intraday)
    w = world(); at._entryAtSet('LNG', ET_AT('2026-08-24', 10, 0));
    await run(w, ET_AT('2026-08-31', 12, 0));
    assert.strictEqual(sells(w).length, 0, 'midday never fires');
    // held only 3 sessions at the close -> hold
    w = world(); at._entryAtSet('LNG', ET_AT('2026-08-24', 10, 0));
    await run(w, ET_AT('2026-08-27', 15, 55));
    assert.strictEqual(sells(w).length, 0, 'before the Nth session nothing happens');
    // NO recorded entry time (state lost) -> hold, never liquidate blind
    w = world(); at._resetCooldowns();
    await run(w, ET_AT('2026-08-31', 15, 55));
    assert.strictEqual(sells(w).length, 0, 'a position with no entryAt is held, not sold');
  } finally {
    if (prev === undefined) delete process.env.TRADER_MAX_HOLD_SESSIONS; else process.env.TRADER_MAX_HOLD_SESSIONS = prev;
  }
});

test('DEFAULT OFF — unset means the rule does not exist', async () => {
  delete process.env.TRADER_MAX_HOLD_SESSIONS;
  assert.strictEqual(at.cfg().maxHoldSessions, 0);
});

test('the manual sell route cancels resting stops first — source pin', () => {
  // the defect that trapped the operator twice (08-20 champion flatten, 08-27 SPXS):
  // the broker reserves shares against the working stop, so the flatten is refused.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading', 'orders.js'), 'utf8');
  assert.match(src, /cancelRestingStops\(F, uid/, 'the route must cancel-first via the facade');
  const cancelAt = src.indexOf('cancelRestingStops(F, uid');
  const sendAt = src.indexOf('const attempts = alpacaFirst');
  assert.ok(cancelAt > 0 && sendAt > cancelAt, 'and it must happen BEFORE the order is sent');
});
