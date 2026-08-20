'use strict';

/**
 * The chart must stay the biggest thing on a trading screen.
 *
 * stock-trader.html lays the desk out as one CSS grid:
 *
 *   .layout  grid-template-columns: 44px  var(--col-l)  minmax(0,1fr)  var(--col-t)  var(--col-r)  44px
 *              draw rail    chat        CHART         order ticket   watchlist   widget rail
 *
 * Only the chart track is flexible, so it gets whatever the fixed tracks leave.
 * Those defaults total 1088px (44 + 360 + 320 + 320 + 44), which is fine on a
 * 1920px monitor and quietly awful on a laptop. Measured in a real browser against
 * the shipped page on 2026-08-18:
 *
 *   1920px viewport -> chart track 832px  (canvas 778) — healthy
 *   1440px viewport -> chart track 352px  (canvas 298) — NARROWER THAN THE CHAT PANEL
 *   1280px viewport -> chart track 192px  (canvas 138) — unusable
 *
 * 1280 and 1440 are the two most common laptop widths, so on a typical machine the
 * price chart is the smallest panel on a page whose entire purpose is the price
 * chart. Nothing caught it because every existing check either renders at 1920 or
 * asserts that elements merely EXIST.
 *
 * This test is arithmetic on the shipped CSS rather than a browser run: it is exact,
 * runs in milliseconds, and fails the moment someone widens a side panel or adds a
 * new fixed column without asking what it costs the chart.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'stock-trader.html');
const HTML = fs.readFileSync(PAGE, 'utf8');

/**
 * Read a column's default width.
 *
 * The dock widths are user-resizable and persisted, so `--dockl-w` and friends are
 * never *declared* in the stylesheet — they only appear as the fallback inside the
 * :root mapping, e.g. `--col-l:var(--dockl-w,360px)`. That fallback IS the default
 * a first-time visitor gets, which is what these budgets are about.
 */
function cssVarPx(col) {
  const root = HTML.match(/:root\{--col-l:[^}]*\}/);
  assert.ok(root, 'could not find the :root column mapping in stock-trader.html');
  const m = root[0].match(new RegExp(`--${col}\\s*:\\s*(?:var\\([^,]+,\\s*)?(\\d+)px`));
  assert.ok(m, `could not read the default width for --${col}`);
  return Number(m[1]);
}

/** The two 44px rails are literals in the grid declaration. */
function railWidths() {
  const m = HTML.match(/\.layout\{display:grid;grid-template-columns:(\d+)px var\(--col-l\) minmax\(0,1fr\) var\(--col-t\) var\(--col-r\) (\d+)px/);
  assert.ok(m, 'the .layout grid declaration changed shape — re-check the column model');
  return [Number(m[1]), Number(m[2])];
}

const CHAT = () => cssVarPx('col-l');
const TICKET = () => cssVarPx('col-t');
const WATCHLIST = () => cssVarPx('col-r');

/** The breakpoint under which the chat dock defaults to closed. */
function deskFullMinWidth() {
  const m = HTML.match(/const DESK_FULL_MIN_W = (\d+);/);
  assert.ok(m, 'the narrow-desk breakpoint (DESK_FULL_MIN_W) is gone — the chart can be squeezed again');
  return Number(m[1]);
}

/**
 * Chrome actually reserved at a given viewport.
 *
 * Below DESK_FULL_MIN_W the chat dock starts closed, so its track collapses to 0
 * (`body.leftdock-closed{--col-l:0px}`) and those pixels flow to the chart.
 */
function fixedChrome(viewport) {
  const [railL, railR] = railWidths();
  const chat = viewport < deskFullMinWidth() ? 0 : CHAT();
  return railL + railR + chat + TICKET() + WATCHLIST();
}

const chartTrackAt = (viewport) => viewport - fixedChrome(viewport);

test('the chart track is the only flexible column', () => {
  // If someone converts the chart to a fixed width, closing a panel can no longer
  // hand its pixels back — which was the entire premise of the #3360 layout.
  assert.match(HTML, /grid-template-columns:\d+px var\(--col-l\) minmax\(0,1fr\) var\(--col-t\) var\(--col-r\) \d+px/,
    'the chart column must stay minmax(0,1fr) so freed panel space flows to it');
});

test('closing every panel gives the chart the full width', () => {
  // The collapse rules are what make the desk usable on a small screen; if a
  // panel stops zeroing its track, its pixels are stranded.
  for (const [cls, v] of [['leftdock-closed', 'col-l'], ['ticket-closed', 'col-t'], ['rightdock-closed', 'col-r']]) {
    assert.ok(new RegExp(`body\\.${cls}\\{--${v}:0px\\}`).test(HTML),
      `body.${cls} must zero --${v} so the chart reclaims the space`);
  }
});

test('a 1920px desktop leaves the chart a healthy share', () => {
  const track = chartTrackAt(1920);
  assert.ok(track >= 700, `chart track ${track}px at 1920 — expected >= 700`);
});

test('the chart is never the smallest panel on a 1440px laptop', () => {
  // 1440 is a MacBook-class width. Measured today the chart track is 352px against
  // a 360px chat panel — the chart loses. A trading desk whose chart is narrower
  // than its chat sidebar has its priorities inverted.
  const track = chartTrackAt(1440);
  const widestPanel = Math.max(CHAT(), TICKET(), WATCHLIST());
  assert.ok(
    track >= widestPanel,
    `at 1440px the chart track is ${track}px but the widest side panel is ${widestPanel}px — ` +
    `the chart must not be the smallest region on a trading screen. ` +
    `Chrome reserved here is ${fixedChrome(1440)}px; narrow a panel, or close one by default below this width.`
  );
});

test('the chart stays usable on a 1280px laptop', () => {
  // Below this the candles stop being readable at all (measured: 138px of canvas).
  // 520px is roughly where a session's worth of 5m bars still reads.
  const track = chartTrackAt(1280);
  assert.ok(
    track >= 520,
    `at 1280px the chart track is only ${track}px (chrome ${fixedChrome(1280)}px). ` +
    `The price chart is the product; it cannot be the narrowest column. Options: ship a ` +
    `breakpoint that auto-closes the chat dock under ~1500px, or narrow the default panels.`
  );
});

test('total chrome leaves room on the narrowest supported desktop', () => {
  // A single guard on the sum, so adding a SIXTH fixed column is caught even if
  // each individual panel looks reasonable on its own.
  const chrome = fixedChrome(1280);
  assert.ok(
    chrome <= 760,
    `columns reserve ${chrome}px at 1280 (chat ${CHAT()} + ticket ${TICKET()} + watchlist ${WATCHLIST()} + rails). ` +
    `That leaves ${1280 - chrome}px for the chart.`
  );
});

test('a narrow desk closes the chat dock by default, and only by default', () => {
  // The fix must be a FIRST-VISIT default, not a lockout: someone on a 1280 laptop
  // who opens chat has to keep it across reloads, or we have taken away a feature
  // instead of choosing a sensible starting point.
  assert.match(HTML, /_lsGet\('trader\.leftOpen', _deskNarrow \? '0' : '1'\)/,
    'the chat dock default must be viewport-aware via _deskNarrow');
  assert.match(HTML, /_deskNarrow = \(typeof window[^)]*\)[^<]*< DESK_FULL_MIN_W/,
    'DESK_FULL_MIN_W must gate the narrow-desk default');
  // localStorage still supplies the value when present -> an explicit choice wins.
  assert.match(HTML, /let _leftOpen = _lsGet\('trader\.leftOpen'/,
    'the dock state must still come from persisted preference first');
});
