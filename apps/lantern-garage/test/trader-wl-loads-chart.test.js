'use strict';
/**
 * test/trader-wl-loads-chart.test.js — in a one-chart deck, picking a symbol charts it
 * (2026-10-11).
 *
 * The watchlist row says "View X chart". It did while a click opened a fullscreen chart;
 * when that was removed (#3141) the click kept changing the highlight, the details and
 * the order ticket — everything but the chart. With QQQ charted, picking DIA left QQQ on
 * screen beside DIA's details. The page's own focusTicker is run here as shipped.
 *
 * Run: node --test apps/lantern-garage/test/trader-wl-loads-chart.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('function focusTicker(t){'), PAGE.indexOf('\n// Click a chart in the grid to FOCUS it'));

function deck({ slotCount, slots, watchlist }) {
  const calls = { renderCards: 0, persist: 0 };
  const focusTicker = new Function('slotCount', 'chartSlots', 'wlPrices', 'persistSlots', 'renderCards', 'renderWatchlist',
    'renderSymbolInfo', 'setOrderSymbol', 'localStorage', 'document', '_markActiveCard',
    'let activeTicker, lastCardOrder;\n' + SRC + '\nreturn focusTicker;')(
    slotCount, slots, watchlist.map((ticker) => ({ ticker })), () => { calls.persist++; }, () => { calls.renderCards++; },
    () => {}, () => {}, () => {}, { setItem() {} }, { body: { classList: { contains: () => true } } }, () => {});
  return { focusTicker, slots, calls };
}

test('one chart: the symbol you pick is the one charted', () => {
  assert.ok(SRC.length > 200, 'focusTicker found');
  const d = deck({ slotCount: 1, slots: ['QQQ', 'SPY'], watchlist: ['SPY', 'QQQ', 'DIA'] });
  d.focusTicker('DIA');
  assert.deepStrictEqual(d.slots, ['DIA', 'SPY']);
  assert.strictEqual(d.calls.renderCards, 1, 'and the deck redraws');
  assert.strictEqual(d.calls.persist, 1);
});

test('a symbol already in another slot is swapped in, so a multi-chart arrangement survives', () => {
  const d = deck({ slotCount: 1, slots: ['QQQ', 'SPY', 'IWM'], watchlist: ['SPY', 'QQQ', 'IWM'] });
  d.focusTicker('IWM');
  assert.deepStrictEqual(d.slots, ['IWM', 'SPY', 'QQQ']);
});

test('nothing moves when it should not', () => {
  const multi = deck({ slotCount: 2, slots: ['QQQ', 'SPY'], watchlist: ['SPY', 'QQQ', 'DIA'] });
  multi.focusTicker('DIA');
  assert.deepStrictEqual(multi.slots, ['QQQ', 'SPY'], 'a multi-chart deck is the reader’s arrangement');
  const off = deck({ slotCount: 1, slots: ['QQQ'], watchlist: ['QQQ'] });
  off.focusTicker('ZZZZ');
  assert.deepStrictEqual(off.slots, ['QQQ'], 'slots are pruned to the watchlist (#3514): an unlisted pick would snap back');
  const same = deck({ slotCount: 1, slots: ['QQQ'], watchlist: ['QQQ'] });
  same.focusTicker('QQQ');
  assert.strictEqual(same.calls.renderCards, 0, 'picking what is charted redraws nothing');
});
