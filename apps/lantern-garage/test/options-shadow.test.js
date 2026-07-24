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
