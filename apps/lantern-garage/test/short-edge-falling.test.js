'use strict';
// short-edge-falling.test.js — the polarity veto is CONDITIONAL, not a delist
// (#3343). "A veto blocking 100% of inverse entries pretty much removed inverses
// from the watchlist with extra steps." TRADER_SHORT_EDGE=falling allows an
// economic short only while SPY is falling AT THE FIRE — causal, no peeking.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyPolarity, spyTapeContext } = require('../lib/signal-engine/scan');

const AP = (sym, spy, extra = {}) => applyPolarity(sym, 'BULLISH', { spy, ...extra });

test('mode 0 (default): still vetoes, and the veto row carries the causal context', () => {
  const r = AP('SOXS', { tape: -0.5, mom30: -0.3, ll: true }, { shortEdge: '0' });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /spy tape -0\.50%/, 'the context rides on the veto for the counterfactual ledger');
});

test('falling: SPY tape down >0.3% at the fire ALLOWS the wrapper', () => {
  const r = AP('SOXS', { tape: -0.45, mom30: 0.02, ll: true }, { shortEdge: 'falling' });
  assert.strictEqual(r.direction, 'BULLISH');
  assert.match(r.allowed, /falling tape/);
});

test('falling: SPY momentum down >0.15% over 30m ALLOWS even if tape is flat', () => {
  const r = AP('SQQQ', { tape: -0.05, mom30: -0.2, ll: true }, { shortEdge: 'falling' });
  assert.strictEqual(r.direction, 'BULLISH', 'the tape can be flat while the last 30 min are falling');
});

test('falling: SPY flat/rising at the fire is REFUSED — the -1.17% bucket', () => {
  const r = AP('SPXS', { tape: 0.4, mom30: 0.1, ll: false }, { shortEdge: 'falling' });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /not falling/);
  const flat = AP('SPXS', { tape: -0.06, mom30: 0.05, ll: true }, { shortEdge: 'falling' });
  assert.strictEqual(flat.direction, 'NEUTRAL', 'today\'s 11:15 SQQQ shape (tape -0.06, mom +0.05) is honestly NOT falling yet');
});

test('falling: SPY context unreadable → refuse (never certify a falling market blind)', () => {
  const r = AP('TZA', { tape: null, mom30: null, ll: null }, { shortEdge: 'falling' });
  assert.strictEqual(r.direction, 'NEUTRAL');
  assert.match(r.veto, /unreadable/);
});

test('mode 1: the original explicit-short thesis is unchanged', () => {
  const ok = AP('SOXS', { tape: 0.5, mom30: 0.2, ll: false }, { shortEdge: '1', underlyingIbs: 0.92 });
  assert.strictEqual(ok.direction, 'BULLISH');
  const no = AP('SOXS', { tape: 0.5, mom30: 0.2, ll: false }, { shortEdge: '1', underlyingIbs: 0.5 });
  assert.strictEqual(no.direction, 'NEUTRAL');
});

test('1x and leveraged-long instruments never touch the gate in any mode', () => {
  for (const m of ['0', 'falling', '1']) {
    for (const s of ['SPY', 'QQQ', 'TQQQ', 'SOXL']) {
      const r = AP(s, { tape: 1, mom30: 1, ll: false }, { shortEdge: m });
      assert.strictEqual(r.direction, 'BULLISH', `${s} in mode ${m}`);
    }
  }
});

test('spyTapeContext: computed from SPY\'s own session bars, causally', () => {
  const bar = (ts, o, h, l, c) => ({ timestamp: ts, open: o, high: h, low: l, close: c });
  const bars = [
    bar('2026-08-17T13:30:00Z', 776.2, 776.6, 775.9, 776.1),
    bar('2026-08-17T13:45:00Z', 776.1, 776.3, 775.4, 775.6),
    bar('2026-08-17T14:00:00Z', 775.6, 775.8, 774.9, 775.0),
    bar('2026-08-17T14:15:00Z', 775.0, 775.2, 774.2, 774.4),   // last: falling, lower low
  ];
  const c = spyTapeContext(bars);
  assert.ok(Math.abs(c.tape - ((774.4 - 776.2) / 776.2) * 100) < 1e-9, 'tape = last vs session open');
  assert.ok(c.mom30 < 0, 'last two bars fell');
  assert.strictEqual(c.ll, true, 'lows stepping down');
  assert.deepStrictEqual(spyTapeContext([]), { tape: null, mom30: null, ll: null });
});
