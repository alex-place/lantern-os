'use strict';
/**
 * test/trade-replay.test.js — #3561.
 *
 * The assembly is pure, so the rules that matter are testable without a bar corpus: which
 * entry a given exit belongs to, which marks the record actually supports, and — the one
 * this card lives or dies on — what it says when the bars are not there. A replay that
 * drew a flat line for a symbol we have never seen would be worse than no replay, because
 * a trader would read the flat line as the market.
 *
 * Run: node --test apps/lantern-garage/test/trade-replay.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/trade-replay');

const T = (t) => Date.parse(t);
const bars = (startIso, n, tfMs, price) => {
  const t0 = T(startIso);
  return Array.from({ length: n }, (_, i) => {
    const p = (typeof price === 'function' ? price(i) : price + Math.sin(i / 5));
    return { t: t0 + i * tfMs, o: p, h: p + 0.25, l: p - 0.25, c: p, v: 100 };
  });
};

// ── which entry an exit belongs to ───────────────────────────────────────────

test('an exit is matched to the entry that opened the position it closed', () => {
  const rows = [
    { event: 'entry', symbol: 'SOXL', ts: '2026-09-09T14:00:00Z', qty: 10, entry: 100, stop: 97, target1: 106 },
    { event: 'exit', symbol: 'SOXL', ts: '2026-09-09T18:00:00Z', qty: 10 },
  ];
  const o = R.openingFor({ symbol: 'SOXL', ts: '2026-09-09T18:00:00Z' }, rows);
  assert.strictEqual(o.at, '2026-09-09T14:00:00.000Z');
  assert.strictEqual(o.stop, 97);
  assert.strictEqual(o.recovered, true, 'openingFor exists BECAUSE the exit row had none');
});

test('a scale-out keeps its opening — the position was still on', () => {
  /* Two exits against one entry. The second is not an orphan: it closed the remainder of
     a position that began at the same entry, and the stop it was running under is that
     entry's. Matching on "the nearest entry before it" would have found nothing. */
  const rows = [
    { event: 'entry', symbol: 'TNA', ts: '2026-09-09T16:00:00Z', qty: 100, entry: 66, stop: 64 },
    { event: 'exit', symbol: 'TNA', ts: '2026-09-10T13:31:00Z', qty: 40 },
    { event: 'exit', symbol: 'TNA', ts: '2026-09-10T13:52:00Z', qty: 60 },
  ];
  const first = R.openingFor({ symbol: 'TNA', ts: '2026-09-10T13:31:00Z' }, rows);
  const second = R.openingFor({ symbol: 'TNA', ts: '2026-09-10T13:52:00Z' }, rows);
  assert.strictEqual(first.at, '2026-09-09T16:00:00.000Z');
  assert.strictEqual(second.at, first.at, 'the remainder belongs to the same opening');
  assert.strictEqual(second.stop, 64);
});

test('a scale-in does not move the opening — the position began where it began', () => {
  const rows = [
    { event: 'entry', symbol: 'SPY', ts: '2026-09-09T14:00:00Z', qty: 10, entry: 700, stop: 690 },
    { event: 'entry', symbol: 'SPY', ts: '2026-09-09T15:00:00Z', qty: 10, entry: 705, stop: 695 },
    { event: 'exit', symbol: 'SPY', ts: '2026-09-09T18:00:00Z', qty: 20 },
  ];
  const o = R.openingFor({ symbol: 'SPY', ts: '2026-09-09T18:00:00Z' }, rows);
  assert.strictEqual(o.at, '2026-09-09T14:00:00.000Z');
  assert.strictEqual(o.stop, 690, 'the stop the position was OPENED with');
});

test('a later position does not inherit the previous one\'s opening', () => {
  const rows = [
    { event: 'entry', symbol: 'QQQ', ts: '2026-09-01T14:00:00Z', qty: 5, entry: 600, stop: 580 },
    { event: 'exit', symbol: 'QQQ', ts: '2026-09-01T18:00:00Z', qty: 5 },
    { event: 'exit', symbol: 'QQQ', ts: '2026-09-05T18:00:00Z', qty: 5 },   // no entry recorded
  ];
  assert.strictEqual(R.openingFor({ symbol: 'QQQ', ts: '2026-09-05T18:00:00Z' }, rows), null,
    'no opening beats the wrong opening — a stop line from a different trade is a lie');
});

test('another symbol\'s tape is not consulted', () => {
  const rows = [
    { event: 'entry', symbol: 'AAPL', ts: '2026-09-09T14:00:00Z', qty: 5, entry: 200, stop: 190 },
    { event: 'exit', symbol: 'NVDA', ts: '2026-09-09T18:00:00Z', qty: 5 },
  ];
  assert.strictEqual(R.openingFor({ symbol: 'NVDA', ts: '2026-09-09T18:00:00Z' }, rows), null);
});

// ── what the marks say ───────────────────────────────────────────────────────

test('a short\'s favourable excursion is BELOW its entry', () => {
  // mfe_pct is favourable whichever way the trade faced. Taking it as "up" would draw a
  // winning short's best moment on the wrong side of its own entry.
  const long = R.excursionLevels({ side: 'long', entry: 100, mfe_pct: 3, mae_pct: -1 });
  const short = R.excursionLevels({ side: 'short', entry: 100, mfe_pct: 3, mae_pct: -1 });
  assert.ok(long.mfe > 100 && long.mae < 100);
  assert.ok(short.mfe < 100 && short.mae > 100);
});

test('the stop prefers the price recorded over the distance it was sized against', () => {
  const trade = { side: 'long', entry: 100, stop_dist_pct: 3 };
  const withEvent = R.stopLevel(trade, { stop: 97.5 });
  assert.strictEqual(withEvent.price, 97.5);
  assert.match(withEvent.from, /placed at entry/);

  const derived = R.stopLevel(trade, null);
  assert.ok(Math.abs(derived.price - 97) < 1e-9, 'a long\'s stop sits BELOW its entry');
  assert.match(derived.from, /sized against/);

  const short = R.stopLevel({ side: 'short', entry: 100, stop_dist_pct: 3 }, null);
  assert.ok(Math.abs(short.price - 103) < 1e-9, 'a short\'s sits above');
});

test('no stop anywhere in the record draws no stop line', () => {
  assert.strictEqual(R.stopLevel({ side: 'long', entry: 100 }, null), null);
  assert.strictEqual(R.stopLevel({ side: 'long' }, { stop: null }), null);
});

// ── resolution ───────────────────────────────────────────────────────────────

test('resolution is proportionate to how long the position was held', () => {
  const at = (mins) => R.pickTf(0, mins * 60000).tf;
  assert.strictEqual(at(25), '5m', 'a scalp');
  assert.strictEqual(at(10 * 60), '15m', 'an overnight');
  assert.strictEqual(at(5 * 24 * 60), '1h', 'a week');
});

test('rolling up keeps the extremes exactly', () => {
  const src = [
    { t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 },
    { t: 1, o: 11, h: 15, l: 10, c: 14, v: 2 },
    { t: 2, o: 14, h: 14, l: 8, c: 9, v: 3 },
  ];
  const [b] = R.aggregate(src, 3);
  assert.deepStrictEqual([b.o, b.h, b.l, b.c, b.v], [10, 15, 8, 9, 6]);
});

// ── honesty ──────────────────────────────────────────────────────────────────

test('a symbol we have never archived says exactly that', () => {
  const out = R.assemble({
    trade: { id: 'x', symbol: 'TSLA', ts: '2026-09-09T18:00:00Z', entry: 300, exit: 310, side: 'long' },
    bars: [], held: { count: 0, first: null, last: null },
  });
  assert.strictEqual(out.coverage, 'none');
  assert.strictEqual(out.bars.length, 0, 'and draws nothing, rather than a flat line');
  assert.match(out.why, /no bar history for TSLA/);
});

test('a trade outside the window we hold says which side of it it fell', () => {
  const held = { count: 500, first: T('2026-07-01T13:30:00Z'), last: T('2026-08-20T20:00:00Z') };
  const after = R.coverageOf([], null, T('2026-08-21T18:00:00Z'), held, 'SPMO');
  const before = R.coverageOf([], null, T('2026-06-01T18:00:00Z'), held, 'SPMO');
  assert.match(after.why, /after they end/);
  assert.match(before.why, /before they begin/);
  // A hole between the two ends is neither, and must not claim to be.
  const hole = R.coverageOf([], null, T('2026-07-20T18:00:00Z'), held, 'SPMO');
  assert.match(hole.why, /none for the window/);
});

test('a live fetch that came back empty blames the horizon, not our archive', () => {
  // These two failures wear the same empty list and a reader can act on only one of them.
  const old = Date.now() - 200 * 24 * 3600 * 1000;
  const out = R.coverageOf([], null, old, null, 'AAPL', { live: true });
  assert.match(out.why, /free only for about the last 60 days/);
  assert.doesNotMatch(out.why, /symbols this machine watches/);
});

test('bars that do not reach the exit are partial, drawn, and labelled', () => {
  const b = bars('2026-09-09T13:30:00Z', 30, 300000, 100);
  const out = R.assemble({
    trade: { id: 'x', symbol: 'SPY', side: 'long', entry: 100, exit: 101,
      openedAt: '2026-09-09T13:35:00Z', ts: '2026-09-09T20:00:00Z' },
    bars: b, held: { count: b.length, first: b[0].t, last: b[b.length - 1].t },
  });
  assert.strictEqual(out.coverage, 'partial');
  assert.ok(out.bars.length > 0, 'half a trade\'s bars is more than none');
  assert.match(out.why, /missing after/);
  assert.strictEqual(out.marks.exitIdx, null, 'and the exit is not pinned to a bar it is not on');
});

test('a frame that brackets the trade is full, and pins both ends', () => {
  const b = bars('2026-09-09T12:00:00Z', 120, 300000, 100);
  const out = R.assemble({
    trade: { id: 'x', symbol: 'SPY', side: 'long', qty: 10, entry: 100, exit: 102,
      openedAt: '2026-09-09T14:00:00Z', ts: '2026-09-09T16:00:00Z' },
    opening: { at: '2026-09-09T14:00:00Z', stop: 97, target1: 104, recovered: true },
    bars: b, held: { count: b.length, first: b[0].t, last: b[b.length - 1].t },
  });
  assert.strictEqual(out.coverage, 'full');
  assert.strictEqual(out.why, null);
  assert.strictEqual(typeof out.marks.entryIdx, 'number');
  assert.ok(out.marks.exitIdx > out.marks.entryIdx);
  assert.strictEqual(out.opening.recovered, true);
});

test('the frame is the trade plus a pad, not the whole window asked for', () => {
  // spanFor deliberately over-asks (bars are not evenly spaced, so a bar-count pad cannot
  // be computed before the bars are in hand). The trim is what keeps the chart readable.
  const b = bars('2026-09-07T00:00:00Z', 900, 300000, 100);
  const out = R.assemble({
    trade: { id: 'x', symbol: 'SPY', side: 'long', entry: 100, exit: 101,
      openedAt: '2026-09-09T14:00:00Z', ts: '2026-09-09T15:00:00Z' },
    bars: b, held: { count: b.length, first: b[0].t, last: b[b.length - 1].t },
  });
  const held = 12;                                  // one hour of 5m bars
  assert.strictEqual(out.bars.length, R.PAD_BARS * 2 + held + 1);
  assert.strictEqual(out.marks.entryIdx, R.PAD_BARS, 'the pad before the entry is the setup');
});

test('bars already at the wanted resolution are not rolled up again', () => {
  const b = bars('2026-09-07T00:00:00Z', 200, 3600000, 100);       // real 1h bars
  const out = R.assemble({
    trade: { id: 'x', symbol: 'SPY', side: 'long', entry: 100, exit: 101,
      openedAt: '2026-09-08T14:00:00Z', ts: '2026-09-11T15:00:00Z' },
    bars: b, barsTf: '1h', held: { count: b.length, first: b[0].t, last: b[b.length - 1].t },
  });
  assert.strictEqual(out.timeframe, '1h');
  assert.strictEqual(out.rolledUp, null, 'nothing was reconstructed, so nothing claims to be');
});

test('5m bars asked for at 1h say they were rolled up', () => {
  const b = bars('2026-09-07T00:00:00Z', 900, 300000, 100);
  const out = R.assemble({
    trade: { id: 'x', symbol: 'SPY', side: 'long', entry: 100, exit: 101,
      openedAt: '2026-09-08T14:00:00Z', ts: '2026-09-10T15:00:00Z' },
    bars: b, barsTf: '5m', held: { count: b.length, first: b[0].t, last: b[b.length - 1].t },
  });
  assert.strictEqual(out.timeframe, '1h');
  assert.deepStrictEqual(out.rolledUp, { from: '5m', every: 12 });
});

test('a trade with no close cannot be replayed, and says so by returning nothing', () => {
  assert.strictEqual(R.spanFor({ ts: null }, null), null);
  assert.strictEqual(R.spanFor({ ts: 'not a date' }, null), null);
});

test('the window asked for brackets the trade with room either side', () => {
  const span = R.spanFor({ ts: '2026-09-09T16:00:00Z', openedAt: '2026-09-09T14:00:00Z' }, null);
  assert.ok(span.from < T('2026-09-09T14:00:00Z'));
  assert.ok(span.to > T('2026-09-09T16:00:00Z'));
});
