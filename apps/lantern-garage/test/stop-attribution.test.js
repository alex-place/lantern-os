'use strict';

/**
 * stop-attribution.test.js — an external close that gave up its stop distance is labelled a stop-out.
 *
 * A stop-out that surfaces as an ABSENCE (the external-close sweep) is reconstructed from the last mark;
 * #3281 labels it `stop_attributed` when it gave up >= TRADER_STOP_ATTRIB_FRAC of its stop distance,
 * with the basis (`stop_dist_pct`) on the row. (The N-day cooldown and daily stop breaker this label
 * used to arm were removed 2026-11-17 — off on every box; history H29/H30/H97.)
 *
 * These tests drive the REAL runAutoTrade against a stub broker and assert on the journal rows.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-arm-'));
const LOG = path.join(dir, 'trades.jsonl');
const STATE = path.join(dir, 'state.json');

process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_STOP_MIN_PCT = '3';
delete process.env.TRADER_AUTO_EXECUTE;

const { runAutoTrade, _resetCooldowns, _loadState } = require('../lib/auto-trader');

// An ANCHOR position the broker still reports. Without it the snapshot is
// empty, and the #3277 trust guard correctly defers the whole sweep ("absent
// from a 0-row snapshot — treating as unreadable, not closed"): absence is only
// evidence of a close when the rest of the book is visible. So every scenario
// here keeps one position alive, which is also the realistic shape — one stop
// fires out of a book of several.
const ANCHOR = { symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 };
const bridge = {
  getIBKRAccount: async () => ({ equity: 1000000, mode: 'paper' }),
  getIBKRPositions: async () => [{ ...ANCHOR }],
  getIBKROpenOrders: async () => [],
};

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : []);

/** Fresh engine state with `lastPos` seeded (plus the anchor), then one scan. */
async function scanAfterVanish(lastPos, stopDistPct) {
  _resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { ...lastPos, ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() } },
    stopDistPct: stopDistPct || {},
  }));
  _loadState();
  // TWO scans since #3378: a reconstructed close books only on the second
  // consecutive absence (one flapped read booked three still-held positions as
  // exits on 2026-08-19).
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });
}

test('the exact SQQQ case is attributed — a 2.88% loss against a 3% stop', async () => {
  await scanAfterVanish(
    { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
    { SQQQ: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.ok(exit, 'the vanished position still produces its exit row');
  assert.strictEqual(exit.symbol, 'SQQQ');
  assert.strictEqual(exit.stop_attributed, true, 'gave up 96% of its stop distance');
  assert.strictEqual(exit.stop_dist_pct, 3, 'the basis of the call is on the row, auditable');
});

test('a SMALL external loss is not a stop-out', async () => {
  await scanAfterVanish(
    { GLD: { qty: 100, entry: 400, mark: 398, ts: Date.now() } },   // -0.5% vs a 3% stop
    { GLD: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.strictEqual(exit.stop_attributed, false, 'a manual close or small exit is not a stop');
});

test('a PROFITABLE external close is never attributed', async () => {
  await scanAfterVanish(
    { SOXS: { qty: 100, entry: 38, mark: 41, ts: Date.now() } },
    { SOXS: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.ok(exit.pnl > 0);
  assert.strictEqual(exit.stop_attributed, false);
});

test('just inside the threshold is attributed; just outside is not', async () => {
  // 3% stop, 0.9 fraction -> the line sits at -2.70%
  await scanAfterVanish({ X: { qty: 10, entry: 100, mark: 97.2, ts: Date.now() } }, { X: 3 });
  assert.strictEqual(readRows().find((r) => r.event === 'exit').stop_attributed, true, '-2.80% is past -2.70%');

  await scanAfterVanish({ X: { qty: 10, entry: 100, mark: 97.5, ts: Date.now() } }, { X: 3 });
  assert.strictEqual(readRows().find((r) => r.event === 'exit').stop_attributed, false, '-2.50% is not');
});

test('the per-symbol stop distance is used, not a global assumption', async () => {
  // A 10%-stop position losing 4% is NOT at its stop, even though 4% would be
  // past a 3% one.
  await scanAfterVanish({ TQQQ: { qty: 10, entry: 100, mark: 96, ts: Date.now() } }, { TQQQ: 10 });
  assert.strictEqual(readRows().find((r) => r.event === 'exit').stop_attributed, false,
    '-4% against a 10% stop is nowhere near it');
});

test('TRADER_STOP_ATTRIB_FRAC=0 disables attribution — it must not attribute EVERYTHING', async () => {
  // The trap this pins: `loss <= -(stopPct * 0)` is `loss <= 0`, so a naive
  // reading of 0 turns every losing external close into a stop-out. 0 must
  // mean OFF, restoring pre-#3281 behaviour.
  process.env.TRADER_STOP_ATTRIB_FRAC = '0';
  try {
    await scanAfterVanish(
      { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
      { SQQQ: 3 },
    );
    assert.strictEqual(readRows().find((r) => r.event === 'exit').stop_attributed, false);
  } finally {
    delete process.env.TRADER_STOP_ATTRIB_FRAC;
  }
});

test('a negative or garbage frac falls back to the default rather than misbehaving', async () => {
  for (const bad of ['-1', 'abc', '']) {
    process.env.TRADER_STOP_ATTRIB_FRAC = bad;
    try {
      await scanAfterVanish(
        { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
        { SQQQ: 3 },
      );
      const attributed = readRows().find((r) => r.event === 'exit').stop_attributed;
      // '-1' is finite and <= 0 -> OFF; 'abc'/'' are not finite -> default 0.9 -> ON.
      assert.strictEqual(attributed, bad === '-1' ? false : true, `frac=${JSON.stringify(bad)}`);
    } finally {
      delete process.env.TRADER_STOP_ATTRIB_FRAC;
    }
  }
});
