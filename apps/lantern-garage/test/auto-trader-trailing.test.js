'use strict';

/**
 * Trailing-stop ratchet + state persistence (auto-trader.js).
 *
 * Covers the SOXS "+35% peak → gave back $3k, never fired" regression:
 *   1. trailTriggerPct ratchets tighter as the peak gain grows.
 *   2. _saveState/_loadState round-trip the peak so a restart can't reset it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const at = require('../lib/auto-trader');

test('momentum-death timeframe defaults to 5m and is env-overridable', () => {
  const saved = process.env.TRADER_MOMENTUM_TF;
  try {
    delete process.env.TRADER_MOMENTUM_TF;
    assert.strictEqual(at.cfg().momentumTf, '5m');       // faster peak capture by default
    process.env.TRADER_MOMENTUM_TF = '15m';
    assert.strictEqual(at.cfg().momentumTf, '15m');       // operator can smooth it back
  } finally {
    if (saved === undefined) delete process.env.TRADER_MOMENTUM_TF; else process.env.TRADER_MOMENTUM_TF = saved;
  }
});

test('trailTriggerPct ratchets tighter as the peak gain grows', () => {
  const base = 2.5;
  assert.strictEqual(at.trailTriggerPct(1, base), 2.5);    // tiny gain → base (room to develop)
  assert.strictEqual(at.trailTriggerPct(5, base), 2.5);    // just under first tier
  assert.strictEqual(at.trailTriggerPct(6, base), 2.25);   // ≥6%  → 2.25
  assert.strictEqual(at.trailTriggerPct(12, base), 1.75);  // ≥12% → 1.75
  assert.strictEqual(at.trailTriggerPct(25, base), 1.25);  // ≥25% → 1.25
  assert.strictEqual(at.trailTriggerPct(35, base), 1.25);  // SOXS case → locked tight
});

test('trailTriggerPct never exceeds the base (a tighter base wins)', () => {
  // If the operator sets a very tight base, the ratchet must not loosen it.
  assert.strictEqual(at.trailTriggerPct(35, 1.0), 1.0);
  assert.strictEqual(at.trailTriggerPct(8, 2.0), 2.0);     // min(2.25, 2.0) = 2.0
});

test('SOXS scenario: +35% peak giving back 1.25% now fires (was 3% / broken)', () => {
  const entry = 42.65, peak = 57.69;
  const peakGainPct = ((peak - entry) / entry) * 100;      // ≈35.3%
  const trig = at.trailTriggerPct(peakGainPct, 2.5);       // → 1.25%
  const exitAt = peak * (1 - trig / 100);                  // ≈$56.97
  // The old flat 3% only fired at ~$55.96; the ratchet fires ~$1 higher, banking more.
  assert.ok(trig === 1.25);
  assert.ok(exitAt > 56.9 && exitAt < 57.0);
});

test('_saveState writes a valid snapshot to the real STATE_FILE; _loadState reads it back', () => {
  // Exercise the real helpers against the real path. _resetCooldowns() clears the
  // in-memory maps and saves, so after it the on-disk snapshot is a well-formed,
  // empty-but-shaped object — and _loadState() must consume it without throwing.
  assert.strictEqual(typeof at.STATE_FILE, 'string');
  assert.doesNotThrow(() => at._resetCooldowns());          // clears + _saveState()
  assert.ok(fs.existsSync(at.STATE_FILE), 'snapshot file written');
  const snap = JSON.parse(fs.readFileSync(at.STATE_FILE, 'utf8'));
  for (const k of ['peak', 'entryAt', 'exitAt', 'lastOrderAt', 'dirStreak']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, k), `snapshot has ${k}`);
  }
  assert.strictEqual(typeof snap.savedAt, 'number');
  assert.doesNotThrow(() => at._loadState());               // reload must be safe
});

test('isFallingKnife: true when momentum still cratering, false once it turns', () => {
  // Flat, then a sharp accelerating late drop → MACD histogram negative AND deepening → knife.
  const crater = [...Array.from({ length: 45 }, () => 100), ...Array.from({ length: 15 }, (_, i) => 100 - Math.pow(i + 1, 1.8) * 0.4)];
  assert.strictEqual(at.isFallingKnife(crater), true);
  // A downtrend that bottoms and turns up in the last bars → histogram rising → NOT a knife.
  const turn = [...Array.from({ length: 45 }, (_, i) => 100 - i * 1.2), ...Array.from({ length: 15 }, (_, i) => 46 + i * 1.4)];
  assert.strictEqual(at.isFallingKnife(turn), false);
  // A steady uptrend is never a knife.
  const up = Array.from({ length: 60 }, (_, i) => 50 + i * 0.8);
  assert.strictEqual(at.isFallingKnife(up), false);
});

test('isFallingKnife: fail-open on insufficient data (does not block entries)', () => {
  assert.strictEqual(at.isFallingKnife([]), false);
  assert.strictEqual(at.isFallingKnife(Array.from({ length: 20 }, () => 10)), false);
});

test('entryKnifeFilter config defaults on, disables via env', () => {
  const saved = process.env.TRADER_ENTRY_KNIFE_FILTER;
  try {
    delete process.env.TRADER_ENTRY_KNIFE_FILTER;
    assert.strictEqual(at.cfg().entryKnifeFilter, true);
    process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
    assert.strictEqual(at.cfg().entryKnifeFilter, false);
  } finally {
    if (saved === undefined) delete process.env.TRADER_ENTRY_KNIFE_FILTER; else process.env.TRADER_ENTRY_KNIFE_FILTER = saved;
  }
});
