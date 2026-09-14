'use strict';
/**
 * test/journal-layout-follows.test.js — the journal layout follows the reader between
 * devices, including a Reset (QA, 2026-09-14).
 *
 * jpLayoutSync() returned early whenever the server had no layout, so a browser's copy --
 * kept only for the first paint -- outlived a Reset made on another device.
 *
 * Run: node --test apps/lantern-garage/test/journal-layout-follows.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'journal.html'), 'utf8').replace(/\r\n/g, '\n');
const start = PAGE.indexOf('async function jpLayoutSync() {');
const end = PAGE.indexOf('\n}\n', start) + 3;
assert.ok(start > 0 && end > start, 'jpLayoutSync not found');
const SRC = PAGE.slice(start, end);

const DEFAULT = { v: 2, order: ['kpis', 'coach', 'calendar'], hidden: [], span: {}, h: {} };
const MOVED = { v: 2, order: ['kpis', 'calendar', 'coach'], hidden: [], span: {}, h: {} };

// A page whose server answers `answer` (or throws), with `device` in localStorage.
function page(answer, device) {
  const store = {}; if (device) store['jp-layout-v2'] = JSON.stringify(device);
  const paints = [];
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const fetch = async () => { if (answer instanceof Error) throw answer; return { ok: true, json: async () => answer }; };
  const api = new Function('fetch', 'localStorage', 'JP_LAYOUT_KEY', 'jpLayoutMerge', 'jpLayoutDefault', 'jpPaintCards', 'jpLayoutRead',
    'let jpLayout = ' + JSON.stringify(device || DEFAULT) + ';\n' + SRC + '\nreturn { sync: jpLayoutSync, get: () => jpLayout };')(
    fetch, localStorage, 'jp-layout-v2', (l) => l, () => JSON.parse(JSON.stringify(DEFAULT)), () => paints.push(1),
    () => { try { return JSON.parse(store['jp-layout-v2'] || 'null'); } catch (_e) { return null; } });
  return { ...api, store, paints };
}

test('a Reset on another device reaches this one: the account has no layout, the device copy goes', async () => {
  const p = page({ layout: null, stored: true }, MOVED);
  await p.sync();
  assert.deepStrictEqual(p.get(), DEFAULT);
  assert.strictEqual(p.store['jp-layout-v2'], undefined, 'the device copy was removed');
  assert.strictEqual(p.paints.length, 1, 'the cards were repainted once');
});

test('a guest keeps the browser\'s copy: the server cannot speak for them', async () => {
  const p = page({ layout: null, stored: false }, MOVED);
  await p.sync();
  assert.deepStrictEqual(p.get(), MOVED);
  assert.ok(p.store['jp-layout-v2']);
  assert.strictEqual(p.paints.length, 0);
});

test('no layout anywhere is nothing to do', async () => {
  const p = page({ layout: null, stored: true }, null);
  await p.sync();
  assert.deepStrictEqual(p.get(), DEFAULT);
  assert.strictEqual(p.paints.length, 0, 'nothing to repaint');
});

test('a layout on the account still replaces the device copy, and a failed fetch changes nothing', async () => {
  const p = page({ layout: MOVED, stored: true }, null);
  await p.sync();
  assert.deepStrictEqual(p.get(), MOVED);
  assert.strictEqual(JSON.parse(p.store['jp-layout-v2']).order[1], 'calendar');
  const q = page(new Error('offline'), MOVED);
  await q.sync();
  assert.deepStrictEqual(q.get(), MOVED, 'offline: what the browser has stands');
});
