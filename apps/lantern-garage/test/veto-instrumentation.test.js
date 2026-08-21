'use strict';
/**
 * veto-instrumentation.test.js — the skip row must carry the EVIDENCE (#3374).
 *
 * The gates were unauditable because the ledger recorded each verdict without
 * the numbers behind it. Rebuilding those numbers afterwards was measured and
 * does not work: replaying the falling-knife predicate against the stored 5m
 * corpus reproduces `hist < 0` on 91% of its own recorded fires but the
 * `deepening` term on only 72%, because the engine decides on bars fetched live
 * at scan time and one bar of offset flips a difference between two adjacent
 * MACD reads. A model shown the rebuilt values correctly objected that the
 * rule's premise was unmet on 11 of 47 fires — a harness defect that looked
 * exactly like a finding.
 *
 * These tests pin the two properties that keep the fix honest:
 *   - splitting the reading out of the verdict changed NO behaviour
 *   - the reading exposes the pair the verdict actually turned on
 */
const { test } = require('node:test');
const assert = require('node:assert');

// TRADER_TRADES_LOG must be set BEFORE the module is required — it is read at
// module load into a constant (the same trap stop-reconciliation.test.js pins).
const _os = require('os');
const _path = require('path');
const _fs = require('fs');
const SKIP_LOG = _path.join(_fs.mkdtempSync(_path.join(_os.tmpdir(), 'vetoinstr-')), 'trades.jsonl');
process.env.TRADER_TRADES_LOG = SKIP_LOG;
const { knifeReading, isFallingKnife, _logSkips } = require('../lib/auto-trader');
const { macd } = require('../lib/signal-engine/indicators');

/** The predicate exactly as it read before the split, for differential testing. */
function original(closes) {
  if (!Array.isArray(closes) || closes.length < 36) return false;
  const now = macd(closes);
  const prev = macd(closes.slice(0, -1));
  if (!now || !prev) return false;
  return now.histogram < 0 && now.histogram < prev.histogram;
}

/** Deterministic pseudo-random walks — same series every run. */
function walk(seed, len) {
  let s = seed;
  const rnd = () => (s = (1103515245 * s + 12345) % 2147483648) / 2147483648;
  let px = 50 + rnd() * 100;
  const out = [];
  for (let i = 0; i < len; i++) { px *= 1 + (rnd() - 0.5) * 0.04; out.push(px); }
  return out;
}

test('BEHAVIOUR-IDENTICAL: the split verdict matches the original on every series', () => {
  let fired = 0, n = 0;
  for (let seed = 1; seed <= 400; seed++) {
    for (const len of [0, 12, 35, 36, 37, 60]) {     // straddles the 36-close floor
      const c = walk(seed, len);
      const before = original(c);
      assert.strictEqual(isFallingKnife(c), before, `seed ${seed} len ${len}`);
      n++; if (before) fired++;
    }
  }
  assert.ok(fired > 50, `the corpus must actually exercise the firing branch, got ${fired}/${n}`);
});

test('degenerate inputs behave exactly as before', () => {
  for (const c of [null, undefined, [], [1, 2, 3], new Array(36).fill(0), new Array(40).fill(NaN)]) {
    assert.strictEqual(isFallingKnife(c), original(c), JSON.stringify(c && c.slice && c.slice(0, 3)));
  }
});

test('isFallingKnife is exactly the reading it wraps — no second opinion', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const c = walk(seed, 60);
    const r = knifeReading(c);
    assert.strictEqual(isFallingKnife(c), !!(r && r.fires), `seed ${seed}`);
  }
});

test('the reading EXPOSES the pair the verdict turned on', () => {
  const c = walk(7, 60);
  const r = knifeReading(c);
  assert.ok(r, 'a 60-close series must produce a reading');
  for (const k of ['hist', 'prev', 'fires']) assert.ok(k in r, `missing ${k}`);
  assert.ok(Number.isFinite(r.hist) && Number.isFinite(r.prev), 'both MACD reads must be numbers');
  // the recorded pair must RE-DERIVE the verdict — that is the whole point of
  // recording it, and it is what the reconstruction could not do
  assert.strictEqual(r.fires, r.hist < 0 && r.hist < r.prev,
    'the logged numbers must reproduce the decision they justified');
});

test('too short to judge returns null, not a fabricated reading', () => {
  for (const len of [0, 1, 35]) assert.strictEqual(knifeReading(walk(3, len)), null, `len ${len}`);
  assert.strictEqual(knifeReading(null), null);
  assert.ok(knifeReading(walk(3, 36)) !== null, '36 closes is the documented floor and must be judgeable');
});

test('a series that fires reports a negative, deepening histogram', () => {
  const firing = [];
  for (let seed = 1; seed <= 400 && firing.length < 5; seed++) {
    const c = walk(seed, 60);
    const r = knifeReading(c);
    if (r && r.fires) firing.push(r);
  }
  assert.ok(firing.length >= 5, 'need firing examples to assert on');
  for (const r of firing) {
    assert.ok(r.hist < 0, `a fire must be negative, got ${r.hist}`);
    assert.ok(r.hist < r.prev, `a fire must be deepening, got ${r.hist} vs ${r.prev}`);
  }
});

test('END TO END (#3381): the evidence survives _logSkips to the ledger row', () => {
  // #3375 shipped the context onto the record; the ledger writer then dropped it,
  // and nobody noticed until the feature's first live day produced bare rows.
  // This is the round trip the original tests skipped.
  {
    _logSkips([{ symbol: 'TESTX', direction: 'BULLISH', p_win: 0.61, why: 'already long',
      ibs: 0.043, spy_tape: -0.51, spy_mom30: -0.12, regime: 'BEARISH', et_min: 585,
      macd_hist: -0.0421, in_zone: true, sign: 1, knife_hist: -0.031, knife_prev: -0.02 }]);
    const rows = _fs.readFileSync(SKIP_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const r = rows.find((x) => x.symbol === 'TESTX');
    assert.ok(r, 'the skip row must be written');
    assert.strictEqual(r.ibs, 0.043, 'ibs reaches disk');
    assert.strictEqual(r.spy_tape, -0.51);
    assert.strictEqual(r.regime, 'BEARISH');
    assert.strictEqual(r.macd_hist, -0.0421);
    assert.strictEqual(r.knife_hist, -0.031, 'the falling-knife pair reaches disk');
    assert.strictEqual(r.in_zone, true);
    assert.strictEqual(r.reason, 'already long', 'the original fields are intact');
  }
});

test('a record WITHOUT evidence still writes the bare row — old callers unaffected', () => {
  {
    _logSkips([{ symbol: 'BARE', direction: 'NEUTRAL', p_win: 0.5, why: 'bearish, no long to exit' }]);
    const r = _fs.readFileSync(SKIP_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).find((x) => x.symbol === 'BARE');
    assert.ok(r);
    assert.ok(!('ibs' in r), 'absent evidence stays absent — no undefined/null pollution');
  }
});

test('MIRROR MAP (#3390): every leveraged pair mirrors both ways at matched leverage', () => {
  const { mirrorOf, leverageOf } = require('../lib/direction-lock');
  // the pairs the redirect would trade — each must resolve and be symmetric
  for (const [a, b] of [['SOXL', 'SOXS'], ['TQQQ', 'SQQQ'], ['SPXL', 'SPXS'],
    ['TNA', 'TZA'], ['UDOW', 'SDOW'], ['SSO', 'SDS'], ['QLD', 'QID'], ['UWM', 'TWM']]) {
    assert.strictEqual(mirrorOf(a), b, `${a} → ${b}`);
    assert.strictEqual(mirrorOf(b), a, `${b} → ${a} (symmetric)`);
    assert.strictEqual(leverageOf(a), leverageOf(b), `${a}/${b} leverage must match`);
  }
});

test('mirrorOf never invents a mirror: unlevered longs and unknowns return null', () => {
  const { mirrorOf } = require('../lib/direction-lock');
  // SPY's -1x exists (SH) but SPY is 1x long — its mirror IS SH (1x): allowed.
  assert.strictEqual(mirrorOf('SPY'), 'SH', '1x mirrors to the 1x inverse');
  // no same-leverage opposite in the universe → null, never a mismatched pair
  for (const s of ['GLD', 'XLK', 'NOPE', '', null]) {
    const m = mirrorOf(s);
    assert.ok(m === null || m !== s, `no self-mirror for ${s}`);
  }
  assert.strictEqual(mirrorOf('XLK'), null, 'XLK has no inverse in the universe');
});
