'use strict';
/**
 * stress-mult.test.js — TRADER_STRESS_MULT (#3428 gates/caps lab; Nagel 2012).
 * Size UP when the tape is stressed: prior VIX close >= TRADER_STRESS_VIX or
 * SPY session IBS <= TRADER_STRESS_SPY_IBS. Pure helper + the sizing path.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
delete process.env.TRADER_STRESS_MULT;
delete process.env.TRADER_STRESS_VIX;
delete process.env.TRADER_STRESS_SPY_IBS;
const at = require('../lib/auto-trader');

test('OFF by default: no multiplier whatever the tape does', () => {
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 40, spyIbs: 0.05 }), { mult: 1, why: null });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 40, spyIbs: 0.05 }, { mult: 1, vix: 20, spyIbsLvl: 0.3 }), { mult: 1, why: null });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 40 }, { mult: 0.5, vix: 20, spyIbsLvl: 0.3 }), { mult: 1, why: null }, 'a multiplier <= 1 is off');
});

test('VIX condition: prior close at/above the threshold arms it; below does not', () => {
  const cfg = { mult: 1.5, vix: 20, spyIbsLvl: 0.3 };
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 20, spyIbs: 0.9 }, cfg), { mult: 1.5, why: 'VIX 20.0 >= 20' });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 19.9, spyIbs: 0.9 }, cfg), { mult: 1, why: null });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: null, spyIbs: 0.9 }, cfg), { mult: 1, why: null }, 'no VIX reading = condition unmet, never an error');
});

test('SPY session IBS condition, and both at once (OR, one multiplier, both reasons)', () => {
  const cfg = { mult: 2, vix: 20, spyIbsLvl: 0.3 };
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 12, spyIbs: 0.3 }, cfg), { mult: 2, why: 'SPY IBS 0.30 <= 0.3' });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 12, spyIbs: 0.31 }, cfg), { mult: 1, why: null });
  assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 25, spyIbs: 0.1 }, cfg), { mult: 2, why: 'VIX 25.0 >= 20 & SPY IBS 0.10 <= 0.3' });
});

test('env parsing: multiplier clamped to 2.5, thresholds default 20 / 0.3, a condition can be disabled with 0', () => {
  process.env.TRADER_STRESS_MULT = '9';
  try {
    assert.deepStrictEqual(at._stressCfg(), { mult: 2.5, vix: 20, spyIbsLvl: 0.3 });
    process.env.TRADER_STRESS_VIX = '0';
    assert.deepStrictEqual(at._stressMultiplier({ vixPrior: 80, spyIbs: 0.9 }, at._stressCfg()), { mult: 1, why: null }, 'VIX leg disabled');
  } finally { delete process.env.TRADER_STRESS_MULT; delete process.env.TRADER_STRESS_VIX; }
});

test('the sizing path: scaling cap AND risk together is what moves the size (the cap alone binds)', () => {
  const base = at.sizePosition({ equity: 1000000, price: 100, positionPct: 12, maxPositionPct: 12, riskPct: 0.36, stopDistPct: 3 });
  const stressed = at.sizePosition({ equity: 1000000, price: 100, positionPct: 12, maxPositionPct: 12 * 1.5, riskPct: 0.36 * 1.5, stopDistPct: 3 });
  const capOnly = at.sizePosition({ equity: 1000000, price: 100, positionPct: 12, maxPositionPct: 12 * 1.5, riskPct: 0.36, stopDistPct: 3 });
  assert.strictEqual(base, 1200, '12% of $1M at $100');
  assert.strictEqual(stressed, 1800, '18% when both scale');
  assert.strictEqual(capOnly, 1200, 'raising the cap alone changes nothing — the risk target binds');
});
