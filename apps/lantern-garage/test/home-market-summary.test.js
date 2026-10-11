'use strict';
/**
 * test/home-market-summary.test.js — the home page's market summary (founder, 2026-10-11:
 * "market summary > see major indices > see all crypto … have links that lead to their own
 * pages").
 *
 * TradingView's home strip, ours: one market at a time — indices, crypto, futures, forex,
 * the economy — each with the "See all" that leads to its own page, drawn with the same
 * tiles and the same data as /markets.html so a price reads alike on both.
 *
 * Run: node --test apps/lantern-garage/test/home-market-summary.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HOME = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('each market in the summary has the "See all" that leads to its own page', () => {
  const want = [
    ['Indices', 'See major indices', '/market.html?c=indices'],
    ['Crypto', 'See all crypto', '/market.html?c=crypto&g=coins'],
    ['Futures', 'See all futures', '/market.html?c=futures'],
    ['Forex', 'See all major pairs', '/market.html?c=forex&g=majors'],
    ['Economy', 'See the US economy', '/market.html?c=economy'],
  ];
  for (const [label, all, href] of want) {
    assert.ok(HOME.includes(`label: '${label}', all: '${all}', href: '${href}'`), label);
  }
  assert.match(HOME, /all\.textContent = _msum\.all;\s*\n\s*all\.href = _msum\.href;/, 'the link follows the tab');
});

test('it draws with the markets pages’ own tiles and data — not a second copy', () => {
  assert.match(HOME, /<script src="\/js\/market-ui\.js"><\/script>\s*\n\s*\n<script>/, 'loaded before the page script');
  assert.match(HOME, /box\.appendChild\(U\.tile\(r\)\)/);
  assert.match(HOME, /box\.appendChild\(U\.econTile\(ind, /);
  assert.match(HOME, /get\('\/api\/trading\/markets'\)/);
  assert.match(HOME, /get\('\/api\/trading\/markets\?c=economy'\)/);
});

test('it lives in the Markets section, above the watchlist cards', () => {
  const sec = HOME.slice(HOME.indexOf('<h2 id="mkt-h">Markets</h2>'), HOME.indexOf('<!-- ── News ── -->'));
  assert.ok(sec.indexOf('id="msum"') > 0 && sec.indexOf('id="msum"') < sec.indexOf('id="mkt"'));
  // A market that could not be priced says so; it never draws an empty strip.
  assert.match(HOME, /'Nothing could be priced just now\.'/);
  assert.match(HOME, /'The economic figures are not available just now\.'/);
});
