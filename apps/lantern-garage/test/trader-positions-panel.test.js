'use strict';
/**
 * test/trader-positions-panel.test.js — the trader's positions panel (#3518).
 *
 * The panel is where money gets closed, so this pins the parts that must never drift:
 *   - the Leverage column's multipliers are the ENGINE's (lib/direction-lock.js), not a
 *     second opinion typed into the page;
 *   - every row keeps its Flatten / Clear dust button, and "Close all" is still there,
 *     wired exactly as before;
 *   - the Columns menu's choices apply, persist, and reset.
 *
 * Runs the page's own code in a sandbox. Run: node --test apps/lantern-garage/test/trader-positions-panel.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = process.env.TRADER_PAGE || path.join(__dirname, '..', 'public', 'stock-trader.html');
const dl = require(process.env.DIRECTION_LOCK || path.join(__dirname, '..', 'lib', 'direction-lock'));
const src = fs.readFileSync(PAGE, 'utf8').split('\r\n').join('\n');

const fnText = (name) => {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  assert.ok(a > 0, name + ' is on the page');
  const firstLine = src.slice(a, src.indexOf('\n', a));
  if (/\}\s*$/.test(firstLine) && (firstLine.match(/\{/g) || []).length === (firstLine.match(/\}/g) || []).length) return firstLine;
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
};
const start = src.indexOf('/* ── Positions panel (#');
assert.ok(start > 0, 'the panel block is on the page');
const end = src.indexOf('\n}\n', src.indexOf('function renderPositionsTable(', start)) + 2;
const code = [fnText('fmt'), fnText('_realizedTip'), fnText('_dayPnlTip'), src.slice(start, end)].join('\n');

function load() {
  const els = {}, store = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '' });
  const sb = {
    document: { getElementById: el, addEventListener() {}, createElement: () => ({ setAttribute() {}, style: {}, hidden: true }), body: { appendChild() {} } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console, innerHeight: 900, innerWidth: 1600,
  };
  vm.createContext(sb);
  vm.runInContext(code + '\n;globalThis.__tp = { renderTpSummary, renderPositionsTable, _tpShown, _tpLev, _TP_COLS, _TP_TILES,'
    + ' _TP_LEVERAGE, _TP_INVERSE, setWorking: (w) => { _tpWorking = w; }, setMem: (m) => { _tpMem = m; } };', sb);
  return { tp: sb.__tp, els, store };
}

const POS = [
  { symbol: 'SOXL', qty: 10, side: 'long', avg_entry_price: 30, current_price: 33, market_value: 330, unrealized_pl: 30, pnl_pct: 10, day_pnl: 12.5, day_basis: 'prev_close' },
  { symbol: 'SQQQ', qty: 5, side: 'long', avg_entry_price: 20, current_price: 19, market_value: 95, unrealized_pl: -5, pnl_pct: -5 },
  { symbol: 'GLD', qty: 19, side: 'long', avg_entry_price: 402.53, current_price: 398.81, market_value: 7577.39, unrealized_pl: -70.6, pnl_pct: -0.92 },
  { symbol: 'XYZ', qty: 0.4, side: 'long', avg_entry_price: 10, current_price: 10, market_value: 4, unrealized_pl: 0, pnl_pct: 0 },
];
const ORDERS = [
  { symbol: 'GLD', side: 'sell', qty: 19, type: 'stop', limit_price: 390.45, status: 'open' },
  { symbol: 'SOXL', side: 'sell', qty: 10, type: 'limit', limit_price: 40, status: 'open' },
];
const ACCT = { equity: 100000, cash: 50000, buying_power: 150000, unrealized: -45.6, realized_today: 0, pnl_today: 12.5 };
const rowOf = (html, sym) => (html.match(new RegExp('<tr>\\s*<td><span class="tp-sym" onclick="focusTicker\\(\'' + sym + '\'\\)">[\\s\\S]*?</tr>')) || [''])[0];
const heads = (html) => [...html.matchAll(/<th(?: [^>]*)?>([^<]*)<\/th>/g)].map((m) => m[1]);

test('the Leverage column mirrors the engine: same multipliers, same inverse funds', () => {
  const { tp } = load();
  assert.deepStrictEqual({ ...tp._TP_LEVERAGE }, { ...dl.LEVERAGE }, 'page _TP_LEVERAGE must equal lib/direction-lock LEVERAGE');
  const inverse = Object.keys(dl.FAMILY).filter((k) => dl.FAMILY[k][1] < 0).sort();
  assert.deepStrictEqual([...tp._TP_INVERSE].sort(), inverse, 'page _TP_INVERSE must be exactly the FAMILY entries with sign -1');
  for (const sym of ['SOXL', 'SQQQ', 'SPY', 'TLT', 'TBT', 'AAPL']) {
    assert.strictEqual(tp._tpLev(sym), dl.leverageOf(sym) * dl.instrumentSign(sym).sign, sym);
  }
});

test('the registries are sane and keep every original column and tile', () => {
  const { tp } = load();
  const ids = tp._TP_COLS.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'column ids are unique');
  for (const id of ['side', 'qty', 'avg', 'last', 'day', 'upl', 'pct', 'cost', 'mv']) assert.ok(tp._tpShown('cols').includes(id), 'original column ' + id + ' shows by default');
  for (const id of ['lev', 'stop', 'weight']) assert.ok(tp._tpShown('cols').includes(id), id + ' shows by default');
  for (const id of ['equity', 'cash', 'realized', 'unrealized', 'day', 'bp', 'lev']) assert.ok(tp._tpShown('tiles').includes(id), 'tile ' + id);
});

test('order controls are wired exactly as before', () => {
  const { tp, els } = load();
  tp.renderTpSummary(ACCT, POS); tp.renderPositionsTable(POS);
  const html = els['tp-positions'].innerHTML;
  assert.match(html, /<button class="tp-flatten-all" onclick="flattenAll\(this\)"[^>]*>✕ Close all<\/button>/);
  assert.ok(rowOf(html, 'SOXL').includes(`flattenPosition('SOXL','long',10,false,this)`), 'Flatten keeps its signature');
  assert.ok(rowOf(html, 'XYZ').includes(`dustClear('XYZ',this)`), 'a sub-share remnant still gets Clear dust');
  assert.strictEqual((html.match(/tp-flat-btn/g) || []).length, POS.length, 'one action per row');
  assert.strictEqual(els.tpPosCount.textContent, 3, 'dust still does not count as a position');
});

test('new columns: leverage, stop, take profit, weight, exposure', () => {
  const { tp, els } = load();
  tp.setWorking(ORDERS);
  tp.setMem({ cols: tp._TP_COLS.map((c) => c.id), tiles: tp._TP_TILES.map((t) => t.id) });
  tp.renderTpSummary(ACCT, POS); tp.renderPositionsTable(POS);
  const html = els['tp-positions'].innerHTML;
  assert.match(rowOf(html, 'SOXL'), /<td class="tp-lev-hi">3x<\/td>/, 'SOXL 3x');
  assert.match(rowOf(html, 'SQQQ'), /<td class="tp-lev-hi">−3x<\/td>/, 'SQQQ -3x (inverse)');
  assert.match(rowOf(html, 'GLD'), /<td>1x<\/td>/, 'GLD 1x');
  assert.match(rowOf(html, 'GLD'), /<td>\$390\.45<span class="tp-sub">-2\.1%<\/span><\/td>/, 'GLD stop from its resting stop order, 2.1% below last');
  assert.match(rowOf(html, 'SOXL'), /<td>\$40\.00<span class="tp-sub">\+21\.2%<\/span><\/td>/, 'SOXL take profit from its resting limit');
  assert.match(rowOf(html, 'SOXL'), /<td>0\.3%<\/td>/, 'SOXL weight = 330 / 100,000');
  assert.match(rowOf(html, 'SOXL'), /<td>\$990\.00<\/td>/, 'SOXL exposure = 330 x 3');
  assert.match(rowOf(html, 'SOXL'), /title="No resting stop order for this position\.">—<\/td>/, 'no stop: an honest dash');
  // gross = 330x3 + 95x3 + 7577.39x1 (dust excluded) = 8852.39 -> 0.09x of 100,000
  assert.match(els.tpSummary.innerHTML, /<div class="l">Leverage<\/div><div class="v ">0\.09x<\/div>/);
  assert.match(els.tpSummary.innerHTML, /<div class="l">Exposure<\/div><div class="v ">\$8,852\.39<\/div>/);
});

test('the Columns menu choices apply, persist, and reset', () => {
  const { tp, els, store } = load();
  store['tp-panel-v1'] = JSON.stringify({ cols: ['qty', 'lev'], tiles: ['equity', 'lev'] });
  tp.renderTpSummary(ACCT, POS); tp.renderPositionsTable(POS);
  assert.deepStrictEqual(heads(els['tp-positions'].innerHTML), ['Symbol', 'Qty', 'Leverage', ''], 'only the chosen columns, Symbol and the action always');
  assert.deepStrictEqual([...els.tpSummary.innerHTML.matchAll(/<div class="l">([^<]*)<\/div>/g)].map((m) => m[1]), ['Account value', 'Leverage']);
  delete store['tp-panel-v1'];
  tp.renderPositionsTable(POS);
  assert.ok(heads(els['tp-positions'].innerHTML).includes('Unrealized P&L'), 'no stored choice: the defaults again');
});

test('nothing open: the Columns menu stays reachable, Close all does not render', () => {
  const { tp, els } = load();
  tp.renderPositionsTable([]);
  const html = els['tp-positions'].innerHTML;
  assert.match(html, /id="tpColsBtn"/);
  assert.doesNotMatch(html, /tp-flatten-all/);
  assert.match(html, /No open positions/);
});

test('the table cannot blow up: no percentage widths on its data cells', () => {
  // A 1% width under .tp-pane's min-width:max-content drew the table at 100x its
  // content (11,391px inside a 726px pane) the first time this panel was rendered.
  const css = (src.match(/\.tp-pos-table[^{]*\{[^}]*\}/g) || []).join('\n');
  assert.ok(css.length, 'the panel has its own rules');
  assert.doesNotMatch(css, /:not\(\.tp-act\)[^{]*\{[^}]*width:\s*\d+%/, 'no percentage width on the data cells');
  assert.match(src, /\.tp-pane \.tp-table\.tp-pos-table\{min-width:0\}/, 'the panel table opts out of min-width:max-content');
  assert.match(src, /\.tp-pos-table \.tp-act\{width:100%\}/, 'the action column takes the slack');
});

test('an order refresh never re-renders over an armed Flatten', () => {
  const fnOrders = fnText('renderOrders');
  assert.match(fnOrders, /_tpWorking = working;/, 'renderOrders feeds the Stop column');
  assert.match(fnOrders, /if \(_lastPositions\.length && !_armedBtn\) renderPositionsTable\(_lastPositions\);/, 'and only re-renders when nothing is armed');
});
