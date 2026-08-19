'use strict';

/**
 * feed-dropout-entry.test.js — an unexplained flat reading is not an entry.
 *
 * The `already long` guard trusts one position snapshot. On 2026-08-13 the
 * broker feed dropped SOXS for two scans and wrote no exit row of any kind:
 *
 *   11:13:23  held ["GLD","SOXS","SPXS","SQQQ"]   skip SOXS "already long"
 *   11:14:32  held ["GLD","SPXS","SQQQ"]          skip SOXS "falling_knife"  <- a CANDIDATE
 *   11:15:43  held ["GLD","SPXS","SQQQ"]          ENTRY SOXS 3057 @ 37.88 tier A+
 *   11:16:52  held ["GLD","SOXS","SPXS","SQQQ"]   back, as if nothing happened
 *
 * The position went to 3,057.8 shares — twice the intended maximum — behind a
 * stop sized for part of it. It happened to earn +$4,218 that day; a
 * double-size loss was equally available, and 77% of the session's profit
 * resting on a feed glitch is not a strategy.
 *
 * #3277 taught the EXIT side to distrust a suspect snapshot. This is the entry
 * side of the same lesson: a position leaving the book is normally EXPLAINED (a
 * fill, or a reconstructed external close). An absence with no exit on record is
 * the dropout signature.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropout-'));
const LOG = path.join(dir, 'trades.jsonl');
const STATE = path.join(dir, 'state.json');

process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';        // one bullish scan is enough to enter
delete process.env.TRADER_FLAT_CONFIRM_SEC;

const { runAutoTrade, _resetCooldowns, _saveState } = require('../lib/auto-trader');

const pos = (symbol, qty, price) => ({
  symbol, qty, avg_entry_price: price, current_price: price,
  market_value: qty * price, unrealized_pl: 0,
});

// A bullish SOXS signal that would otherwise enter.
const SIGNAL = {
  symbol: 'SOXS', direction: 'BULLISH', price: 37.88,
  convergence: { decision: 'ENTER', p_win: 0.62, size_mult: 1 },
  plan: { stop: 36.74, target1: 40.20, target2: 41.82, hold_days: 1 },
  volume_ratio: 1.7,
};

let book = [];
let placed = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, cash: 500000, mode: 'paper' }),
  getIBKRPositions: async () => book.map((p) => ({ ...p })),
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => ({ dayPnl: 0 }),
  cancelIBKROrder: async () => ({ status: 'cancelled' }),
  placeIBKROrder: async (o) => { placed.push(o); return { status: 'placed', order_id: 'test-' + placed.length }; },
};

const rows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : []);
const entriesFor = (sym) => rows().filter((r) => r.event === 'entry' && r.symbol === sym);
const skipsFor = (sym) => rows().filter((r) => r.event === 'skip' && r.symbol === sym);

function reset() {
  placed = [];
  _resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
}
const scan = () => runAutoTrade({ signals: [SIGNAL], spy_1d: 0.6 }, { bridge, userId: 't', now: Date.now() });

test('the 2026-08-13 sequence: a vanished-then-returned SOXS is NOT re-entered', async () => {
  reset();
  // 11:13 — held, and confirmed by the broker.
  book = [pos('SOXS', 1490, 38.92), pos('SPXS', 2467, 23.53), pos('SQQQ', 1614, 35.98)];
  await scan();
  assert.strictEqual(entriesFor('SOXS').length, 0, 'already long — nothing to do');

  // 11:14 and 11:15 — the feed drops SOXS. No exit row is written; it simply is
  // not in the snapshot. The rest of the book is still readable, so this is not
  // the empty-snapshot case #3277 already guards.
  book = [pos('SPXS', 2467, 23.53), pos('SQQQ', 1614, 35.98)];
  await scan();
  await scan();

  assert.strictEqual(entriesFor('SOXS').length, 0,
    'THE BUG: a full-size entry on top of 1,490 shares already held');
  const why = skipsFor('SOXS').map((s) => s.reason).join(' | ');
  assert.match(why, /feed dropout/, `expected the dropout veto, got: ${why}`);
});

test('after the feed recovers, the position is intact and still not doubled', async () => {
  // 11:16 — SOXS is back, exactly as it was.
  book = [pos('SOXS', 1490, 38.92), pos('SPXS', 2467, 23.53), pos('SQQQ', 1614, 35.98)];
  await scan();
  assert.strictEqual(entriesFor('SOXS').length, 0);
});

test('a RECONSTRUCTED exit does NOT clear the veto — an estimate cannot corroborate itself', async () => {
  // The subtle one, and the reason this fix nearly did not work. When a position
  // vanishes, the external-close sweep writes a reconstructed exit INFERRED FROM
  // THAT SAME ABSENCE. If such a row cleared the veto, the sweep would invent an
  // exit, the invention would license a fresh entry, and the position would
  // double exactly as it did live.
  reset();
  book = [pos('SOXS', 1490, 38.92), pos('SPXS', 2467, 23.53), pos('SQQQ', 1614, 35.98)];
  await scan();                                   // confirm the holding

  book = [pos('SPXS', 2467, 23.53), pos('SQQQ', 1614, 35.98)];   // vanishes
  await scan();

  const recon = rows().filter((r) => r.event === 'exit' && r.symbol === 'SOXS' && r.status === 'reconstructed');
  const why = skipsFor('SOXS').map((s) => s.reason).join(' | ');
  // Whether or not the sweep chose to write one this scan, the veto must hold.
  assert.strictEqual(entriesFor('SOXS').length, 0, `no entry (sweep wrote ${recon.length} reconstructed row(s))`);
  assert.match(why, /feed dropout/, `expected the veto to survive a reconstructed exit, got: ${why}`);
});

test('the veto EXPIRES — stale state can never bar a symbol forever', async () => {
  reset();
  book = [pos('SOXS', 1490, 38.92), pos('SPXS', 2467, 23.53)];
  await scan();                                   // confirm the holding

  book = [pos('SPXS', 2467, 23.53)];              // vanishes, unexplained
  process.env.TRADER_FLAT_CONFIRM_SEC = '0.001';  // 1ms window: already expired
  try {
    await scan();
    const why = skipsFor('SOXS').map((s) => s.reason).join(' | ');
    assert.doesNotMatch(why, /feed dropout/, 'past the window, the flat reading is accepted');
  } finally {
    delete process.env.TRADER_FLAT_CONFIRM_SEC;
  }
});

test('the veto survives a restart — a crash mid-dropout must not hand back a clean slate', async () => {
  reset();
  book = [pos('SOXS', 1490, 38.92), pos('SPXS', 2467, 23.53)];
  await scan();
  _saveState();
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.ok(st.lastConfirmedHold && st.lastConfirmedHold.SOXS,
    'the confirmed holding must be on disk, not only in memory');
});

test('a symbol we never held is unaffected — this must not block ordinary entries', async () => {
  reset();
  book = [pos('SPXS', 2467, 23.53)];              // SOXS never confirmed
  await scan();
  const why = skipsFor('SOXS').map((s) => s.reason).join(' | ');
  assert.doesNotMatch(why, /feed dropout/, 'no confirmed holding → no veto');
});
