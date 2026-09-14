'use strict';
/**
 * test/trader-stale-bars.test.js — a bars reply belongs to the interval it was asked for
 * (QA, 2026-09-14).
 *
 * Switch D -> 1m quickly: loadBars() skipped the second call while the first fetch was in
 * flight, the daily reply painted after the reader had moved to 1m, and the cache stored
 * those daily bars under the 1m key. Now the newest request owns the chart.
 *
 * Run: node --test apps/lantern-garage/test/trader-stale-bars.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const start = PAGE.indexOf('let _barsReq = 0, _barsTf = null;');
const end = PAGE.indexOf('\n}\n', PAGE.indexOf('async function loadBars(){', start)) + 3;
assert.ok(start > 0 && end > start, 'loadBars not found');
const SRC = PAGE.slice(start, end);
const CACHE = PAGE.slice(PAGE.indexOf('function _saveBarsCache(){'), PAGE.indexOf('\n}\n', PAGE.indexOf('function _saveBarsCache(){')) + 3);

// A page with a fetch whose replies the test releases by hand.
function page() {
  const pending = [];
  const store = {};
  const fetch = (url) => new Promise((resolve) => { pending.push({ url, resolve }); });
  const localStorage = { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] };
  const api = new Function('fetch', 'localStorage', 'console',
    'let chartTimeframe = "5m", barsData = {}, barsLoading = false, barsLoadedOnce = false, wlPrices = [], zonesData = {};\n'
    + 'const renderZoneLadder = () => {}, updateRegimeBadges = () => {}, renderFullscreenChart = () => {};\n'
    + CACHE + '\n' + SRC + '\n'
    + 'return { loadBars, tf: (v) => { chartTimeframe = v; }, state: () => ({ barsData, barsLoading, barsLoadedOnce, req: _barsReq, inflightTf: _barsTf }) };')(
    fetch, localStorage, { warn() {} });
  const reply = (p, tf) => p.resolve({ json: async () => ({ bars: { SPY: { bars: [{ timestamp: tf + '-1' }, { timestamp: tf + '-2' }] } } }) });
  return { ...api, pending, store, reply };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the reply for an interval the reader has left is dropped; the newest request paints', async () => {
  const p = page();
  p.tf('1d'); const daily = p.loadBars();
  p.tf('1m'); const minute = p.loadBars();
  assert.strictEqual(p.pending.length, 2, 'the second interval starts its own fetch');
  assert.match(p.pending[0].url, /timeframe=1d$/);
  assert.match(p.pending[1].url, /timeframe=1m$/);
  // The 1m reply lands first, then the stale daily one.
  p.reply(p.pending[1], '1m'); await minute; await tick();
  p.reply(p.pending[0], '1d'); await daily; await tick();
  const s = p.state();
  assert.deepStrictEqual(s.barsData.SPY.map((b) => b.timestamp), ['1m-1', '1m-2'], 'daily bars painted over the 1m chart');
  assert.strictEqual(s.barsLoading, false, 'the flag is clear once the owning request is done');
  assert.strictEqual(s.inflightTf, null);
  // And the cache holds 1m bars under the 1m key -- no daily bars there.
  assert.ok(p.store['trader.bars.1m'], 'the 1m cache was written');
  assert.deepStrictEqual(JSON.parse(p.store['trader.bars.1m']).bars.SPY.map((b) => b.timestamp), ['1m-1', '1m-2']);
  assert.strictEqual(p.store['trader.bars.1d'], undefined, 'the dropped reply cached nothing');
});

test('the stale reply is dropped even when it lands before the fresh one', async () => {
  const p = page();
  p.tf('1d'); const daily = p.loadBars();
  p.tf('1m'); const minute = p.loadBars();
  p.reply(p.pending[0], '1d'); await daily; await tick();
  assert.deepStrictEqual(p.state().barsData, {}, 'the daily reply must not paint a 1m chart');
  assert.strictEqual(p.state().barsLoading, true, 'the 1m request is still in flight');
  p.reply(p.pending[1], '1m'); await minute; await tick();
  assert.deepStrictEqual(p.state().barsData.SPY.map((b) => b.timestamp), ['1m-1', '1m-2']);
  assert.strictEqual(p.state().barsLoading, false);
});

test('a second call for the SAME interval while one is in flight is folded into it', async () => {
  const p = page();
  p.tf('5m'); const a = p.loadBars(); const b = p.loadBars();
  assert.strictEqual(p.pending.length, 1, 'the periodic refresh does not double-fetch');
  p.reply(p.pending[0], '5m'); await a; await b; await tick();
  assert.deepStrictEqual(p.state().barsData.SPY.map((x) => x.timestamp), ['5m-1', '5m-2']);
  assert.strictEqual(p.state().barsLoading, false);
});

test('a failed fetch clears the flag only for the request that owns it', async () => {
  const p = page();
  p.tf('1d'); const daily = p.loadBars();
  p.tf('1m'); const minute = p.loadBars();
  p.pending[0].resolve({ json: async () => { throw new Error('boom'); } }); await daily; await tick();
  assert.strictEqual(p.state().barsLoading, true, 'the failed stale request must not clear the newer one\'s flag');
  p.reply(p.pending[1], '1m'); await minute; await tick();
  assert.strictEqual(p.state().barsLoading, false);
});
