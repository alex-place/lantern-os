'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeScorecard, reasonFamily } = require('../lib/trader-scorecard');

test('reasonFamily groups verbose exit reasons to their family', () => {
  assert.strictEqual(reasonFamily('trailing_stop (−1.6% from peak +28.8%, trig 1.25%)'), 'trailing_stop');
  assert.strictEqual(reasonFamily('momentum_died (MACD hist<0, <EMA9, RSI 37)'), 'momentum_died');
  assert.strictEqual(reasonFamily('signal_exit'), 'signal_exit');
  assert.strictEqual(reasonFamily(null), 'unknown');
});

test('computeScorecard: win rate, expectancy, profit factor, per-reason breakdown', () => {
  const exits = [
    { symbol: 'SOXS', pnl: 9582.43, reason: 'trailing_stop (…)', status: 'placed' },
    { symbol: 'AAPL', pnl: 2156.46, reason: 'signal_exit', status: 'placed' },
    { symbol: 'AMD', pnl: -693.8, reason: 'signal_exit', status: 'placed' },
    { symbol: 'MSFT', pnl: 90.86, reason: 'momentum_died (…)', status: 'placed' },
  ];
  const s = computeScorecard(exits);
  assert.strictEqual(s.trades, 4);
  assert.strictEqual(s.wins, 3);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.winRate, 75);
  assert.strictEqual(s.totalRealized, 11135.95);      // 9582.43+2156.46-693.8+90.86
  assert.strictEqual(s.avgLoss, -693.8);
  // profit factor = gross wins / |gross losses| = 11829.75 / 693.8 ≈ 17.05
  assert.ok(Math.abs(s.profitFactor - 17.05) < 0.05);
  // signal_exit has one win + one loss → 50%
  assert.strictEqual(s.byReason.signal_exit.trades, 2);
  assert.strictEqual(s.byReason.signal_exit.winRate, 50);
  assert.strictEqual(s.byReason.trailing_stop.wins, 1);
});

test('computeScorecard: profit-taking exits are flagged + excluded from the honest risk win rate', () => {
  const exits = [
    // momentum_died only ever closes winners (structural 100%) — must NOT count toward skill.
    { symbol: 'A', pnl: 50, reason: 'momentum_died (…)', status: 'placed' },
    { symbol: 'B', pnl: 90, reason: 'momentum_died (…)', status: 'placed' },
    // risk exits: one win, one loss → honest risk win rate = 50%.
    { symbol: 'C', pnl: 500, reason: 'trailing_stop (…)', status: 'placed' },
    { symbol: 'D', pnl: -200, reason: 'signal_exit', status: 'placed' },
  ];
  const s = computeScorecard(exits);
  assert.strictEqual(s.winRate, 75);            // raw (flattered by momentum_died)
  assert.strictEqual(s.riskExitTrades, 2);      // only trailing_stop + signal_exit
  assert.strictEqual(s.riskExitWinRate, 50);    // the number that actually means something
  assert.strictEqual(s.byReason.momentum_died.profitOnly, true);
  assert.strictEqual(s.byReason.signal_exit.profitOnly, false);
});

test('computeScorecard: no losses → profitFactor Infinity; empty → zeros', () => {
  assert.strictEqual(computeScorecard([{ pnl: 5, reason: 'x', status: 'placed' }]).profitFactor, Infinity);
  const empty = computeScorecard([]);
  assert.strictEqual(empty.trades, 0);
  assert.strictEqual(empty.winRate, 0);
  assert.strictEqual(empty.expectancy, 0);
  assert.strictEqual(empty.profitFactor, 0);
});

test('computeScorecard ignores rows without a numeric pnl', () => {
  const s = computeScorecard([{ pnl: 100, reason: 'a', status: 'placed' }, { pnl: null, reason: 'b' }, { reason: 'c' }]);
  assert.strictEqual(s.trades, 1);
});
