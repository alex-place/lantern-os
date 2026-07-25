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

test('edge gate: a sleeve stays DRY until its own ledger proves the edge, and auto-pauses on negative', () => {
  const c = { armed: true, edgeGate: true, edgeMinN: 20 };
  const mkRows = (sleeve, n, pl) => Array.from({ length: n }, () => ({ phase: 'exit', sleeve, pl_pct_est: pl }));
  // unproven (n < minN) → dry
  let sum = ot.summarize(mkRows('uptrend+notflat', 5, 0.2), { minN: 20 });
  assert.strictEqual(ot.canArm('uptrend+notflat', sum, c).arm, false);
  assert.match(ot.canArm('uptrend+notflat', sum, c).why, /unproven/);
  // proven positive over ≥ minN → armed
  sum = ot.summarize(mkRows('uptrend+notflat', 25, 0.15), { minN: 20 });
  assert.strictEqual(ot.canArm('uptrend+notflat', sum, c).arm, true);
  // measured negative live → auto-paused even though armed
  sum = ot.summarize(mkRows('capitulation_20d_low', 30, -0.4), { minN: 20 });
  const g = ot.canArm('capitulation_20d_low', sum, c);
  assert.strictEqual(g.arm, false);
  assert.match(g.why, /NEGATIVE/);
  // a sleeve with NO history at all → dry
  assert.strictEqual(ot.canArm('bear_rally_fade', sum, c).arm, false);
  // gate disabled (operator escape hatch) → armed passes through
  assert.strictEqual(ot.canArm('bear_rally_fade', sum, { ...c, edgeGate: false }).arm, true);
  // not armed → never places, regardless of evidence
  assert.strictEqual(ot.canArm('uptrend+notflat', sum, { ...c, armed: false }).arm, false);
});

test('summarize: per-sleeve verdicts from est. close→open P&L rows', () => {
  const rows = [
    ...Array.from({ length: 22 }, () => ({ phase: 'exit', sleeve: 'a', pl_pct_est: 0.1 })),
    ...Array.from({ length: 3 }, () => ({ phase: 'exit', sleeve: 'b', pl_pct_est: -1 })),
    { phase: 'enter', sleeve: 'a' },                       // non-exit rows ignored
  ];
  const s = ot.summarize(rows, { minN: 20 });
  assert.strictEqual(s.by_sleeve.a.verdict, 'positive_edge');
  assert.strictEqual(s.by_sleeve.b.verdict, 'insufficient_data');
});

test('position partitioning: the intraday engine leaves overnight-owned symbols alone', async () => {
  const at = require('../lib/auto-trader');
  const saved = { ...process.env };
  const actions = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    // SPY deep in the red — normally the max-loss backstop would market-exit it AND
    // the re-protect pass would attach a stop. Excluded → neither may touch it.
    getIBKRPositions: async () => [{ symbol: 'SPY', qty: 10, avg_entry_price: 100, current_price: 85, market_value: 850, unrealized_pl: -150 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { actions.push(o); return { status: 'placed' }; },
  };
  try {
    process.env.TRADER_MANAGE_EXITS = '1';
    process.env.TRADER_AUTO_EXECUTE = '0';
    process.env.TRADER_MOMENTUM_EXIT = '0';
    process.env.TRADER_MIN_HOLD_MIN = '0';
    process.env.TRADER_MAX_LOSS_PCT = '8';
    at._resetCooldowns();
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 'u', now: 1_700_000_000_000, excludeSymbols: ['SPY'] });
    assert.strictEqual(actions.filter((o) => o.ticker === 'SPY').length, 0, 'no exit, no stop — SPY untouched');
    // control: WITHOUT the exclusion the backstop fires
    at._resetCooldowns();
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 'u', now: 1_700_000_000_000 });
    assert.ok(actions.some((o) => o.ticker === 'SPY' && o.side === 'sell'), 'control: backstop exits SPY when not excluded');
  } finally {
    process.env = saved;
    at._resetCooldowns();
  }
});

test('heldSymbols: reads the open overnight legs from state (round-trip)', () => {
  const fs = require('fs');
  const prior = fs.existsSync(ot.STATE) ? fs.readFileSync(ot.STATE, 'utf8') : null;
  try {
    fs.mkdirSync(require('path').dirname(ot.STATE), { recursive: true });
    fs.writeFileSync(ot.STATE, JSON.stringify({ open: { date: '2026-01-01', legs: [{ symbol: 'SPY' }, { symbol: 'SH' }] } }));
    const s = ot.heldSymbols();
    assert.ok(s.has('SPY') && s.has('SH') && s.size === 2);
    fs.writeFileSync(ot.STATE, JSON.stringify({}));
    assert.strictEqual(ot.heldSymbols().size, 0);
  } finally {
    if (prior != null) fs.writeFileSync(ot.STATE, prior); else { try { fs.unlinkSync(ot.STATE); } catch (_e) { /* */ } }
  }
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
