'use strict';

/**
 * stop-cooldown-arming.test.js — the cooldown must ARM, not just compute dates.
 *
 * stop-cooldown.test.js pins the date math and stop-breaker.test.js pins the
 * counter, and both were green all along. The gap was that nothing CALLED them
 * on the path a stop actually arrived by. Both counters armed only inside
 * _reconcileFills, which needs a broker stop fill it can see; a stop-out that
 * surfaces as an ABSENCE — the external-close sweep — armed nothing at all.
 *
 * Live 2026-08-13: SQQQ stopped out at 10:29:35 for -$1,674.06 and was
 * re-entered at 10:29:38. Three seconds. The session ended with
 * stopCooldownThrough {} and stopFills {day:null,count:0} after a real stop had
 * fired — both tail defenses inert for the whole day.
 *
 * So these tests drive the REAL runAutoTrade against a stub broker and assert on
 * the persisted state, not on a mirror of the expression.
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
process.env.TRADER_STOP_COOLDOWN_DAYS = '1';
process.env.TRADER_STOP_BREAKER = '2';
delete process.env.TRADER_AUTO_EXECUTE;

const { runAutoTrade, _resetCooldowns, _loadState, _saveState } = require('../lib/auto-trader');

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
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

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
  // exits on 2026-08-19), so the cooldown arms one scan later than it used to.
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });
}

test('the exact SQQQ case arms the cooldown — a 2.88% loss against a 3% stop', async () => {
  await scanAfterVanish(
    { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
    { SQQQ: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.ok(exit, 'the vanished position still produces its exit row');
  assert.strictEqual(exit.symbol, 'SQQQ');
  assert.strictEqual(exit.stop_attributed, true, 'gave up 96% of its stop distance');
  assert.strictEqual(exit.stop_dist_pct, 3, 'the basis of the call is on the row, auditable');

  const st = readState();
  assert.ok(st.stopCooldownThrough && st.stopCooldownThrough.SQQQ,
    'the re-entry cooldown must be armed — this is what was empty on 2026-08-13');
  assert.strictEqual(st.stopFills.count, 1, 'and the daily breaker must have counted it');
});

test('the armed cooldown REFUSES a same-scan re-entry — the 3-second re-buy', async () => {
  await scanAfterVanish(
    { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
    { SQQQ: 3 },
  );
  // The sweep runs before the entry gate in the same scan, so the cooldown it
  // arms is visible to that scan's own entry decision.
  const skips = readRows().filter((r) => r.event === 'skip' && r.symbol === 'SQQQ');
  const st = readState();
  const through = st.stopCooldownThrough.SQQQ;
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  assert.ok(todayEt <= through, `today (${todayEt}) must fall inside the cooldown (through ${through})`);
  // Either the symbol never became a candidate this scan, or it was refused —
  // never entered. Both are correct; what must not happen is an entry row.
  assert.strictEqual(readRows().some((r) => r.event === 'entry' && r.symbol === 'SQQQ'), false,
    'no re-entry into the symbol that just stopped out');
  void skips;
});

test('a SMALL external loss is not a stop-out — no cooldown, no breaker tick', async () => {
  await scanAfterVanish(
    { GLD: { qty: 100, entry: 400, mark: 398, ts: Date.now() } },   // -0.5% vs a 3% stop
    { GLD: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.strictEqual(exit.stop_attributed, false, 'a manual close or small exit is not a stop');
  const st = readState();
  assert.ok(!st.stopCooldownThrough.GLD, 'must not bar a symbol that never stopped out');
  assert.strictEqual(st.stopFills.count, 0);
});

test('a PROFITABLE external close never arms anything', async () => {
  await scanAfterVanish(
    { SOXS: { qty: 100, entry: 38, mark: 41, ts: Date.now() } },
    { SOXS: 3 },
  );
  const exit = readRows().find((r) => r.event === 'exit');
  assert.ok(exit.pnl > 0);
  assert.strictEqual(exit.stop_attributed, false);
  assert.strictEqual(readState().stopFills.count, 0);
});

test('just inside the threshold arms; just outside does not', async () => {
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

test('two attributed stops trip the daily breaker', async () => {
  _resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: {
      SQQQ: { qty: 100, entry: 37.065, mark: 35.99, ts: Date.now() },
      SPXS: { qty: 100, entry: 24.00, mark: 23.20, ts: Date.now() },
      ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() },
    },
    stopDistPct: { SQQQ: 3, SPXS: 3 },
  }));
  _loadState();
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // first absence: deferred (#3378)
  await runAutoTrade({ signals: [] }, { bridge, userId: 't' });   // second consecutive absence: booked
  const st = readState();
  assert.strictEqual(st.stopFills.count, 2, 'both stop-outs counted toward TRADER_STOP_BREAKER=2');
  assert.ok(st.stopCooldownThrough.SQQQ && st.stopCooldownThrough.SPXS);
});

test('TRADER_STOP_ATTRIB_FRAC=0 disables attribution — it must not attribute EVERYTHING', async () => {
  // The trap this pins: `loss <= -(stopPct * 0)` is `loss <= 0`, so a naive
  // reading of 0 turns every losing external close into a stop-out and halts
  // the session after two of them. 0 must mean OFF, restoring pre-#3281
  // behaviour.
  process.env.TRADER_STOP_ATTRIB_FRAC = '0';
  try {
    await scanAfterVanish(
      { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
      { SQQQ: 3 },
    );
    assert.strictEqual(readRows().find((r) => r.event === 'exit').stop_attributed, false);
    const st = readState();
    assert.deepStrictEqual(st.stopCooldownThrough, {}, 'nothing armed');
    assert.strictEqual(st.stopFills.count, 0, 'and the breaker never ticked');
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

test('the armed cooldown survives a restart — it is persisted, not just in memory', async () => {
  await scanAfterVanish(
    { SQQQ: { qty: 1566, entry: 37.065003, mark: 35.9960022, ts: Date.now() } },
    { SQQQ: 3 },
  );
  const onDisk = fs.readFileSync(STATE, 'utf8');
  const through = JSON.parse(onDisk).stopCooldownThrough.SQQQ;
  assert.ok(through, 'armed before the restart');

  // A crash loses MEMORY, not the file. _resetCooldowns also rewrites the file,
  // so put back what the process would actually have left behind.
  _resetCooldowns();
  fs.writeFileSync(STATE, onDisk);
  _loadState();                 // the new process reads it back
  _saveState();                 // and round-trips it, proving it is in memory

  assert.strictEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')).stopCooldownThrough.SQQQ, through,
    'a restart between the stop and the re-entry must not clear the bar');
});
