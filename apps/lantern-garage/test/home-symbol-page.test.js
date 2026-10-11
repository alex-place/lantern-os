'use strict';
/**
 * test/home-symbol-page.test.js — the home page's tickers lead somewhere about the ticker
 * (founder, 2026-10-11: "all of the links lead to the trader page").
 *
 * Every row in the Markets grid and every engine verdict panel set `href =
 * '/stock-trader.html'` — a bare link with no symbol on it, so clicking AAPL and clicking
 * TSLA arrived at the same screen. TradingView's equivalent is a page per symbol, and
 * that is what /symbol.html is.
 *
 * Two things here are load-bearing beyond "the link works":
 *
 *   PUBLIC. The symbol page is the destination of a link on a PUBLIC page. Gating it
 *   would 302 a signed-out visitor to sign-in and drop the symbol they clicked — the
 *   bounce #2610 (pricing) and #3161 (FAQ) were both filed for.
 *
 *   NO POSITION SIZES. /api/trading/zones carries a `position` field. index.html refuses
 *   to render it because it would publish operator position sizes to anonymous visitors;
 *   a second public page reading the same payload has to refuse it too.
 *
 * Run: node --test apps/lantern-garage/test/home-symbol-page.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8').replace(/\r\n/g, '\n');
const HOME = read('index.html');
const SYM = read('symbol.html');
const CSS = read('css/market.css');
const PAGES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pages.js'), 'utf8').replace(/\r\n/g, '\n');

test('every ticker on the home page leads to that ticker, not to the bare terminal', () => {
  assert.match(HOME, /a\.href = '\/symbol\.html\?t=' \+ encodeURIComponent\(r\.ticker\);/,
    'the Markets rows');
  assert.match(HOME, /a\.href = '\/symbol\.html\?t=' \+ encodeURIComponent\(symbol\);/,
    'the engine verdict panels');
  // The links that SHOULD still go to the terminal are the ones that are about acting,
  // not about a symbol: the hero CTA and the product card.
  assert.match(HOME, /href="\/stock-trader\.html"/, 'the terminal is still linked');
  assert.doesNotMatch(HOME, /el\('a', 'row'\);\s*a\.href = '\/stock-trader\.html'/, 'no bare row link left');
});

test('the symbol page is PUBLIC — it is the destination of a link on a public page', () => {
  const pub = PAGES.slice(PAGES.indexOf('const PUBLIC_PAGES = {'), PAGES.indexOf('const PROTECTED_PAGES'));
  assert.match(pub, /"\/symbol\.html":\s*"symbol\.html"/, 'gating it drops the symbol the visitor clicked');
  // and it must NOT also be listed as protected, which would be ambiguous
  const prot = PAGES.slice(PAGES.indexOf('const PROTECTED_PAGES'));
  assert.doesNotMatch(prot, /"\/symbol\.html"/);
});

test('it never publishes operator position sizes', () => {
  // index.html states the rule; this page reads the same /zones payload and must obey it.
  assert.doesNotMatch(SYM, /\.position\b/, 'the position field must not be read at all');
  assert.match(SYM, /position.*never read here|never read here.*position/is,
    'and the refusal is written down, so the next edit knows why');
});

test('the ticker from the URL is refused rather than escaped', () => {
  // It lands in fetch URLs, the document title and the DOM, so anything that is not a
  // plain symbol never becomes any of those. Verified in the browser: ?t=<img src=x
  // onerror=alert(1)> rendered as the text IMGSRCXONERR and injected nothing.
  assert.match(SYM, /replace\(\/\[\^A-Z0-9\.\\-\]\/g, ''\)/, 'a strict allowlist, not an escape');
  assert.match(SYM, /\.slice\(0, 12\)/, 'and a length bound');
  // Nothing is ever written as markup. innerHTML appears only to CLEAR a box; every
  // value that reaches the DOM goes through textContent, so there is no sink to escape.
  const writes = SYM.match(/innerHTML\s*=\s*[^;]+/g) || [];
  assert.ok(writes.length > 0, 'expected the clears to be found at all');
  for (const w of writes) assert.match(w, /innerHTML\s*=\s*''\s*$/, 'computed innerHTML: ' + w);
});

test('an absent figure reads as absent, never as zero', () => {
  // The honesty rule the home page set: a number the server does not have is an em dash.
  assert.match(SYM, /if \(!isFinite\(v\)\) return '—';/);
  assert.match(SYM, /No price history for/);
  assert.match(SYM, /No statistics are available for/);
  assert.match(SYM, /No stories mentioning/);
  // A symbol the engine does not scan says so rather than implying it was rejected.
  assert.match(SYM, /is not on the engine’s tradelist, so it is not scored/);
});

test('the engine panel is named for what it is', () => {
  // The home page's standing rule: the scoring engine is never called AI.
  assert.match(SYM, /Deterministic technical analysis plus a hand-weighted linear model — not a language model/);
  assert.doesNotMatch(SYM.slice(SYM.indexOf("What the engine sees")), /\bAI\b/);
});

test('the design system is shared, not copied', () => {
  // 197 lines of components lived inside index.html. A second page needed them, and two
  // copies would have drifted on the first edit.
  assert.match(HOME, /<link rel="stylesheet" href="\/css\/market\.css">/);
  assert.match(SYM, /<link rel="stylesheet" href="\/css\/market\.css">/);
  assert.doesNotMatch(HOME, /<style>/, 'the home page no longer carries its own copy');
  for (const cls of ['.band', '.card', '.sec-head', '.row', '.nrow', '.chip', '.num'])
    assert.ok(CSS.includes(cls + ' ') || CSS.includes(cls + '{') || CSS.includes(cls + ','),
      'market.css lost ' + cls);
  // New rules go at the END so relocating never restyles what already shipped.
  assert.ok(CSS.indexOf('Symbol view (symbol.html') > CSS.indexOf('.band {'),
    'the symbol rules must come after the home page rules');
});

test('the page says which window the chart covers', () => {
  // A range switcher that silently showed a different span than its label would be worse
  // than no switcher: the subtitle is derived from the bars that actually came back.
  assert.match(SYM, /bars\.length \+ ' bars · '/);
  assert.match(SYM, /' over ' \+ curRange/);
  assert.match(SYM, /\{ id: '1D'/);
  assert.match(SYM, /\{ id: '5Y'/);
});
