'use strict';

/**
 * overnight-trader.js — pure gate math for the measured sleeve book, plus the
 * Champion gross/financing accounting (sigma-trader.js). Gates must match the
 * backtests they were lifted from (oracle ledger: downtrend-decomposition-*).
 */

const test = require('node:test');
const assert = require('node:assert');

const ot = require('../lib/overnight-trader');
const sigma = require('../lib/sigma-trader');

// Synthetic daily-close builders (length > 70 for the gates' warmup).
function uptrendHighVol() {
  const c = []; let px = 100;
  for (let i = 0; i < 65; i++) { px *= 1 + 0.002 + (i % 2 ? 0.0005 : -0.0005); c.push(px); }   // calm climb
  for (let i = 0; i < 12; i++) { px *= 1 + 0.004 + (i % 2 ? 0.012 : -0.008); c.push(px); }     // vol expands, still up
  return c;
}
function uptrendCalm() {
  const c = []; let px = 100;
  for (let i = 0; i < 40; i++) { px *= 1 + 0.001 + (i % 2 ? 0.006 : -0.004); c.push(px); }     // choppier past
  for (let i = 0; i < 40; i++) { px *= 1.0015; c.push(px); }                                    // recent calm climb
  return c;
}
function downtrendAtLow() {
  const c = []; let px = 100;
  for (let i = 0; i < 80; i++) { px *= 1 - 0.004 + (i % 3 ? 0.001 : -0.002); c.push(px); }
  c.push(Math.min(...c.slice(-20)) * 0.995);                                                    // close AT the 20d low
  return c;
}
function downtrendRallyDay() {
  const c = downtrendAtLow();
  c.push(c[c.length - 1] * 1.015);                                                             // +1.5% bear-rally day
  return c;
}

test('uptrendGate: high-vol uptrend passes notflat and fails flat', () => {
  const c = uptrendHighVol();
  assert.strictEqual(ot.uptrendGate(c, 'notflat').pass, true);
  assert.strictEqual(ot.uptrendGate(c, 'flat').pass, false);
});

test('uptrendGate: calm uptrend passes flat (QQQ regime) and fails notflat', () => {
  const c = uptrendCalm();
  assert.strictEqual(ot.uptrendGate(c, 'flat').pass, true);
  assert.strictEqual(ot.uptrendGate(c, 'notflat').pass, false);
});

test('uptrendGate: a downtrend never passes any vol mode', () => {
  const c = downtrendAtLow();
  for (const vm of ['notflat', 'flat', 'any']) assert.strictEqual(ot.uptrendGate(c, vm).pass, false);
});

test('capitulationGate: downtrend AT the 20d low passes; off the low or in an uptrend fails', () => {
  assert.strictEqual(ot.capitulationGate(downtrendAtLow()).pass, true);
  const off = downtrendAtLow(); off.push(off[off.length - 1] * 1.03);   // bounced off the low
  assert.strictEqual(ot.capitulationGate(off).pass, false);
  assert.strictEqual(ot.capitulationGate(uptrendHighVol()).pass, false);
});

test('fadeGate: a ≥+1% up-day inside a downtrend passes; quiet days fail', () => {
  assert.strictEqual(ot.fadeGate(downtrendRallyDay()).pass, true);
  assert.strictEqual(ot.fadeGate(downtrendAtLow()).pass, false);
});

test('selectSleeves: composes the book — capitulation long + SH fade from one panic tape', () => {
  const closes = { SPY: downtrendRallyDay(), QQQ: downtrendAtLow(), IWM: [], GLD: [], SH: [1, 2] };
  const s = ot.selectSleeves(closes);
  const names = s.map((x) => x.symbol + ':' + x.sleeve).sort();
  assert.ok(names.includes('QQQ:capitulation_20d_low'), 'QQQ capitulation selected');
  assert.ok(names.includes('SH:bear_rally_fade'), 'SH fade selected off the SPY signal');
});

test('sigma grossFor/grossMode: brake default, explicit 1x/2x honored', () => {
  const saved = process.env.SIGMA_GROSS_MODE;
  try {
    delete process.env.SIGMA_GROSS_MODE;
    assert.strictEqual(sigma.grossMode(), 'brake');
    process.env.SIGMA_GROSS_MODE = '2x';
    assert.strictEqual(sigma.grossMode(), '2x');
    assert.strictEqual(sigma.grossFor('1x'), 1.0);
    assert.strictEqual(sigma.grossFor('2x'), 2.0);
  } finally {
    if (saved === undefined) delete process.env.SIGMA_GROSS_MODE; else process.env.SIGMA_GROSS_MODE = saved;
  }
});

test('sigma financingFor: levered book pays BM+1.5% on borrowed notional; idle cash earns BM−0.5%', () => {
  const f2 = sigma.financingFor(2, 100000, 4.33);
  assert.strictEqual(f2.financing_apr, 5.83);
  assert.ok(Math.abs(f2.est_daily_cost - (100000 * 0.0583) / 360) < 0.02, 'ACT/360 daily cost on the borrowed 1×');
  const f05 = sigma.financingFor(0.5, 100000, 4.33);
  assert.strictEqual(f05.financing_apr, 0);
  assert.strictEqual(f05.cash_yield_apr, 3.83);
});
