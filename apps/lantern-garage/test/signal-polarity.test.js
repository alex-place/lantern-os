'use strict';

/**
 * signal-polarity.test.js — a wrapper's washout is not a market washout.
 *
 * Root cause of #3295: sessionIbs is computed on the symbol's OWN bars, and a
 * -3x wrapper mirrors its underlying intraday — so "SOXS IBS ≤ 0.15" is
 * mechanically "semis at their session HIGH" (measured: median underlying IBS
 * 0.90 at the 47 fire moments, 94% in the top third, 0% actually washed out).
 * The polarity-blind signal ran an unintended short-the-rip strategy that fired
 * hardest on the strongest up-days: on 2026-08-13 every inverse entry (SPXS
 * 10:06, SOXS 10:25, SQQQ 10:29, SOXS 11:15) was placed with SPY up 0.6-0.86%.
 *
 * applyPolarity makes the economics explicit: BULLISH on a negative-sign
 * instrument is an economic short, must state its thesis on the UNDERLYING at
 * its session top, and is only tradable behind TRADER_SHORT_EDGE=1 (no measured
 * short edge exists: -268R over 2,493 wrapper entries, negative under every
 * causal condition).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyPolarity } = require('../lib/signal-engine/scan');
const { underlyingProxy, instrumentSign } = require('../lib/direction-lock');

test('the 2026-08-13 shape: every inverse BULLISH becomes NEUTRAL, with the economics named', () => {
  delete process.env.TRADER_SHORT_EDGE;
  for (const sym of ['SPXS', 'SOXS', 'SQQQ', 'TZA']) {
    const r = applyPolarity(sym, 'BULLISH', {});
    assert.strictEqual(r.direction, 'NEUTRAL', `${sym} must not enter as a fake long`);
    assert.match(r.veto, /economic short/, 'the skip must say what the trade actually is');
    assert.match(r.veto, /short entries disabled/);
  }
});

test('1x instruments pass through untouched — the fix must not brush the real edge', () => {
  for (const sym of ['SPY', 'QQQ', 'SMH', 'IWM', 'DIA', 'GLD', 'TLT', 'XLK']) {
    const r = applyPolarity(sym, 'BULLISH', {});
    assert.strictEqual(r.direction, 'BULLISH', `${sym} is the +825R side; untouched`);
    assert.strictEqual(r.veto, null);
  }
});

test('leveraged LONGS pass through — polarity is about sign, not leverage', () => {
  // 3x long is a separate (income) question — #3295 covers it. The polarity
  // fix corrects MEANING, and a +3x wrapper's signal has the right sign.
  for (const sym of ['TQQQ', 'SOXL', 'SPXL', 'TNA']) {
    assert.strictEqual(applyPolarity(sym, 'BULLISH', {}).direction, 'BULLISH');
  }
});

test('BEARISH and NEUTRAL pass through on wrappers — the EXIT path must never be touched', () => {
  // A held SQQQ must remain exitable: bearish verdicts feed signal_exit, and
  // flipping them would strand or force-exit the live book (3 inverse positions
  // are held right now). Entry-side only.
  for (const d of ['BEARISH', 'NEUTRAL']) {
    const r = applyPolarity('SQQQ', d, {});
    assert.strictEqual(r.direction, d);
    assert.strictEqual(r.veto, null);
  }
});

test('TRADER_SHORT_EDGE=1: an explicit short needs the UNDERLYING at its session top', () => {
  const on = { shortEdge: true, ibsMax: 0.15 };
  // underlying at its high → the thesis is real, entry allowed
  assert.strictEqual(applyPolarity('SOXS', 'BULLISH', { ...on, underlyingIbs: 0.92 }).direction, 'BULLISH');
  // underlying mid-range → the wrapper washout was noise, refuse
  const mid = applyPolarity('SOXS', 'BULLISH', { ...on, underlyingIbs: 0.50 });
  assert.strictEqual(mid.direction, 'NEUTRAL');
  assert.match(mid.veto, /a wrapper washout is not a market washout/);
  // underlying unreadable → no thesis, refuse (conservative, like NEVER TRADE BLIND)
  const blind = applyPolarity('SOXS', 'BULLISH', { ...on, underlyingIbs: null });
  assert.strictEqual(blind.direction, 'NEUTRAL');
  assert.match(blind.veto, /underlying unreadable/);
});

test('the boundary is the mirror of the entry bar: 1 − ibsMax', () => {
  const on = { shortEdge: true, ibsMax: 0.15 };
  assert.strictEqual(applyPolarity('SPXS', 'BULLISH', { ...on, underlyingIbs: 0.85 }).direction, 'BULLISH', '0.85 = 1−0.15, inclusive');
  assert.strictEqual(applyPolarity('SPXS', 'BULLISH', { ...on, underlyingIbs: 0.849 }).direction, 'NEUTRAL');
});

test('underlyingProxy maps every negative-sign family to its 1x signal carrier', () => {
  assert.strictEqual(underlyingProxy('SOXS'), 'SMH');
  assert.strictEqual(underlyingProxy('SQQQ'), 'QQQ');
  assert.strictEqual(underlyingProxy('SPXS'), 'SPY');
  assert.strictEqual(underlyingProxy('TZA'), 'IWM');
  assert.strictEqual(underlyingProxy('SDOW'), 'DIA');
  assert.strictEqual(underlyingProxy('GLL'), 'GLD');
  assert.strictEqual(underlyingProxy('TBT'), 'TLT');
  assert.strictEqual(underlyingProxy('ZZZZ'), null, 'unknown family → no proxy, never invented');
});

test('every FAMILY entry with sign<0 has a proxy — a future inverse cannot fall through silently', () => {
  const { FAMILY } = require('../lib/direction-lock');
  for (const sym of Object.keys(FAMILY)) {
    if (instrumentSign(sym).sign < 0) {
      assert.ok(underlyingProxy(sym), `${sym} is negative-sign but has no 1x proxy`);
    }
  }
});
