'use strict';
/**
 * test/movers-board.test.js — the movers board, and what it is honest about
 * (founder, 2026-10-11: "the big moves").
 *
 * The home page's "Markets" heading led to /stock-trader.html like every other link on
 * the page. It leads here now.
 *
 * The thing worth pinning is not that it sorts — it is what the page CLAIMS. We have no
 * screener: the quote client prices a list you hand it, so this ranks a curated universe
 * and must say so rather than implying it swept the exchange. A board that silently
 * implied market-wide coverage would be the most plausible lie on the site.
 *
 * Run: node --test apps/lantern-garage/test/movers-board.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { UNIVERSE, kindOf, LEVERAGED } = require('../lib/market-universe');
const PUB = path.join(__dirname, '..', 'public');
const PAGE = fs.readFileSync(path.join(PUB, 'markets.html'), 'utf8').replace(/\r\n/g, '\n');
const HOME = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MARKET = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading', 'market.js'), 'utf8').replace(/\r\n/g, '\n');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const PAGES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pages.js'), 'utf8').replace(/\r\n/g, '\n');

test('the universe is a real list, with no duplicates', () => {
  assert.ok(UNIVERSE.length >= 100, 'a board over a handful of names is the home grid again');
  assert.strictEqual(new Set(UNIVERSE).size, UNIVERSE.length, 'duplicates would double-rank a symbol');
  for (const s of UNIVERSE) assert.match(s, /^[A-Z][A-Z0-9.\-]*$/, 'not a plain symbol: ' + s);
});

test('a leveraged fund is labelled, not hidden', () => {
  // A 3x fund's 9% day is not the same event as a stock's. Excluding them would make the
  // board lie by omission on the engine's own names; labelling keeps it complete.
  for (const s of LEVERAGED) assert.strictEqual(kindOf(s), 'leveraged', s);
  assert.strictEqual(kindOf('AAPL'), 'stock');
  assert.strictEqual(kindOf('SPY'), 'etf');
  assert.match(PAGE, /el\('span', 'chip', '3x'\)/, 'the page must show the label');
});

test('the page says which universe it ranked — it does not imply the whole market', () => {
  assert.match(PAGE, /not the whole exchange/);
  assert.match(PAGE, /there is no screener behind this/);
  // and it reports the count it actually priced, so a half-failed fetch is visible
  assert.match(PAGE, /' of ' \+ \(d\.universe \|\| 0\) \+ ' priced'/);
});

test('all boards are cut from ONE snapshot', () => {
  // Three fetches could disagree about a price and show a symbol as both a top gainer
  // and a loser. One getQuotes call feeds every ranking.
  const route = MARKET.slice(MARKET.indexOf("'/api/trading/movers'"), MARKET.indexOf("symbol-stats?ticker="));
  assert.strictEqual((route.match(/getQuotes\(/g) || []).length, 1, 'exactly one quote fetch');
  assert.match(route, /const moved = rows\.filter/, 'both rankings read the same rows');
});

test('there is no empty "most active" card', () => {
  // getQuotes returns no volume. The honest options were 119 extra fetches or adding a
  // field to the quote path the ARMED trader polls; neither is worth a third card, and
  // an empty one would be worse than its absence.
  assert.doesNotMatch(PAGE, /Most active/);
  assert.match(MARKET, /NO "most active" BOARD/, 'and the reason is written down');
});

test('every row leads to that symbol', () => {
  assert.match(PAGE, /a\.href = '\/symbol\.html\?t=' \+ encodeURIComponent\(r\.ticker\);/);
  assert.doesNotMatch(PAGE, /href = '\/stock-trader\.html'/);
});

test('the home page’s Markets heading leads to the board', () => {
  assert.match(HOME, /<a href="\/markets\.html">\s*\n\s*<h2 id="mkt-h">Markets<\/h2>/);
});

test('the endpoint is a PUBLIC read, and publishes only market data', () => {
  // It belongs with watchlist-prices and symbol-stats: quotes, no account, no ledger.
  // The page is public, so a gated endpoint would render it empty for every visitor.
  const reads = SERVER.slice(SERVER.indexOf('const PUBLIC_TRADING_READS'), SERVER.indexOf('function tradeApiGuard'));
  assert.match(reads, /"\/api\/trading\/movers"/);
  // The deliberate exclusion above it must survive: we do not publish the ledger.
  assert.match(reads, /deliberately absent: \/api\/trading\/track-record/);
  const route = MARKET.slice(MARKET.indexOf("'/api/trading/movers'"), MARKET.indexOf("symbol-stats?ticker="));
  for (const leak of ['position', 'equity', 'pnl', 'account'])
    assert.ok(!new RegExp('\\b' + leak + '\\b').test(route), 'the movers payload must not carry ' + leak);
});

test('the page is registered public and classified', () => {
  assert.match(PAGES, /"\/markets\.html":\s*"markets\.html"/);
  const REG = fs.readFileSync(path.join(__dirname, '..', 'lib', 'surface-registry.js'), 'utf8');
  assert.match(REG, /"markets\.html":\s*"Observe"/);
  assert.match(PAGE, /<meta name="loop-stage" content="observe">/);
});
