'use strict';
/**
 * test/symbol-search-rank.test.js — the symbol search puts the company first when you type
 * its name, and leaves symbol matches in the list's order (2026-10-12).
 *
 * The popup's ranking was exact symbol > symbol prefix > name prefix > contains, with ties
 * going to the shorter symbol and then to the asset list's own order. Every "Intel..." name
 * tied, so "intel" listed Intellicheck and Intelligent Protection above INTC; "apple" listed
 * Apple Hospitality REIT (APLE) above AAPL. Measured on the live universe (:4177, 13,505
 * assets). #3768 fixed both with a word-boundary rule and a shorter-name tie-break — and
 * applied that tie-break to SYMBOL matches too, where fund names are often the short ones:
 * "NVD" put "ProShares Ultra NVDA" (NVDB) and a Roundhill fund above NVDA. The tie-break is
 * for name matches only. The real route runs here; names are the live universe's.
 *
 * Run: node --test apps/lantern-garage/test/symbol-search-rank.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const route = require('../routes/trading/market');

const POOL = [
  // Name matches: the list order puts the wrong answers first.
  ['APLE', 'Apple Hospitality REIT, Inc. Common Stock'],
  ['MLP', 'Maui Land & Pineapple Company, Inc. Common Stock'],
  ['AAPL', 'Apple Inc. Common Stock'],
  ['IDN', 'Intellicheck, Inc. Common Stock'],
  ['IPM', 'Intelligent Protection Management Corp. Common Stock'],
  ['INTC', 'Intel Corporation Common Stock'],
  // Symbol matches: the broker's list carries the company before the funds built on it,
  // and those funds' names are SHORTER than the company's.
  ['NVDA', 'NVIDIA Corporation Common Stock'],
  ['NVDY', 'YieldMax NVDA Option Income Strategy ETF'],
  ['NVDB', 'ProShares Ultra NVDA'],
  ['NVD', 'GraniteShares 2x Short NVDA Daily ETF'],
  ['TSLA', 'Tesla, Inc. Common Stock'],
  ['TSLI', 'ProShares Ultra TSLA'],
].map(([symbol, name]) => ({ symbol, name, class: 'us_equity', tradable: true }));

async function search(q) {
  let out = null;
  const ctx = {
    sendJson: (_res, body) => { out = body; },
    bridge: { searchIBKRSymbols: async () => null },
    traderAgent: { getAllAssets: async () => POOL, validateSymbol: async () => null },
    getEffectiveUserId: () => null,
  };
  const handled = await route({ method: 'GET', headers: {} }, {}, new URL('http://x/api/trading/symbols/search?q=' + encodeURIComponent(q)), ctx);
  assert.ok(handled, 'the route answered');
  return out.results.map((r) => r.symbol);
}

test('a company name finds the company first', async () => {
  assert.strictEqual((await search('intel'))[0], 'INTC', 'Intellicheck and Intelligent Protection only start with its letters');
  assert.deepStrictEqual((await search('apple')).slice(0, 2), ['AAPL', 'APLE'], 'Apple Inc. before Apple Hospitality REIT');
  assert.strictEqual((await search('tesla'))[0], 'TSLA');
});

test('a symbol query keeps the list\'s order after the exact match: a short fund name does not jump the company', async () => {
  assert.deepStrictEqual(await search('NVD'), ['NVD', 'NVDA', 'NVDY', 'NVDB'], '#3768 put NVDB ("ProShares Ultra NVDA") above NVDA');
  assert.deepStrictEqual(await search('TSL'), ['TSLA', 'TSLI']);
});

test('the order of the kinds of match is unchanged', async () => {
  const r = await search('apple');
  assert.ok(r.indexOf('MLP') > r.indexOf('APLE'), 'a name that merely contains the query ("Pineapple") comes after the prefixes');
  assert.strictEqual((await search('NVDA'))[0], 'NVDA', 'an exact symbol is first');
});
