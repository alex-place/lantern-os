'use strict';

/**
 * The feed-glitch wick sanitizer is load-bearing and, until now, untested.
 *
 * The keyless Yahoo feed ships intraday bars contaminated by stale pre/after-hours
 * quotes: a tiny body with one monstrous ONE-SIDED wick. Measured live on
 * 2026-08-18 against our own /api/trading/bars-multi at 1h — SPY 7.3% of bars over
 * 4x the median span, GLD 9.9%, and tails that are not typos: SOXS 3332x, TZA 728x.
 * Rendered raw, a single such bar blows the auto-range open and the chart becomes a
 * flat line under one full-height spike.
 *
 * stock-trader.html defends against this in TWO places that must agree:
 *
 *   renderChart      — clamps the drawn candle and the VWAP typical price
 *   renderZoneLadder — clamps the AUTO-RANGE
 *
 * If only one is fixed, the failure is worse than no fix: the range is set from a
 * bogus extreme while the candles are drawn sane, so the chart silently rescales
 * around a wick nobody can see. That divergence is the regression this file exists
 * to catch, and it is exactly the kind a 900-line UI refactor (#3360) can introduce
 * without any test noticing.
 *
 * The rule, in both places:
 *   intraday timeframes only  (a >4x wick on a DAILY can be a real crash day)
 *   one-sided wick > 4 x median span  ->  clamp that side to body +/- one median
 *
 * These tests evaluate the SHIPPED source text rather than a re-implementation —
 * a copy of the rule in the test could drift from the page and still pass.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'stock-trader.html');
const HTML = fs.readFileSync(PAGE, 'utf8');

const INTRADAY = ['1m', '5m', '15m', '1h', '4h'];

/**
 * Pull the `saneHiLo` arrow out of renderChart and make it callable.
 *
 * It closes over `_wdet` (the 4x threshold) and `_med2` (the clamp distance), so
 * the extracted source is evaluated inside a factory that supplies both as
 * parameters. This runs the SHIPPED expression — not a copy of it — so a change to
 * the page's logic changes what these tests exercise.
 */
function extractRenderChartSanitizer() {
  const m = HTML.match(/const saneHiLo = (b => \{[\s\S]*?return \{[\s\S]*?\};\s*\});/);
  assert.ok(m, 'renderChart lost its saneHiLo sanitizer — glitch wicks will render raw');
  const factory = new Function('_wdet', '_med2', `return (${m[1]});`);
  return (bar, wdet, med) => factory(wdet, med)(bar);
}

/** The renderZoneLadder copy is inline in a loop, so assert its source shape. */
function zoneLadderSource() {
  const m = HTML.match(/const _wickDet = [\s\S]{0,900}?_kept\+\+;/);
  assert.ok(m, 'renderZoneLadder lost its auto-range wick clamp');
  return m[0];
}

test('both render paths still carry a wick sanitizer', () => {
  assert.ok(/const saneHiLo = b => \{/.test(HTML), 'renderChart sanitizer missing');
  assert.ok(/const _wickDet =/.test(HTML), 'renderZoneLadder auto-range clamp missing');
});

test('both paths use the SAME 4x threshold and 1-median clamp', () => {
  // Drift between the two is the dangerous state: range set from a bogus extreme
  // while candles draw sane.
  const chart = HTML.match(/const _wdet = [^\n]*\n/)[0];
  const ladder = HTML.match(/const _wickDet = [^\n]*\n/)[0];
  assert.match(chart, /\*\s*4\b/, 'renderChart threshold is no longer 4x the median span');
  assert.match(ladder, /\*\s*4\b/, 'renderZoneLadder threshold is no longer 4x the median span');

  // Clamp distance: body +/- exactly ONE median span, in both.
  assert.match(HTML, /hi:\(b\.high-bh>_wdet\)\?\s*bh\+_med2/, 'renderChart no longer clamps to body + 1 median');
  assert.match(HTML, /lo:\(bl-b\.low>_wdet\)\?\s*bl-_med2/, 'renderChart no longer clamps to body - 1 median');
  const z = zoneLadderSource();
  assert.match(z, /bodyHi\+_medSpan/, 'renderZoneLadder no longer clamps to body + 1 median');
  assert.match(z, /bodyLo-_medSpan/, 'renderZoneLadder no longer clamps to body - 1 median');
});

test('sanitizing is INTRADAY-ONLY, identically in both paths (#trader-candles v2)', () => {
  // A >4x wick on a daily bar can be a real crash day and must render honestly.
  // If one path starts sanitizing dailies and the other does not, they disagree.
  // Both sanitizers must be gated on an intraday check. (A third guard with the
  // same list drives the "ET" timescale label — a different concern that shares
  // the definition, so it is not required to be a sanitizer.)
  assert.match(HTML, /const _sanitizing = \[[^\]]+\]\.indexOf\(timeframe\)\s*!==\s*-1/,
    'renderChart sanitizing is no longer gated on an intraday check');
  assert.match(HTML, /const _saneTf = \[[^\]]+\]\.indexOf\(chartTimeframe\)\s*!==\s*-1/,
    'renderZoneLadder sanitizing is no longer gated on an intraday check');

  // Every copy of the list must be byte-identical. Divergence is the bug: one path
  // would sanitize a timeframe another renders raw, and the range would be set
  // from an extreme the candles never show.
  const lists = [...HTML.matchAll(/\[((?:'[0-9a-z]+',?)+)\]\.indexOf\((?:timeframe|chartTimeframe)\)\s*!==\s*-1/g)]
    .map((m) => m[1]);
  assert.ok(lists.length >= 2, 'expected at least the two sanitizer intraday guards');
  assert.strictEqual(new Set(lists).size, 1,
    `intraday timeframe lists have diverged across render paths: ${[...new Set(lists)].join('  VS  ')}`);

  // And the shared definition must still exclude daily+.
  const tfs = lists[0].split(',').map((s) => s.replace(/'/g, ''));
  assert.deepStrictEqual(tfs, INTRADAY, 'the intraday set changed — confirm this is intended');
  for (const tf of ['1d', '1w', '1mo']) {
    assert.ok(!tfs.includes(tf), `${tf} must never be sanitized — a big daily wick can be real`);
  }
  for (const tf of ['1d', '1w', '1mo']) {
    assert.ok(!INTRADAY.includes(tf), `${tf} must never be sanitized — a big daily wick can be real`);
  }
});

test('the shipped clamp actually tames a real measured glitch', () => {
  const saneHiLo = extractRenderChartSanitizer();
  const med = 2.11;          // SPY 1h median span, measured live 2026-08-18
  const wdet = med * 4;

  // A real shape from the feed: tiny body, monstrous one-sided LOW wick.
  const glitch = { open: 767.90, close: 767.89, high: 767.96, low: 701.05 };
  const out = saneHiLo(glitch, wdet, med);
  assert.ok(out.lo > glitch.low, 'the bogus low must be clamped up');
  assert.strictEqual(+out.lo.toFixed(4), +(Math.min(glitch.open, glitch.close) - med).toFixed(4),
    'clamped low should sit exactly one median below the body');
  assert.strictEqual(out.hi, glitch.high, 'the healthy high must be left alone');

  // The same shape inverted — a bogus HIGH.
  const up = saneHiLo({ open: 767.90, close: 767.89, high: 840.00, low: 767.70 }, wdet, med);
  assert.strictEqual(+up.hi.toFixed(4), +(767.90 + med).toFixed(4), 'clamped high should sit one median above the body');
  assert.strictEqual(up.lo, 767.70, 'the healthy low must be left alone');
});

test('an ordinary bar passes through untouched', () => {
  const saneHiLo = extractRenderChartSanitizer();
  const med = 2.11, wdet = med * 4;
  // Wicks well inside 4x — a normal bar must not be "corrected".
  const normal = { open: 767.20, close: 768.40, high: 769.90, low: 766.10 };
  const out = saneHiLo(normal, wdet, med);
  assert.strictEqual(out.hi, normal.high, 'a <4x upper wick must render raw');
  assert.strictEqual(out.lo, normal.low, 'a <4x lower wick must render raw');
});

test('a wick exactly at the 4x boundary is NOT clamped', () => {
  // Strictly greater-than, so the boundary case renders raw. Pinning this stops a
  // future >= from quietly eating legitimate wicks across the whole watchlist.
  const saneHiLo = extractRenderChartSanitizer();
  const med = 2.0, wdet = med * 4;
  const body = 100;
  const at = saneHiLo({ open: body, close: body, high: body + wdet, low: body - wdet }, wdet, med);
  assert.strictEqual(at.hi, body + wdet, 'a wick exactly 4x the median must survive');
  assert.strictEqual(at.lo, body - wdet, 'a wick exactly 4x the median must survive');
});

test('with no usable median the sanitizer is disabled, not zeroed', () => {
  // Flat/empty windows give median 0. The page sets the threshold to Infinity in
  // that case; if it ever became 0 instead, EVERY wick would be clamped to the
  // body and every candle would collapse to a bar. Assert the guard is present.
  assert.match(HTML, /_wdet = \(_sanitizing && _med2>0\) \? _med2\*4 : Infinity/,
    'renderChart must disable sanitizing (Infinity) when there is no median span');
  assert.match(HTML, /_wickDet = \(_saneTf && _medSpan>0\) \? _medSpan\*4 : Infinity/,
    'renderZoneLadder must disable sanitizing (Infinity) when there is no median span');

  const saneHiLo = extractRenderChartSanitizer();
  const out = saneHiLo({ open: 5, close: 5, high: 9, low: 1 }, Infinity, 0);
  assert.strictEqual(out.hi, 9, 'disabled sanitizer must pass the high through');
  assert.strictEqual(out.lo, 1, 'disabled sanitizer must pass the low through');
});
