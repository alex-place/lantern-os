'use strict';
// short-edge-selective.test.js — TRADER_SHORT_EDGE=selective: allow the wrapper
// IBS entry only under the three measured selection features (#3349):
//   after 11:00 ET, wrapper drawdown > -1.5%, underlying tape < +0.5%.
// Composite n=13, 62% WR, +1.70% avg (+0.60% leave-one-day-out) vs 47%/-0.36%
// for the fires that fail it. Every fire is logged with all three values.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyPolarity, sessionDrawdownPct, barEtMinute } = require('../lib/signal-engine/scan');

const good = { spy: { tape: 0.1, mom30: 0.02, ll: false }, wrapperDD: -0.6, underlyingTape: 0.2, etMin: 720 };
const P = (o) => applyPolarity('SOXS', 'BULLISH', { shortEdge: 'selective', ...good, ...o });

test('the composite: late + shallow + mild → ALLOWED, with all three values narrated', () => {
  const r = P({});
  assert.strictEqual(r.direction, 'BULLISH');
  assert.strictEqual(r.veto, null);
  assert.match(r.allowed, /selective/);
  assert.match(r.allowed, /et 12:00/);
  assert.match(r.allowed, /wrapperDD -0\.60%/);
  assert.match(r.allowed, /underlying tape 0\.20%/);
});

test('too EARLY (10:30) → vetoed, names the reason and the measured stat', () => {
  const r = P({ etMin: 630 });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /before 11:00/);
  assert.match(r.veto, /47%/);
});

test('wrapper already fell HARD (-2.1%) → vetoed', () => {
  const r = P({ wrapperDD: -2.1 });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /wrapper already fell -2\.10%/);
});

test('underlying RIPPING (+0.8%) → vetoed', () => {
  const r = P({ underlyingTape: 0.8 });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /underlying ripping 0\.80%/);
});

test('multiple failures are ALL narrated — the ledger learns every reason', () => {
  const r = P({ etMin: 620, wrapperDD: -3, underlyingTape: 1.2 });
  assert.match(r.veto, /before 11:00/);
  assert.match(r.veto, /wrapper already fell/);
  assert.match(r.veto, /underlying ripping/);
});

test('boundaries: 11:00 exactly passes; -1.5% exactly FAILS (<=); +0.5% exactly FAILS (>=)', () => {
  assert.strictEqual(P({ etMin: 660 }).direction, 'BULLISH');
  assert.strictEqual(P({ etMin: 659 }).direction, 'NEUTRAL');
  assert.strictEqual(P({ wrapperDD: -1.5 }).direction, 'NEUTRAL');
  assert.strictEqual(P({ wrapperDD: -1.49 }).direction, 'BULLISH');
  assert.strictEqual(P({ underlyingTape: 0.5 }).direction, 'NEUTRAL');
  assert.strictEqual(P({ underlyingTape: 0.49 }).direction, 'BULLISH');
});

test('unreadable inputs → refuse, never certify blind', () => {
  for (const o of [{ etMin: null }, { wrapperDD: null }, { underlyingTape: null }]) {
    const r = P(o);
    assert.strictEqual(r.direction, 'NEUTRAL');
    assert.match(r.veto, /selection inputs unreadable/);
  }
});

test('the 2026-08-17 winners: SQQQ 11:15 (late, shallow, mild) passes; SOXS 10:30 fails on time only', () => {
  // SQQQ fired 11:15, wrapper +0.4% from open (shallow), QQQ +0.08% (mild) → +1.80% that day
  assert.strictEqual(P({ etMin: 675, wrapperDD: 0.4, underlyingTape: 0.08 }).direction, 'BULLISH');
  // SOXS fired 10:30 — everything else fine → time veto (the +2.90% we would still miss; honest)
  const r = P({ etMin: 630, wrapperDD: -0.3, underlyingTape: 0.1 });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /before 11:00/);
});

test('mode is dispatched by env when opts.shortEdge is absent', () => {
  process.env.TRADER_SHORT_EDGE = 'selective';
  try {
    const r = applyPolarity('SQQQ', 'BULLISH', good);
    assert.strictEqual(r.direction, 'BULLISH');
  } finally { delete process.env.TRADER_SHORT_EDGE; }
});

test('1x and BEARISH/NEUTRAL untouched under selective', () => {
  assert.strictEqual(applyPolarity('SPY', 'BULLISH', { shortEdge: 'selective' }).direction, 'BULLISH');
  assert.strictEqual(applyPolarity('SOXS', 'BEARISH', { shortEdge: 'selective' }).direction, 'BEARISH');
  assert.strictEqual(applyPolarity('SOXS', 'NEUTRAL', { shortEdge: 'selective' }).direction, 'NEUTRAL');
});

test('helpers: sessionDrawdownPct and barEtMinute read the LAST bar\'s session/time', () => {
  const bars = [
    { timestamp: '2026-08-17T13:30:00.000Z', open: 40.00, close: 40.10, high: 40.2, low: 39.9 },   // 09:30 ET
    { timestamp: '2026-08-17T15:15:00.000Z', open: 40.05, close: 39.70, high: 40.1, low: 39.6 },   // 11:15 ET
  ];
  assert.ok(Math.abs(sessionDrawdownPct(bars) - (-0.75)) < 0.01, `(39.70-40.00)/40.00 = -0.75%, got ${sessionDrawdownPct(bars)}`);
  assert.strictEqual(barEtMinute(bars), 675);
  assert.strictEqual(sessionDrawdownPct([]), null);
  assert.strictEqual(barEtMinute([]), null);
});
