'use strict';
/**
 * test/home-load-budget.test.js — what the home page asks the server for, and what it
 * does with the answers (operator pass, 2026-11-03).
 *
 * Five defects are pinned here. Each was measured on the running server before the fix,
 * and each is the kind that comes back silently the next time this code is touched:
 *
 *   ONE-SHOT ZONES. /api/trading/zones was fetched exactly once. The scan cache is cold
 *   right after a deploy and for the first visitor of the morning, and in that window the
 *   book renders empty and the ranked-signals block stays hidden — permanently, until the
 *   reader reloads by hand. It is the state a brand-new visitor is most likely to hit.
 *
 *   THE SERVER'S OWN WORDS. The same response carries `available`, `failed` and `reason`
 *   so a reader can tell "still warming up" from "the market backend is down" from "a real
 *   pass that scored nothing". All three used to print one sentence.
 *
 *   THE GATE IS CONFIG, NOT DATA. It shipped only on the warm branch, so a cold scan hid
 *   the signals list while the sentence above it read "a linear model over the signals
 *   listed below" — pointing at nothing.
 *
 *   THE WIRE. One load pulled 811 KB over 25 requests: 276 KB of news to draw six rows,
 *   182 KB of economy figures for a tab nobody had clicked, and 115 KB of sparkline bars
 *   that CSS hides under 401px. Measured after: 359 KB desktop, 245 KB phone.
 *
 *   FOCUS. The 60s market re-render rebuilds #mkt wholesale, so a focused control is
 *   removed from the document and the focus falls back to <body> — a keyboard user is
 *   thrown to the top of the page once a minute.
 *
 * Run: node --test apps/lantern-garage/test/home-load-budget.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n');
const HOME = read('public/index.html');
const SYMBOL = read('public/symbol.html');
const ZONES = read('routes/trading/market.js');
const NEWS = read('routes/trading/news.js');

test('the engine is polled until it answers, not asked once', () => {
  assert.match(HOME, /function loadZones\(\)/, 'the fetch is a function so it can be repeated');
  assert.match(HOME, /setTimeout\(loadZones, \d+\)/, 'it re-asks while the scan is warming');
  // Bounded: a page left open on a broken backend must not poll for ever.
  assert.match(HOME, /_zoneTries < \d+/, 'with a retry ceiling');
  assert.match(HOME, /visibilitychange/, 'and re-reads when the tab comes back');
});

test('the page repeats the server\'s reason instead of flattening three states into one', () => {
  // The server distinguishes them...
  assert.match(ZONES, /available: false, reason: 'market scan warming up/, 'cold');
  assert.match(ZONES, /available: false, failed: true/, 'backend down');
  // ...so the page must read them.
  assert.match(HOME, /SCAN_STATE = \{ available: d\.available, failed: !!d\.failed, reason: d\.reason/,
    'the page keeps all three fields');
  assert.match(HOME, /st\.failed/, 'and branches on a failure');
  assert.doesNotMatch(
    HOME.slice(HOME.indexOf('if (!picks.length)')), /^\s*box\.appendChild\(el\('div', 'state', 'The engine has not scored anything on this pass\.'\)\);/m,
    'the unconditional one-liner is gone');
});

test('the gate is static config and ships on every branch of /zones', () => {
  // Hoisted into one helper and applied to the cold, failed and warm responses alike --
  // otherwise "the signals listed below" points at an empty block whenever the scan is cold.
  assert.match(ZONES, /const engineGate = \(\) =>/, 'one definition');
  assert.match(ZONES, /const withGate = \(body\) =>/, 'one wrapper');
  // The two early returns -- cold cache and failed scan -- are the ones that used to
  // answer without a gate. The warm branch calls engineGate() directly (below).
  const calls = ZONES.match(/sendJson\(res, withGate\(/g) || [];
  assert.strictEqual(calls.length, 2, `the cold and failed branches must both send the gate, saw ${calls.length}`);
  assert.match(ZONES, /var gate = engineGate\(\);/, 'the warm branch reuses it rather than keeping a copy');
  // And still no coefficients on this public read.
  assert.doesNotMatch(ZONES, /weights: evmod\.WEIGHTS/, 'the coefficients stay out of a public response');
});

test('the news window is narrowed on the wire, not in the browser', () => {
  assert.match(NEWS, /url\.searchParams\.get\('symbols'\)/, 'the server filters by symbol');
  assert.match(NEWS, /url\.searchParams\.get\('sinceHours'\)/, 'and by age');
  assert.match(NEWS, /scanned/, 'and reports the window it filtered, so the page can still count it');
  // A story with no date must survive the age cut rather than be hidden over a missing field.
  assert.match(NEWS, /Number\.isNaN\(t\) \? true : t >= cutoff/, 'a missing date is kept');
  assert.match(HOME, /sinceHours=168/, 'the page asks for a week');
  assert.match(HOME, /'&symbols=' \+ encodeURIComponent\(syms\.join\(','\)\)/, 'and names the funds it scores');
  assert.doesNotMatch(HOME, /get\('\/api\/trading\/news\/recent\?limit=200'\)/, 'the unfiltered pull is gone');
});

test('nothing is fetched for a tab nobody opened, or for an element CSS hides', () => {
  assert.match(HOME, /function loadEcon\(\)/, 'the economy figures load on demand');
  assert.match(HOME, /if \(_msum\.id === 'economy'\) loadEcon\(\);/, 'when that tab is selected');
  assert.match(HOME, /_econAsked/, 'and only once');
  // market.css hides .spark under 401px, so the bars behind it are pure waste there.
  assert.match(HOME, /withSpark && window\.innerWidth > 400/, 'no sparkline bars at phone width');
  const CSS = read('public/css/market.css');
  assert.match(CSS, /@media \(max-width: 400px\) \{ \.spark \{ display: none; \} \}/,
    'the width the JS checks must be the width the CSS hides at');
});

test('the 60s re-render puts the keyboard back where it was', () => {
  assert.match(HOME, /var keep = \(ae && box\.contains\(ae\)\) \? ae\.getAttribute\('data-fkey'\) : null;/,
    'it remembers what was focused');
  assert.match(HOME, /box\.querySelector\('\[data-fkey="' \+ keep \+ '"\]'\)/, 'and finds it again');
  // Both controls in the row need a stable key or only one of them survives.
  assert.match(HOME, /a\.setAttribute\('data-fkey', 'row:' \+ r\.ticker\)/, 'the row has one');
  assert.match(HOME, /rgo\.setAttribute\('data-fkey', 'go:' \+ r\.ticker\)/, 'the action has one');
});

test('a news symbol is a link to that symbol, not decoration', () => {
  // They were spans inside the row's anchor: they inherited cursor:pointer, looked
  // clickable, and navigated to the story. An <a> may not contain an <a>, so the row
  // had to stop being one.
  assert.match(HOME, /var a = el\('div', 'nrow'\);/, 'the row is not an anchor');
  assert.match(HOME, /var h = el\('a', 'nh',/, 'the headline carries the story link');
  assert.match(HOME, /cs\.href = '\/symbol\.html\?t=' \+ encodeURIComponent\(s\);/, 'the chip carries the symbol link');
  // NOT the trader: a story can name a symbol that is not on the watchlist, and the
  // trader has no bars for one -- it would silently land the reader on SPY.
  assert.doesNotMatch(HOME, /cs\.href = '\/stock-trader\.html/, 'a news symbol never goes to the trader');
});

test('bars are sent at float32 precision, not float64 artefact', () => {
  // A close of $773.09 was going out as 773.0900268554688: eighteen characters, twelve of
  // them an artefact of widening a float32 to a float64. The cut has to be SIGNIFICANT
  // DIGITS -- toFixed(6) still yields 773.090027, and a fixed decimal scale would wreck
  // crypto, whose significant digits start six places in.
  assert.match(ZONES, /v\.toPrecision\(7\)/, 'seven significant digits == float32 precision');
  // The CODE form, not the words: the comment beside it explains why toFixed(6) fails.
  assert.doesNotMatch(ZONES, /Number\(v\.toFixed\(/, 'decimal rounding does not remove the artefact');
  // Volume is an exact count; 7 significant digits would round 123456789 to 123456800.
  assert.match(ZONES, /Number\.isInteger\(v\)/, 'integers are left alone');
});

test('a line chart can ask for closes instead of full OHLCV', () => {
  assert.match(ZONES, /url\.searchParams\.get\('fields'\) \|\| ''\) === 'close'/, 'the compact form exists');
  assert.match(ZONES, /closes: window\.map/, 'it sends bare numbers');
  // spanLabel needs the window, and only its two ends -- not a 24-character timestamp
  // repeated on all 120 bars.
  assert.match(ZONES, /t0: window\.length \? window\[0\]\.timestamp : null/, 'with the window start');
  assert.match(ZONES, /t1: window\.length \? window\[window\.length - 1\]\.timestamp : null/, 'and its end');
  // Opt-in: anything already calling this keeps the shape it had.
  assert.match(ZONES, /bars: window\.map\(\(b\) => \{ const o = \{\}/, 'the default response is unchanged in shape');
});

test('both pages that draw a line ask for the compact form', () => {
  assert.match(HOME, /'&fields=close'/, 'the home page');
  assert.match(SYMBOL, /'&fields=close'/, 'the symbol page');
  // And they read the compact shape, not the old one.
  assert.match(HOME, /closes: \(d && d\.closes\) \|\| \[\]/, 'the home page reads closes');
  assert.match(HOME, /var t0 = Date\.parse\(b\.t0\), t1 = Date\.parse\(b\.t1\);/, 'and the window from t0/t1');
  assert.doesNotMatch(HOME, /bs\[0\]\.timestamp/, 'no per-bar timestamp read is left behind');
  assert.match(SYMBOL, /var closes = \(\(d && d\.closes\) \|\| \[\]\)/, 'the symbol page reads closes');
});

test('the note accounts for the two inputs that really are models', () => {
  // The signals list names "Grok analyst conviction" and "Claude analyst conviction" a
  // few lines below, so "arithmetic, not a language model" was not the whole truth.
  assert.doesNotMatch(HOME, /arithmetic, not a language model/, 'the old absolute claim is gone');
  assert.match(HOME, /model opinions/, 'the note says which inputs are model-derived');
  assert.match(HOME, /nothing a model says can change the\s+arithmetic/, 'and what that does not change');
});
