'use strict';

/**
 * trader-convergence.test.js — the trader's Verify/Converge stage.
 *
 * Measured 2026-08-14 against data/convergence/records.jsonl (1,804 records):
 * the stock autopilot had written ZERO, and `verified: true` appeared on 0 of
 * 1,804 — the Verify stage had never once closed with a receipt. A trade is the
 * natural fix: its hypothesis names a price and a deadline, and its outcome
 * arrives with a broker fill, which is exactly the artifact the emitter's gate
 * demands before it will let `verified` stand.
 *
 * These tests drive the REAL emitter (no mocks) with the record store pointed
 * at a temp file, so the honesty gates in convergence-records.js are exercised
 * rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the emitter's store to a temp file.
//
// ORDER MATTERS. convergence-records.js does `const { appendJsonlQueued } =
// require("./file-queue")` at load time, so the binding is captured on first
// require and a later reassignment does nothing — patching after the fact let
// an earlier version of this file append real rows to the repo's own store.
// So: patch file-queue's export FIRST, and only then let anything that
// destructures it load.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convrec-'));
const STORE = path.join(TMP, 'records.jsonl');

const fq = require('../lib/file-queue');
const realAppend = fq.appendJsonlQueued;
// Every write from this suite goes to the temp store — the real one is never
// a candidate, so there is no path by which a test can pollute it.
fq.appendJsonlQueued = async (_file, obj, opts) => realAppend(STORE, obj, opts);

const tc = require('../lib/trader-convergence');   // loads convergence-records → patched fq

const readStore = () => (fs.existsSync(STORE)
  ? fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const clear = () => { if (fs.existsSync(STORE)) fs.unlinkSync(STORE); };

const ENTRY = {
  event: 'entry', symbol: 'SOXS', qty: 1490, entry: 38.92, tier: 'B',
  p_win: 0.5657, stop: 37.75, target1: 40.95, target2: 42.37,
  room_r: 1.25, vol_ratio: 0.85, spy_1d: 0.85,
};

test('an entry becomes a FALSIFIABLE claim — names a price and a deadline', async () => {
  clear();
  const r = await tc.recordEntryHypothesis(ENTRY);
  assert.ok(r && r.id, 'a record was emitted');
  assert.match(r.hypothesis, /SOXS long 1490 @ 38\.92/);
  assert.match(r.hypothesis, /reaches target1 40\.95/, 'the claim is refutable against a price');
  assert.match(r.hypothesis, /before its stop 37\.75/, 'and against a competing level');
  assert.strictEqual(r.verified, false, 'the market has not answered yet');
});

test('confidence is the engine\'s OWN p_win, so the record scores its own forecast', async () => {
  clear();
  const r = await tc.recordEntryHypothesis(ENTRY);
  assert.ok(Math.abs(r.confidence - 0.5657) < 1e-9);
});

test('the measured inputs are carried, so a good call is distinguishable from a lucky one', async () => {
  clear();
  const r = await tc.recordEntryHypothesis(ENTRY);
  for (const e of ['p_win:0.566', 'room_r:1.25', 'vol_ratio:0.85', 'spy_1d:0.85', 'tier:B']) {
    assert.ok(r.evidence_ids.includes(e), `evidence missing ${e}: ${JSON.stringify(r.evidence_ids)}`);
  }
});

test('a FILLED exit produces a verified record — the first receipts the store has held', async () => {
  clear();
  await tc.recordEntryHypothesis(ENTRY);
  const r = await tc.recordExitOutcome({
    event: 'exit', symbol: 'SOXS', qty: 1490, entry: 38.92, exit: 41.10,
    pnl: 3248.20, pnl_pct: 5.6, reason: 'peak_giveback (reached 103%)',
    order_id: '850570819', status: 'filled', source: 'fill',
  });
  assert.strictEqual(r.verified, true);
  assert.deepStrictEqual(r.verified_by, ['exec:850570819'], 'a broker fill is the artifact');
  assert.strictEqual(r.result.won, true);
  assert.strictEqual(r.result.target1_reached, true, '41.10 >= target1 40.95, linked from the open claim');
  assert.strictEqual(r.confidence, 1, 'an outcome is a fact, not a forecast');
});

test('an UNCONFIRMED exit is NOT verified — the emitter gate would downgrade it anyway', async () => {
  clear();
  await tc.recordEntryHypothesis(ENTRY);
  const r = await tc.recordExitOutcome({
    event: 'exit', symbol: 'SOXS', qty: 1490, entry: 38.92, exit: 39.50,
    pnl: 864.20, reason: 'signal_exit', status: 'placed',
  });
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.verified_by, []);
  assert.match(r.verification_notes, /fill unconfirmed/);
});

test('a loss is recorded as plainly as a win', async () => {
  clear();
  await tc.recordEntryHypothesis({ ...ENTRY, symbol: 'SQQQ', entry: 37.06, target1: 38.15, stop: 35.95 });
  const r = await tc.recordExitOutcome({
    event: 'exit', symbol: 'SQQQ', qty: 1566, entry: 37.06, exit: 35.99,
    pnl: -1674.06, reason: 'closed_externally (protective stop, manual close, or another engine)',
    order_id: 'x1', status: 'filled', source: 'fill',
  });
  assert.strictEqual(r.result.won, false);
  assert.strictEqual(r.result.target1_reached, false, 'the claim was refuted');
  assert.match(r.hypothesis, /LOST/);
  assert.strictEqual(r.verified, true, 'a losing fill is still a receipt');
});

test('a PARTIAL exit does not drop the open claim — later fills still grade against target1', async () => {
  clear();
  await tc.recordEntryHypothesis({ ...ENTRY, symbol: 'GLD', entry: 401.12, target1: 405.00, stop: 389.09 });
  const partial = { event: 'exit', symbol: 'GLD', entry: 401.12, exit: 406.00, pnl: 40, reason: 'signal_exit', order_id: 'a', status: 'filled', source: 'fill' };
  const first = await tc.recordExitOutcome({ ...partial, qty: 40 });
  const second = await tc.recordExitOutcome({ ...partial, qty: 26 });
  assert.strictEqual(first.result.target1_reached, true);
  assert.strictEqual(second.result.target1_reached, true,
    'GLD closed 66 shares over three fills on 2026-08-13 — the claim must survive the first');
});

test('an exit with no tracked claim still grades on its own row (restart-safe)', async () => {
  clear();
  const r = await tc.recordExitOutcome({
    event: 'exit', symbol: 'ZZZZ', qty: 5, entry: 10, exit: 12, pnl: 10,
    reason: 'signal_exit', order_id: 'q', status: 'filled', source: 'fill',
  });
  assert.strictEqual(r.result.won, true);
  assert.strictEqual(r.result.target1_reached, null, 'unknown target degrades to null, not to a guess');
  assert.strictEqual(r.verified, true);
});

test('a row without a symbol emits nothing rather than a thin record', async () => {
  clear();
  assert.strictEqual(await tc.recordEntryHypothesis({ event: 'entry' }), null);
  assert.strictEqual(await tc.recordExitOutcome({ event: 'exit' }), null);
  assert.strictEqual(readStore().length, 0);
});

test('an entry with no price emits nothing — an unfalsifiable claim is telemetry', async () => {
  clear();
  assert.strictEqual(await tc.recordEntryHypothesis({ event: 'entry', symbol: 'SPY' }), null);
});

test('records actually land in the store', async () => {
  clear();
  await tc.recordEntryHypothesis(ENTRY);
  await tc.recordExitOutcome({
    event: 'exit', symbol: 'SOXS', entry: 38.92, exit: 41.10, pnl: 3248.20,
    reason: 'peak_giveback', order_id: 'z9', status: 'filled', source: 'fill',
  });
  const rows = readStore();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].reasoner, 'stock-autopilot');
  assert.strictEqual(rows[1].verified, true);
});

test.after(() => {
  fq.appendJsonlQueued = realAppend;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) {}
});
