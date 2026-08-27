'use strict';
/**
 * trap-residuals.test.js — the two residual traps found by the post-SPXS sweep.
 *
 * 1. MAX-HOLD IMMUNITY: max_hold counts from entryAt, so a position with no recorded
 *    entry time was immune FOREVER. Live on the rule's first armed day: stable's state
 *    held TLT — entered by the engine at 12:10 that same day — with no persisted
 *    entryAt. The hold clock now ADOPTS at discovery: immunity decays, N sessions from
 *    first sight. Kept separate from _entryAt so an old position never looks freshly
 *    entered to the maturity gate or min-hold.
 *
 * 2. OPERATOR-VIEW STOP TRAP: the manual-sell cancel-first (#3468) resolves a facade
 *    for the REQUESTING uid. An admin in the operator view has no linked broker, the
 *    facade is null, the cancel silently no-ops — and the send then hits the OPERATOR
 *    book where the stop's share reservation still refuses it (the SPXS trap, one path
 *    deeper).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trapres-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MOMENTUM_EXIT = '0'; process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0'; process.env.TRADER_EXIT_MIN_PWIN = '0'; process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const ET_AT = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).getTime();
const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);
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

test('an untracked position ADOPTS a hold clock instead of staying immune', async () => {
  const prev = process.env.TRADER_MAX_HOLD_SESSIONS;
  process.env.TRADER_MAX_HOLD_SESSIONS = '5'; process.env.TRADER_MANAGE_EXITS = '1';
  try {
    const w = world();                                     // no _entryAtSet — untracked
    await run(w, ET_AT('2026-08-24', 15, 55));             // Monday, eod window
    assert.strictEqual(sells(w).length, 0, 'discovery must not sell');
    assert.ok(rows().some((r) => r.event === 'max_hold_clock_adopted' && r.symbol === 'LNG'),
      'adoption is journaled so the persistence gap stays visible');
    assert.ok(at._holdClockAt.has('LNG'), 'the clock is running');
    // five sessions after ADOPTION (Mon -> next Mon), still untracked -> flatten
    const w2 = { placed: [], bridge: w.bridge };
    w2.bridge.placeIBKROrder = async (u, o) => { w2.placed.push(o); return { status: 'placed', order_id: 'Y' }; };
    await run(w2, ET_AT('2026-08-31', 15, 55));
    assert.strictEqual(sells(w2).length, 1, 'immunity decays — mortal N sessions from discovery');
  } finally {
    if (prev === undefined) delete process.env.TRADER_MAX_HOLD_SESSIONS; else process.env.TRADER_MAX_HOLD_SESSIONS = prev;
  }
});

test('the adopted clock does NOT contaminate _entryAt — other rules see nothing', () => {
  assert.ok(!require('../lib/auto-trader')._holdClockAt.has('NEVER'), 'sanity');
  // the separation is structural: adoption writes _holdClockAt only. Pin it in source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  assert.ok(src.includes('_holdClockAt.set(sym, now)'), 'adoption writes the hold clock');
  assert.ok(!/max_hold_clock_adopted[\s\S]{0,300}_entryAt\.set/.test(src), 'and never _entryAt');
});

test('the adopted clock persists across a state save/load', () => {
  at._holdClockAt.set('PERSISTME', 1234567890);
  at._saveState();
  at._holdClockAt.delete('PERSISTME');
  at._loadState();
  assert.strictEqual(at._holdClockAt.get('PERSISTME'), 1234567890, 'a restart must not reset the clock to immune');
});

test('every close site clears the adopted clock — a recycle starts fresh', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  const dels = (src.match(/_holdClockAt\.delete\(sym\)/g) || []).length;
  assert.ok(dels >= 4, `expected the 4 _entryAt.delete sites to clear the hold clock too, found ${dels}`);
  assert.ok(/_entryAt\.clear\(\); _holdClockAt\.clear\(\);/.test(src), 'reset clears it');
});

test('a placed entry persists entryAt IMMEDIATELY — the TLT gap', () => {
  // TLT was entered by the engine at 12:10 and its entryAt was missing from the state
  // file hours later: the in-memory set was awaiting the next incidental _saveState.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  assert.match(src, /_entryAt\.set\(sym, now\); _saveState\(\);/,
    'entry placement must save state in the same breath');
});

test('the operator-view sell cancels the OPERATOR book stops before sending', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading', 'orders.js'), 'utf8');
  const block = src.indexOf('acting from the operator view');
  const cancel = src.indexOf('cancelRestingStops(_F2, OPERATOR_UID', block);
  const send = src.indexOf('placeIBKROrder(OPERATOR_UID, opReq)', block);
  assert.ok(block > 0 && cancel > block && send > cancel,
    'cancel-first must sit inside the operator block, BEFORE the operator send');
});
