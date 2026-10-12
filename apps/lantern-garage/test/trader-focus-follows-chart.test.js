'use strict';
/**
 * test/trader-focus-follows-chart.test.js — the focused symbol is the one on screen
 * (2026-10-11).
 *
 * The details panel, the order ticket and the watchlist highlight follow the focused symbol;
 * B/S open a ticket for it. Four ways in left it pointing at a symbol no longer charted:
 * switching to one chart kept slot 0 whatever was focused; changing a chart's symbol and
 * dropping a watchlist row on a chart never moved the focus; and the load restored the saved
 * symbol beside whatever a one-chart deck charted. The page's own functions are run.
 *
 * Run: node --test apps/lantern-garage/test/trader-focus-follows-chart.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const between = (a, b) => { const i = PAGE.indexOf(a); assert.ok(i >= 0, 'found: ' + a); return PAGE.slice(i, PAGE.indexOf(b, i)); };
const HELPER = between('function _chartInSlotZero(t){', '\n// Click a chart in the grid to FOCUS it');
const SET_COUNT = between('function setSlotCount(v){', '\n// Phones only offer single / double chart layouts');
const EDIT_SLOT = between('function editSlot(oldTicker){', 'async function commitSlotSymbol(oldTicker, sym){');

function layout({ slots, focused, listed }) {
  const fns = new Function('chartSlots', 'wlPrices', 'activeTicker', 'document', '_setSelectValue', 'persistSlots', 'applyGridCols', 'renderCards',
    'let slotCount = 2, _preZoomSlot = null, lastCardOrder = "x";\n' + HELPER + '\n' + SET_COUNT + '\nreturn { setSlotCount };')(
    slots, listed.map((ticker) => ({ ticker })), focused, { getElementById: () => null }, () => {}, () => {}, () => {}, () => {});
  return { setSlotCount: fns.setSlotCount, slots };
}

test('down to one chart, the chart kept is the focused one', () => {
  const d = layout({ slots: ['QQQ', 'SPY'], focused: 'SPY', listed: ['SPY', 'QQQ', 'DIA'] });
  d.setSlotCount('1');
  assert.deepStrictEqual(d.slots, ['SPY', 'QQQ'], 'swapped, so going back to two charts keeps both');
  const picked = layout({ slots: ['QQQ', 'SPY'], focused: 'DIA', listed: ['SPY', 'QQQ', 'DIA'] });
  picked.setSlotCount('1');
  assert.deepStrictEqual(picked.slots, ['DIA', 'SPY'], 'a listed pick not yet charted is charted, as a pick in one chart is');
});

test('nothing moves when it should not', () => {
  const two = layout({ slots: ['QQQ', 'SPY'], focused: 'SPY', listed: ['SPY', 'QQQ'] });
  two.setSlotCount('2');
  assert.deepStrictEqual(two.slots, ['QQQ', 'SPY'], 'more than one chart: the arrangement is the reader\'s');
  const off = layout({ slots: ['QQQ', 'SPY'], focused: 'ZZZZ', listed: ['SPY', 'QQQ'] });
  off.setSlotCount('1');
  assert.deepStrictEqual(off.slots, ['QQQ', 'SPY'], 'a symbol off the list cannot be charted (#3514)');
  const none = layout({ slots: ['QQQ', 'SPY'], focused: null, listed: ['SPY', 'QQQ'] });
  none.setSlotCount('1');
  assert.deepStrictEqual(none.slots, ['QQQ', 'SPY']);
});

test('changing a chart\'s symbol focuses it — once it is on screen', async () => {
  const run = async (visible) => {
    const focused = [];
    let pick;
    const editSlot = new Function('openSymbolSearch', 'commitSlotSymbol', 'visibleTickers', 'focusTicker', EDIT_SLOT + '\nreturn editSlot;')(
      (cb) => { pick = cb; }, async () => {}, () => visible, (t) => focused.push(t));
    editSlot('QQQ');
    await pick('AAPL');
    return focused;
  };
  assert.deepStrictEqual(await run(['AAPL', 'SPY']), ['AAPL']);
  assert.deepStrictEqual(await run(['QQQ', 'SPY']), [], 'refused (signed out): the old chart stays, and so does the focus');
});

test('a watchlist row dropped on a chart is focused, and the load focuses what one chart shows', () => {
  assert.match(PAGE, /chartSlots\[idx\] = _dragWlTk; persistSlots\(\); lastCardOrder=''; renderCards\(\); focusTicker\(_dragWlTk\); \}/);
  const boot = between('let saved=null; try{ saved=localStorage.getItem(\'trader.ticker\'); }catch(e){}', 'renderSymbolInfo(activeTicker);');
  const pickAtLoad = (slotCount, chartSlots, saved, wl) => new Function('slotCount', 'chartSlots', 'wlPrices', 'localStorage',
    'let activeTicker;\n' + boot + '\nreturn activeTicker;')(slotCount, chartSlots, wl.map((ticker) => ({ ticker })), { getItem: () => saved });
  assert.strictEqual(pickAtLoad(1, ['QQQ'], 'SPY', ['SPY', 'QQQ']), 'QQQ', 'one chart: the charted symbol, not the saved one beside it');
  assert.strictEqual(pickAtLoad(2, ['QQQ', 'SPY'], 'SPY', ['SPY', 'QQQ']), 'SPY', 'more than one: the saved symbol, as before');
  assert.strictEqual(pickAtLoad(1, ['ZZZZ'], 'DIA', ['SPY', 'DIA']), 'DIA', 'an unlisted slot falls back to the old order');
  assert.strictEqual(pickAtLoad(2, [], null, ['IWM', 'SPY']), 'SPY');
});

test('focusTicker and setSlotCount share the one-chart rule', () => {
  const focus = between('function focusTicker(t){', '\n// Click a chart in the grid to FOCUS it');
  assert.match(focus, /if \(_chartInSlotZero\(t\)\) \{\n    persistSlots\(\);/);
  assert.match(SET_COUNT, /_chartInSlotZero\(activeTicker\);\n  persistSlots\(\);/);
});
