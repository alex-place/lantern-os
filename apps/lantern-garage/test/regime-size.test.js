'use strict';

/**
 * Regime-sizing first-30m read (_regimeFirst30Read, auto-trader.js).
 *
 * The dial itself was measured on the 60-session armed-parity replay with
 * IDENTICAL trade lists (size-only isolation); these tests pin the pure read:
 *   1. r30 is the last first-30m close's position within the first-30m range.
 *   2. Fewer than 3 first-30m bars -> null (no read, mult stays 1).
 *   3. A flat range -> null; bars from other days are excluded.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same redirect as auto-trader-trailing.test.js: resolve journal/state paths
// to a temp dir BEFORE the module loads, so tests never touch a live ledger.
const _tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-size-test-'));
process.env.TRADER_TRADES_LOG = path.join(_tmp, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(_tmp, 'state.json');

const at = require('../lib/auto-trader');

// 2026-09-04 is an ET trading day; 13:30 UTC = 09:30 ET (EDT).
const bar = (hhmmUtc, high, low, close) => ({ timestamp: `2026-09-04T${hhmmUtc}:00.000Z`, high, low, close });

test('r30 = last first-30m close position within the first-30m range', () => {
  const bars = [
    bar('13:30', 100, 98, 99),
    bar('13:40', 99.5, 97, 97.5),
    bar('13:55', 98, 96, 96.3),     // range 96..100, close 96.3 -> r30 = 0.075
    bar('14:05', 99, 96.5, 98.8),   // outside the first 30m — ignored
  ];
  const r30 = at._regimeFirst30Read(bars, '2026-09-04');
  assert.ok(Math.abs(r30 - 0.075) < 1e-9, `expected 0.075, got ${r30}`);
});

test('fewer than 3 first-30m bars reads null (mult stays 1)', () => {
  const bars = [bar('13:30', 100, 98, 99), bar('13:45', 99, 97, 97.5)];
  assert.strictEqual(at._regimeFirst30Read(bars, '2026-09-04'), null);
});

test('flat range reads null; other days\' bars are excluded', () => {
  const flat = [bar('13:30', 100, 100, 100), bar('13:40', 100, 100, 100), bar('13:50', 100, 100, 100)];
  assert.strictEqual(at._regimeFirst30Read(flat, '2026-09-04'), null);
  const wrongDay = [
    { timestamp: '2026-09-03T13:30:00.000Z', high: 100, low: 98, close: 98.1 },
    { timestamp: '2026-09-03T13:40:00.000Z', high: 99, low: 97, close: 97.2 },
    { timestamp: '2026-09-03T13:50:00.000Z', high: 98, low: 96, close: 96.1 },
  ];
  assert.strictEqual(at._regimeFirst30Read(wrongDay, '2026-09-04'), null);
});
