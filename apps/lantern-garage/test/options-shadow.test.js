'use strict';

/**
 * options-shadow.js — pure-logic tests for the asymmetric-options SHADOW trader.
 * Win rate is an OUTPUT: summarize() must report what the ledger says and refuse a
 * positive verdict on thin or negative data (the "find the edge first" gate).
 */

const test = require('node:test');
const assert = require('node:assert');

const sh = require('../lib/options-shadow');

function trendUpHighVol() {
  // 80 bars: gentle uptrend, then a volatile late stretch (big alternating daily moves,
  // net rising) → close > SMA50, MACD > 0, rv10 above its trailing median.
  const closes = [];
  let px = 100;
  for (let i = 0; i < 60; i++) { px *= 1.002; closes.push(px); }
  for (let i = 0; i < 20; i++) { px *= (i % 2 ? 1.03 : 0.985); closes.push(px); }
  return closes;
}
function trendDown() {
  const closes = []; let px = 100;
  for (let i = 0; i < 80; i++) { px *= 0.997; closes.push(px); }
  return closes;
}
function flatQuiet() {
  // volatile early stretch, then dead-flat tail → rv10 BELOW its trailing median.
  const closes = []; let px = 100;
  for (let i = 0; i < 50; i++) { px *= (i % 2 ? 1.02 : 0.9805); closes.push(px); }
  for (let i = 0; i < 30; i++) { px *= 1.0006; closes.push(px); }
  return closes;
}

test('gates: eligible on trend-aligned + measurable vol', () => {
  const g = sh.gates(trendUpHighVol(), { volMode: 'notflat' });
  assert.strictEqual(g.eligible, true);
});

test('gates: rejects a downtrend outright', () => {
  const g = sh.gates(trendDown(), { volMode: 'any' });
  assert.strictEqual(g.eligible, false);
  assert.match(g.why, /trend/);
});

test('gates: rejects flat vol when notflat is required, accepts with volMode=flat', () => {
  const closes = flatQuiet();
  const g1 = sh.gates(closes, { volMode: 'notflat' });
  assert.strictEqual(g1.eligible, false);
  const g2 = sh.gates(closes, { volMode: 'flat' });
  assert.strictEqual(g2.eligible, true);
});

test('pickStrike: first strike above spot×(1+otm%)', () => {
  const strikes = [95, 100, 101, 102, 103, 105];
  assert.strictEqual(sh.pickStrike(100, strikes, 0.25), 101);  // 100.25 → 101
  assert.strictEqual(sh.pickStrike(100, strikes, 2.2), 103);   // 102.2 → 103
  assert.strictEqual(sh.pickStrike(100, strikes, 10), null);   // nothing that far OTM
});

test('summarize: thin data never yields a positive verdict', () => {
  const rows = Array.from({ length: 5 }, () => ({ phase: 'close', pl_pct: 50 }));
  const s = sh.summarize(rows);
  assert.strictEqual(s.n, 5);
  assert.match(s.verdict, /insufficient_data/);
});

test('summarize: negative expectancy → do-not-arm verdict even with many wins-by-count', () => {
  // The asymmetric profile in reverse: 40% small wins, 60% full losses → negative.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ phase: 'close', pl_pct: 20 });
  for (let i = 0; i < 60; i++) rows.push({ phase: 'close', pl_pct: -100 });
  const s = sh.summarize(rows);
  assert.strictEqual(s.win_rate_pct, 40);
  assert.ok(s.avg_pl_pct_of_premium < 0);
  assert.match(s.verdict, /negative_edge/);
});

test('summarize: the operator thesis profile — ~35% win with big winners → positive candidate', () => {
  // 35 wins at +250% of premium, 65 losses at −100% → avg = +27.5% → candidate.
  const rows = [];
  for (let i = 0; i < 35; i++) rows.push({ phase: 'close', pl_pct: 250 });
  for (let i = 0; i < 65; i++) rows.push({ phase: 'close', pl_pct: -100 });
  const s = sh.summarize(rows);
  assert.strictEqual(s.win_rate_pct, 35);
  assert.ok(s.avg_pl_pct_of_premium > 0);
  assert.match(s.verdict, /positive_edge_candidate/);
});

test('summarize: per-depth split — deep OTM judged on its own expectancy, not win rate', () => {
  const rows = [];
  // near (0.25%): 40% win small — negative overall
  for (let i = 0; i < 40; i++) rows.push({ phase: 'close', depth: 0.25, pl_pct: 30 });
  for (let i = 0; i < 60; i++) rows.push({ phase: 'close', depth: 0.25, pl_pct: -100 });
  // deep (2%): 3% win rate but +6000% payoffs — POSITIVE expectancy (the lottery profile)
  for (let i = 0; i < 3; i++) rows.push({ phase: 'close', depth: 2, pl_pct: 6000 });
  for (let i = 0; i < 97; i++) rows.push({ phase: 'close', depth: 2, pl_pct: -100 });
  const s = sh.summarize(rows);
  assert.ok(s.by_depth['0.25'].avg_pl_pct_of_premium < 0);
  assert.match(s.by_depth['0.25'].verdict, /negative_edge/);
  assert.strictEqual(s.by_depth['2'].win_rate_pct, 3);
  assert.ok(s.by_depth['2'].avg_pl_pct_of_premium > 0);
  assert.match(s.by_depth['2'].verdict, /positive_edge_candidate/);
});

test('cfg: ladder parses and defaults to five depths through 2% (deep OTM focus)', () => {
  const saved = process.env.OPTIONS_SHADOW_LADDER;
  try {
    delete process.env.OPTIONS_SHADOW_LADDER;
    assert.deepStrictEqual(sh.cfg().ladder, [0.25, 0.5, 1, 1.5, 2]);
    process.env.OPTIONS_SHADOW_LADDER = '1,2,3';
    assert.deepStrictEqual(sh.cfg().ladder, [1, 2, 3]);
  } finally {
    if (saved === undefined) delete process.env.OPTIONS_SHADOW_LADDER; else process.env.OPTIONS_SHADOW_LADDER = saved;
  }
});

test('parseOcc: decodes an OCC symbol', () => {
  assert.deepStrictEqual(sh.parseOcc('SPY260727C00741000'), { root: 'SPY', expiry: '2026-07-27', type: 'C', strike: 741 });
  assert.strictEqual(sh.parseOcc('garbage'), null);
});

test('pickPenny: first ask ≤ 1¢ strike above spot, honest ask-side pricing', () => {
  const list = [
    { strike: 741, ask: 1.72, bid: 1.66 },
    { strike: 747, ask: 0.16, bid: 0.15 },
    { strike: 751, ask: 0.05, bid: 0.04 },
    { strike: 754, ask: 0.01, bid: 0.0 },
    { strike: 760, ask: 0.01, bid: 0.0 },
  ];
  // high-vol night: rv10 = 1%/night → 754 is (754/739−1)=2.03% ≈ 2σ ≤ 3σ → take the FIRST penny (754, not 760)
  const r = sh.pickPenny(list, 739, { askMax: 0.01, rv10: 0.01, maxSigma: 3 });
  assert.ok(r.pick && r.pick.strike === 754);
  assert.strictEqual(r.pick.ask, 0.01);
});

test('pickPenny: vol-selectivity rejects the penny strike on a quiet night', () => {
  const list = [{ strike: 754, ask: 0.01, bid: 0 }];
  // quiet night: rv10 = 0.4%/night → 2.03% ≈ 5.1σ > 3σ → SKIP (the selectivity the operator asked for)
  const r = sh.pickPenny(list, 739, { askMax: 0.01, rv10: 0.004, maxSigma: 3 });
  assert.strictEqual(r.pick, null);
  assert.match(r.reason, /too far for tonight's vol/);
});

test('pickPenny: no penny available → honest reason with the cheapest ask', () => {
  const r = sh.pickPenny([{ strike: 745, ask: 0.25, bid: 0.2 }], 739, { askMax: 0.01, rv10: 0.01 });
  assert.strictEqual(r.pick, null);
  assert.match(r.reason, /no strike at ≤ \$0.01/);
});

test('nextTradingDayET: skips weekends (the UTC-roll bug priced weekend time value)', () => {
  const thu = new Date('2026-07-23T16:00:00');   // Thursday local-ET clone
  assert.strictEqual(sh.nextTradingDayET(thu), '2026-07-24');   // → Friday
  const fri = new Date('2026-07-24T16:00:00');
  assert.strictEqual(sh.nextTradingDayET(fri), '2026-07-27');   // → Monday (skip Sat/Sun)
  const sat = new Date('2026-07-25T12:00:00');
  assert.strictEqual(sh.nextTradingDayET(sat), '2026-07-27');
});
