'use strict';
/**
 * test/trader-rvol.test.js — relative volume is a measurement or it is absent (2026-10-11).
 *
 * marketRegime() divided the last bar's volume by the prior bars' average and, when that
 * average was 0, returned 1. Yahoo reports every extended-hours and weekend 5m bar with
 * volume 0, so off-hours EVERY symbol showed "RVOL 1.00×" in the symbol panel, the RVOL
 * watchlist sort was a tie, and an order placed then was journaled (trader.journal) with
 * a relative volume nobody measured. The page's own function is run here as shipped.
 *
 * Run: node --test apps/lantern-garage/test/trader-rvol.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const src = PAGE.slice(PAGE.indexOf('function marketRegime(ticker){'), PAGE.indexOf('// Badge text/class for a card'));
const regimeWith = (bars) => new Function('barsData', 'wlPrices', 'ATR_VOLATILE_THRESHOLD', 'TREND_STRENGTH_THRESHOLD',
  src + '; return marketRegime;')({ T: bars }, [{ ticker: 'T', chg_pct: 0.4 }], 3, 70)('T');
const bars = (vol) => Array.from({ length: 30 }, (_, i) => ({
  open: 100, high: 101, low: 99, close: 100 + (i % 3), volume: typeof vol === 'function' ? vol(i) : vol,
}));

test('with no volume to compare against there is no relative volume', () => {
  assert.ok(src.length > 200, 'marketRegime found in the page');
  assert.strictEqual(regimeWith(bars(0)).volumeRatio, 0, 'off-hours bars all carry volume 0');
});

test('with volume it is still the measurement it always was', () => {
  assert.strictEqual(regimeWith(bars((i) => (i === 29 ? 3000 : 1000))).volumeRatio, 3);
  assert.strictEqual(regimeWith(bars((i) => (i === 29 ? 0 : 1000))).volumeRatio, 0, 'a dead last bar reads 0, as before');
});

test('the readers treat 0 as nothing to show', () => {
  assert.match(PAGE, /\$\{rvol>0\?`<span class="wi-rvol/, 'the symbol panel hides it');
  assert.match(PAGE, /rvol:reg\.volumeRatio\?\+reg\.volumeRatio\.toFixed\(2\):null,/, 'the placement journal records null');
});
