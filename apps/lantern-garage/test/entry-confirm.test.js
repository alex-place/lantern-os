'use strict';
/**
 * entry-confirm.test.js — TRADER_ENTRY_CONFIRM, the operator's reversal thesis in the
 * engine, behind a flag, DEFAULT OFF.
 *
 * "it needs an actual sign of the reversal — hitting a low and starting to go up.
 *  bumps happen and they usually look different: different candle size, repeating
 *  pattern, not low enough." (operator, 2026-08-27)
 *
 * Reconstruction evidence (60 sessions): T2 — two rising closes with no new low
 * between — halved winner MAE (-0.44% -> -0.22%) and earned baseline's return on a
 * quarter of the drawdown. The SAME harness also produced four findings the real
 * engine reversed, which is exactly why this ships off: the flag exists so the replay
 * harness and a live A/B can judge it at engine fidelity.
 *
 * The read is session-scoped ET: yesterday's closes cannot confirm today's washout,
 * and an unreadable window REFUSES rather than waves through (the
 * TRADER_EXIT_NEEDS_IBS principle applied at entry).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'econfirm-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

// a fixed mid-session instant: 2026-08-19 (Wed) 13:00 ET
const NOW = new Date('2026-08-19T13:00:00-04:00').getTime();
// build a session bar at h:mm ET with a given close/low
const bar = (h, m, close, low = close - 0.2) => ({
  timestamp: new Date(`2026-08-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).toISOString(),
  open: close, high: close + 0.2, low, close, volume: 1000,
});

test('the flag parses: off by default, 1 and 2 valid, garbage falls back to off', () => {
  const load = (v) => {
    const prev = process.env.TRADER_ENTRY_CONFIRM;
    if (v === undefined) delete process.env.TRADER_ENTRY_CONFIRM; else process.env.TRADER_ENTRY_CONFIRM = v;
    try { return at.cfg().entryConfirm; } finally {
      if (prev === undefined) delete process.env.TRADER_ENTRY_CONFIRM; else process.env.TRADER_ENTRY_CONFIRM = prev;
    }
  };
  assert.strictEqual(load(undefined), 0, 'DEFAULT OFF — this PR arms nothing');
  assert.strictEqual(load('1'), 1);
  assert.strictEqual(load('2'), 2);
  for (const bad of ['0', '3', '-1', 'abc', '']) assert.strictEqual(load(bad), 0, `ENTRY_CONFIRM=${bad}`);
});

test('T2 confirms: two rising closes, no new low between', () => {
  const bars = [bar(12, 45, 100.0), bar(12, 50, 100.2), bar(12, 55, 100.5)];
  const r = at._entryConfirmRead(bars, 2, NOW);
  assert.strictEqual(r.ok, true, r.why);
});

test('still falling: refused', () => {
  const bars = [bar(12, 45, 100.5), bar(12, 50, 100.2), bar(12, 55, 100.0)];
  const r = at._entryConfirmRead(bars, 2, NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /not rising/);
});

test("the operator's bump: a rising close that made a NEW LOW under it is refused", () => {
  // close ticks up but the bar undercut the prior low on the way — "bumps happen and
  // they usually look different ... not low enough"
  const bars = [bar(12, 45, 100.0, 99.9), bar(12, 50, 100.2, 100.0), bar(12, 55, 100.3, 99.5)];
  const r = at._entryConfirmRead(bars, 2, NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /NEW LOW/);
});

test('n=1 needs only one rising close and ignores the low rule', () => {
  const one = at._entryConfirmRead([bar(12, 50, 100.0), bar(12, 55, 100.1, 99.0)], 1, NOW);
  assert.strictEqual(one.ok, true, one.why);
  const flat = at._entryConfirmRead([bar(12, 50, 100.1), bar(12, 55, 100.1)], 1, NOW);
  assert.strictEqual(flat.ok, false, 'an EQUAL close is not a turn');
});

test("yesterday's bars cannot confirm today's washout", () => {
  const y = (h, m, c) => ({ ...bar(h, m, c), timestamp: new Date(`2026-08-18T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).toISOString() });
  // a perfect rising run — but all of it yesterday, plus only ONE session bar today
  const bars = [y(15, 45, 100.0), y(15, 50, 100.3), y(15, 55, 100.6), bar(12, 55, 101.0)];
  const r = at._entryConfirmRead(bars, 2, NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /session bar/, 'unreadable refuses — it does not wave through');
});

test('pre-market and after-hours bars are excluded from the read', () => {
  const pre = (h, m, c) => ({ ...bar(h, m, c), timestamp: new Date(`2026-08-19T0${h}:${String(m).padStart(2, '0')}:00-04:00`).toISOString() });
  // rising run entirely pre-market (08:xx) + one session bar: cannot confirm
  const bars = [pre(8, 45, 100.0), pre(8, 50, 100.3), pre(8, 55, 100.6), bar(9, 35, 101.0)];
  const r = at._entryConfirmRead(bars, 2, NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /session bar/);
});

test('the verdict carries the closes it judged, for the journal', () => {
  const r = at._entryConfirmRead([bar(12, 45, 100.0), bar(12, 50, 100.2), bar(12, 55, 100.5)], 2, NOW);
  assert.deepStrictEqual(r.closes, [100.0, 100.2, 100.5]);
});

test('empty or garbage bars refuse cleanly', () => {
  assert.strictEqual(at._entryConfirmRead([], 2, NOW).ok, false);
  assert.strictEqual(at._entryConfirmRead([{ timestamp: 'not-a-date', close: 0 }], 2, NOW).ok, false);
});
