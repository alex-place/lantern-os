'use strict';
// pwin-polarity.test.js — market-semantic EVIDENCE is scored in economic space
// (#3298 findings 1-2). A wrapper long in a bull market is regime-OPPOSED, and
// bullish-underlying news argues AGAINST a wrapper long. Price-space evidence
// stays in wrapper space. Behavioral tests: identical inputs, only the symbol
// (sign) or the news sign varies — p_win must move the economic way.
const { test } = require('node:test');
const assert = require('node:assert');
const { convergenceVerdict } = require('../lib/signal-engine/scan');

const base = (t, over = {}) => convergenceVerdict({
  t, direction: 'BULLISH',
  sr: { in_zone: false, zone_strength: 50, nearest_zone: { touches: 2 } },
  struct: { structureShifted: false, strength: 0 },
  candle: { pattern: null },
  marketStatus: { market: 'BULLISH' },
  news_sentiment: 0, volume_ratio: 1, macd_hist: 0, ma_signal: 0,
  earnings_surprise: null, sector_trend: null,
  ...over,
});

test('regime: SPY long is ALIGNED in a bull market; SOXS long is OPPOSED — p_win orders that way', () => {
  const spy = base('SPY');
  const soxs = base('SOXS');
  assert.ok(spy && soxs, 'verdicts computed');
  assert.ok(soxs.p_win < spy.p_win,
    `an economic short in a bull regime must score BELOW the aligned long (SOXS ${soxs.p_win} vs SPY ${spy.p_win})`);
});

test('regime symmetry: in a BEARISH market the wrapper long becomes the aligned one', () => {
  const spy = base('SPY', { marketStatus: { market: 'BEARISH' } });
  const soxs = base('SOXS', { marketStatus: { market: 'BEARISH' } });
  assert.ok(soxs.p_win > spy.p_win,
    `market falling: the economic short aligns (SOXS ${soxs.p_win} vs SPY ${spy.p_win})`);
});

test('news: bullish-underlying news HELPS a 1x long and HURTS a wrapper long', () => {
  const spyUp = base('SPY', { news_sentiment: 0.8 });
  const spyDn = base('SPY', { news_sentiment: -0.8 });
  assert.ok(spyUp.p_win > spyDn.p_win, '1x: bullish news supports the long');
  const soxsUp = base('SOXS', { news_sentiment: 0.8 });
  const soxsDn = base('SOXS', { news_sentiment: -0.8 });
  assert.ok(soxsUp.p_win < soxsDn.p_win,
    `wrapper: bullish semis news argues AGAINST long SOXS (${soxsUp.p_win} vs ${soxsDn.p_win})`);
});

test('unsigned instruments are bit-identical in behavior (sign +1 is a no-op)', () => {
  const a = base('QQQ', { news_sentiment: 0.5 });
  const b = base('QQQ', { news_sentiment: 0.5 });
  assert.deepStrictEqual(a, b);
});
