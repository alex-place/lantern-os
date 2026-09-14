'use strict';
/**
 * test/trader-layout-chip.test.js — the toolbar's layout chip says what the grid shows
 * (founder, 2026-09-14: one chart open, the chip said "All").
 *
 * The chip is a custom control painted over the native <select>; it learns a value only
 * through the select's 'change' event or _setSelectValue(), never from a bare `.value =`.
 * buildLayoutOptions() rebuilt the options on load (the chip repainted as "All") and then
 * wrote `sel.value = slotCount` -- no 'change', no sync.
 *
 * Run: node --test apps/lantern-garage/test/trader-layout-chip.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => {
  const at = PAGE.indexOf('function ' + name + '(');
  assert.notStrictEqual(at, -1, name + ' not found');
  return PAGE.slice(at, PAGE.indexOf('\n}\n', at) + 3);
};

test('_setSelectValue sets the native value and syncs the chip', () => {
  const src = fn('_setSelectValue');
  assert.match(src, /sel\.value = value;/);
  assert.match(src, /if \(sel\._uiSync\) sel\._uiSync\(\);/);
});

test('rebuilding the layout options on load syncs the chip, never a bare .value write', () => {
  const src = fn('buildLayoutOptions');
  assert.match(src, /_setSelectValue\('chartLayoutSelect', String\(slotCount\)\)/);
  assert.doesNotMatch(src, /sel\.value\s*=/, 'a bare .value write fires no change and leaves the chip stale');
});

test('every layout change goes through setSlotCount, which tells the chip', () => {
  const src = fn('setSlotCount');
  assert.match(src, /_setSelectValue\('chartLayoutSelect', String\(slotCount\)\)/);
  // The 0-6 keys and the "Back to grid" button both land in setSlotCount.
  assert.doesNotMatch(PAGE, /sel\.value=e\.key; setSlotCount\(e\.key\)/, 'the keyboard path still writes .value directly');
  assert.match(PAGE, /onclick="setSlotCount\(0\)"/);
});

test('running the two together: a rebuilt select with a saved count ends with the chip on that count', () => {
  // A minimal stand-in for the select + chip pair: _uiSync paints from selectedIndex.
  const options = [{ value: '0', text: '⊞ All' }, { value: '1', text: '1 chart' }, { value: '2', text: '2 charts' }];
  const sel = { options, selectedIndex: 0, _uiSync: null, chip: '' };
  Object.defineProperty(sel, 'value', {
    get() { return options[sel.selectedIndex].value; },
    set(v) { const i = options.findIndex((o) => o.value === String(v)); sel.selectedIndex = i < 0 ? 0 : i; },
  });
  sel._uiSync = () => { sel.chip = options[sel.selectedIndex].text; };
  sel._uiSync();                                               // the chip paints on build: "All"
  const setSelectValue = new Function('document', fn('_setSelectValue') + '\nreturn _setSelectValue;')({ getElementById: () => sel });
  // What buildLayoutOptions does now, with slotCount 1 saved on the device.
  setSelectValue('chartLayoutSelect', '1');
  assert.strictEqual(sel.value, '1');
  assert.strictEqual(sel.chip, '1 chart', 'the chip follows the restored count');
  // And what it did before: a bare write moved the value but not the chip.
  sel.value = '0'; assert.strictEqual(sel.chip, '1 chart', 'a bare write leaves the chip stale -- the bug');
});
