'use strict';
/**
 * test/trader-candle-density.test.js — candles at a consistent density (operator, 2026-09-13).
 *
 * Three things TradingView does that the chart now does too:
 *   1. a right margin of empty bar slots in front of the last candle, on by default, so
 *      the "future" is the same width whatever the interval;
 *   2. each range opens with the interval whose bars make it read at a consistent density
 *      (1D→1m, 5D→5m, 1M→30m, 3M→1h, 6M→2h, YTD/1Y→1d, 5Y→1w, All→1mo), the window is a
 *      SPAN measured against the bars, and a small card never draws sub-pixel candles;
 *   3. a range button is one click -- interval, window and price refit on every chart --
 *      and nothing stays lit or saved as a mode.
 *
 * Run: node --test apps/lantern-garage/test/trader-candle-density.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
// LF either way: a Windows checkout hands this file over with CRLF.
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');
const YAHOO = read('lib', 'market-data-yahoo.js');
const ROUTE = read('routes', 'trading', 'market.js');

// The tables, evaluated as written -- together, so SPAN_FOR_TF's entries ARE the RANGES rows.
const { RANGES, SPAN_FOR_TF } = new Function(
  PAGE.slice(PAGE.indexOf('const RANGES = {'), PAGE.indexOf('/* How many bars a span is')) + '; return { RANGES, SPAN_FOR_TF };')();

test('each range opens with the interval TradingView pairs it with', () => {
  assert.deepStrictEqual(Object.fromEntries(Object.entries(RANGES).map(([k, r]) => [k, r.tf])), {
    '1D': '1m', '5D': '5m', '1M': '30m', '3M': '1h', '6M': '2h', 'YTD': '1d', '1Y': '1d', '5Y': '1w', 'All': '1mo',
  });
  // And the spans: a session, a week, a month, a quarter, a half, a year, five, everything.
  assert.strictEqual(RANGES['1D'].days, 1);
  assert.strictEqual(RANGES['5D'].days, 5);
  assert.strictEqual(RANGES['1M'].days, 22);
  assert.strictEqual(RANGES['3M'].days, 64);
  assert.strictEqual(RANGES['6M'].days, 128);
  assert.strictEqual(RANGES['YTD'].ytd, true);
  assert.strictEqual(RANGES['1Y'].days, 252);
  assert.strictEqual(RANGES['5Y'].bars, 260);
  assert.ok(RANGES['All'].bars > 1000);
});

test('every interval has a span of its own, so a chosen interval reads at the same density', () => {
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1mo']) {
    const sp = SPAN_FOR_TF[tf];
    assert.ok(sp && (sp.days || sp.bars || sp.ytd), tf + ' has no span');
  }
  assert.strictEqual(SPAN_FOR_TF['1m'], RANGES['1D']);
  assert.strictEqual(SPAN_FOR_TF['30m'], RANGES['1M']);
  assert.strictEqual(SPAN_FOR_TF['2h'], RANGES['6M']);
});

test('the two new intervals exist end to end: select, allow-list, feed, route', () => {
  assert.match(PAGE, /const TF_ALLOWED = \['1m','5m','15m','30m','1h','2h','4h','1d','1w','1mo'\];/);
  assert.match(PAGE, /<option value="30m">30m<\/option>/);
  assert.match(PAGE, /<option value="2h">2h<\/option>/);
  assert.match(YAHOO, /'30m': \{ interval: '30m', range: '1mo', agg: 1 \}/);
  assert.match(YAHOO, /'2h': +\{ interval: '60m', range: '1y', +agg: 2 \}/, '2h is rolled from hourly, like 4h');
  assert.match(ROUTE, /new Set\(\['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1mo'\]\)/);
  // Everything that gates intraday-only behaviour reads the one list.
  assert.match(PAGE, /const _INTRADAY = \['1m','5m','15m','30m','1h','2h','4h'\];/);
  assert.strictEqual((PAGE.match(/\['1m','5m','15m','1h','4h'\]/g) || []).length, 0, 'a stale intraday list survives');
  assert.match(PAGE, /'30m':18e5, '1h':36e5, '2h':72e5/);
});

// ── the window is a span, measured against the bars ──────────────────────────

const _s0 = PAGE.indexOf('const MIN_BAR_PX = 2;');
const src = PAGE.slice(_s0, PAGE.indexOf('\n}\n', PAGE.indexOf('function _windowBars(', _s0)) + 3);
const build = (margin) => new Function('MIN_VISIBLE_BARS', '_etDayKey', '_slotsFor',
  src + '; return _windowBars;')(10, (ts) => String(ts).slice(0, 10).split('-').reverse().join('/').replace(/^(\d+)\/(\d+)\/(\d+)$/, '$2/$1/$3'), (n) => n + margin);
// Bars carry ISO timestamps; the stub day key turns 2026-09-11T10:00 into 9/11/2026 like Intl does.
const bars = (dates, perDay) => dates.flatMap((d) => Array.from({ length: perDay }, (_, i) => ({ timestamp: d + 'T' + String(9 + Math.floor(i / 12)).padStart(2, '0') + ':' + String((i % 12) * 5).padStart(2, '0'), close: 1 })));

test('a day span is the whole last session, however many bars it has', () => {
  const w = build(0);
  const b = bars(['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'], 78);
  assert.strictEqual(w(b, { days: 1 }, 0), 78);
  assert.strictEqual(w(b, { days: 3 }, 0), 234);
  assert.strictEqual(w(b, { days: 30 }, 0), 312, 'more days than there are: everything');
  // Extended hours simply make the session longer; the span is still the session.
  assert.strictEqual(w(bars(['2026-09-10', '2026-09-11'], 190), { days: 1 }, 0), 190);
});

test('YTD is this year’s bars; weekly and monthly spans are counts', () => {
  const w = build(0);
  // Three sessions of last year, then twelve of this one (the floor is ten bars, so a
  // year with fewer than that would read as the floor, not as the year).
  const thisYear = Array.from({ length: 12 }, (_, i) => '2026-01-' + String(2 + i).padStart(2, '0'));
  const b = bars(['2025-12-29', '2025-12-30', '2025-12-31'].concat(thisYear), 1);
  assert.strictEqual(w(b, { ytd: true }, 0), 12);
  assert.strictEqual(w(bars(['2026-09-11'], 300), { bars: 260 }, 0), 260);
  assert.strictEqual(w(bars(['2026-09-11'], 300), { bars: 99999 }, 0), 300);
});

test('a narrow chart shows the recent part of the span rather than sub-pixel candles', () => {
  /* The candle's size matters more than the span: at MIN_BAR_PX per bar a 340px card
     holds ~170 slots, and the right margin's empty slots are part of that width. */
  const w = build(25);
  const b = bars(['2026-09-11'], 390);              // a 1m session
  assert.strictEqual(w(b, { days: 1 }, 1850), 390, 'a wide chart shows the whole session');
  assert.strictEqual(w(b, { days: 1 }, 340), 170 - 25, 'a small card is clamped, margin included');
  assert.strictEqual(w(b, { days: 1 }, 0), 390, 'no width known: no clamp');
  assert.strictEqual(w([], { days: 1 }, 340), 10, 'no bars: the floor');
});

test('the window stays span-driven until the reader zooms or pans, and comes back on axis reset', () => {
  assert.match(PAGE, /if\(bars\.length > 0 && \(view\.visibleBars == null \|\| view\.spanDriven\)\)\{/);
  assert.match(PAGE, /view\.visibleBars = _windowBars\(bars, view\.span \|\| SPAN_FOR_TF\[chartTimeframe\] \|\| SPAN_FOR_TF\['5m'\], _pw\);/);
  assert.strictEqual((PAGE.match(/view\.spanDriven = false;/g) || []).length, 2, 'zoom and pan each end the span');
  assert.match(PAGE, /view\.visibleBars = null; view\.spanDriven = true;/, 'the axis double-click does not return to the span');
  assert.ok(!PAGE.includes('DEFAULT_VIS'), 'the old per-interval bar counts are still there');
});

// ── the buttons are actions, not modes ──────────────────────────────────────

test('a range click sets interval and span on every chart, refits the price scale, and remembers nothing as a mode', () => {
  assert.match(PAGE, /function changeRange\(range\)\{\s*const r = RANGES\[range\]; if\(!r\) return;\s*changeTimeframe\(r\.tf, r\);\s*\}/);
  const ct = PAGE.slice(PAGE.indexOf('function changeTimeframe(tf, span){'), PAGE.indexOf('function changeRange('));
  assert.match(ct, /v\.visibleBars=null; v\.span=span\|\|null; v\.spanDriven=true;/);
  assert.match(ct, /v\.yMin=null; v\.yMax=null; v\.gYMin=null; v\.gYMax=null;/, 'the price scale is not refitted');
  assert.ok(!PAGE.includes("'trader.range'"), 'the range is still saved as a mode');
  assert.ok(!PAGE.includes('activeRange'), 'a button still tracks being lit');
  assert.ok(!PAGE.includes('aria-pressed="\' + (k'), 'a button still claims a pressed state');
  assert.ok(!PAGE.includes('function syncRangeButtons'));
  // The interval itself IS remembered, as it always was.
  assert.match(ct, /localStorage\.setItem\('trader\.tf', tf\)/);
});

test('the right margin is on by default and every bar-to-pixel mapping includes it', () => {
  assert.match(PAGE, /function _slotsFor\(n\)\{ const r = _cs\('canvas\.marginRight'\); const m = r == null \? 25 : Number\(r\) \|\| 0; return n \+ Math\.max\(0, Math\.min\(60, Math\.round\(m\)\)\); \}/);
  assert.doesNotMatch(PAGE, /slotW = pw\s*\/\s*n;/);
});
test('regular hours by default, with the RTH/ETH switch on the strip', () => {
  /* The densities above are the regular session's -- 1D at 1m is 390 candles, not the
     837 an extended day has. TradingView shows RTH by default and keeps the switch in the
     strip's corner; so does this, and it is the same setting as Settings › Symbol › Session. */
  const strip = PAGE.slice(PAGE.indexOf('<div class="range-strip"'), PAGE.indexOf('<!-- Footer -->'));
  assert.match(strip, /<button type="button" class="range-sess" id="rangeSess" aria-pressed="false" onclick="toggleSession\(\)"/);
  assert.match(PAGE, /function toggleSession\(\)\{\s*if\(!_CS\) return;\s*_CS\.set\('data\.session', _cs\('data\.session'\) === 'extended' \? 'regular' : 'extended'\);/);
  assert.match(PAGE, /b\.textContent = ext \? 'ETH' : 'RTH';/);
  // A session change re-measures every span-driven window: the bars themselves changed.
  assert.match(PAGE, /if\(keys\.indexOf\('data\.session'\) !== -1\)\{\s*_renderSessBadge\(\);/);
});

