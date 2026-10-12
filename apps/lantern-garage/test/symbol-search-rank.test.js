'use strict';
/**
 * test/symbol-search-rank.test.js — the symbol search puts the company first when you type
 * its name (2026-10-12).
 *
 * The popup's ranking was exact symbol > symbol prefix > name prefix > contains, with ties
 * going to the shorter symbol and then to the asset list's own order. Every "Intel..." name
 * tied, so "intel" listed Intellicheck and Intelligent Protection above INTC; "apple" listed
 * Apple Hospitality REIT (APLE) above AAPL. Measured on the live universe (:4177, 13,505
 * assets). A name that starts with the query as a WORD now beats one that only starts with
 * its letters, and equal matches go to the shorter name. The real route runs here.
 *
 * Run: node --test apps/lantern-garage/test/symbol-search-rank.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const route = require('../routes/trading/market');

// List order is the trap: the old tie-break fell to it, so the wrong answers come first.
const POOL = [
  ['APLE', 'Apple Hospitality REIT, Inc. Common Stock'],
  ['MLP', 'Maui Land & Pineapple Company, Inc. Common Stock'],
  ['AAPL', 'Apple Inc. Common Stock'],
  ['IDN', 'Intellicheck, Inc. Common Stock'],
  ['IPM', 'Intelligent Protection Management Corp. Common Stock'],
  ['INTC', 'Intel Corporation Common Stock'],
  ['NVDY', 'YieldMax NVDA Option Income Strategy ETF'],
  ['NVDA', 'NVIDIA Corporation Common Stock'],
  ['NVD', 'GraniteShares 2x Short NVDA Daily ETF'],
  ['TSLY', 'YieldMax TSLA Option Income Strategy ETF'],
  ['TSLA', 'Tesla, Inc. Common Stock'],
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

test('among symbol matches, the company before the funds named after it', async () => {
  assert.deepStrictEqual((await search('NVD')).slice(0, 3), ['NVD', 'NVDA', 'NVDY'], 'exact first, then the shorter name');
  assert.deepStrictEqual((await search('TSL')).slice(0, 2), ['TSLA', 'TSLY']);
});

test('the order of the kinds of match is unchanged', async () => {
  const r = await search('apple');
  assert.ok(r.indexOf('MLP') > r.indexOf('APLE'), 'a name that merely contains the query ("Pineapple") comes after the prefixes');
  assert.strictEqual((await search('NVDA'))[0], 'NVDA', 'an exact symbol is first');
});
