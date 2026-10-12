'use strict';
/**
 * test/trader-chart-focus.test.js — clicking a chart focuses it, and ←/→ walk the deck
 * (2026-10-11).
 *
 * selectChart was switched off whole on 2026-08-01 — "a diagnostic step" while a double-click
 * fullscreen was hunted (it lived elsewhere and went in 74132fd5) — and never switched back on.
 * For two months a click on the second chart of a deck pointed nothing at it, ←/→ (#2438) did
 * nothing, and B/S kept opening a ticket for whichever watchlist row was picked last. The
 * page's own selectChart is run here as shipped.
 *
 * Run: node --test apps/lantern-garage/test/trader-chart-focus.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('function selectChart(t, ev){'), PAGE.indexOf('\n// ── Zoom a ticker (#1629)'));

function deck(tickers, { guest = false, active = null, ticket = null } = {}) {
  const cards = tickers.map((ticker) => {
    const cls = new Set(['card']);
    return { dataset: { ticker }, cls, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
  });
  const calls = { watchlist: 0, info: [], order: [] };
  const store = {};
  const fns = new Function('document', 'localStorage', 'renderWatchlist', 'renderSymbolInfo', 'setOrderSymbol',
    'let activeTicker = ' + JSON.stringify(active) + ', otTicker = ' + JSON.stringify(ticket) + ';\n' + SRC + '\nreturn { selectChart, _markActiveCard, active: () => activeTicker };')(
    { querySelectorAll: () => cards, body: { classList: { contains: (c) => c === 'guest' && guest } } },
    { setItem: (k, v) => { store[k] = v; } },
    () => { calls.watchlist++; }, (t) => calls.info.push(t), (t) => calls.order.push(t));
  const lit = () => cards.filter((c) => c.cls.has('active')).map((c) => c.dataset.ticker);
  return { fns, calls, store, lit };
}
// A click event whose target is (or is inside) the given selector match, or plain chart.
const clickOn = (hit) => ({ target: { closest: (sel) => (hit && sel.split(',').map((s) => s.trim()).includes(hit) ? {} : null) } });

test('selectChart is switched on: it is not a bare return any more', () => {
  assert.ok(SRC.length > 300, 'selectChart found');
  const body = SRC.slice(SRC.indexOf('{') + 1).replace(/^\s*(\/\/[^\n]*\n\s*)*/, '');
  assert.ok(!/^return;/.test(body), 'the first statement is not the 2026-08-01 diagnostic return');
  assert.ok(!SRC.includes('/*\n  if(!t) return;'), 'the body is not commented out');
});

test('a click on a chart points the details, the ticket and the watchlist at it — and marks it', () => {
  const d = deck(['QQQ', 'SPY'], { active: 'QQQ' });
  d.fns.selectChart('SPY', clickOn(null));
  assert.strictEqual(d.fns.active(), 'SPY');
  assert.deepStrictEqual(d.calls.info, ['SPY']);
  assert.deepStrictEqual(d.calls.order, ['SPY'], 'B/S now open a ticket for the chart that was clicked');
  assert.strictEqual(d.calls.watchlist, 1);
  assert.strictEqual(d.store['trader.ticker'], 'SPY', 'and it is remembered for the next load');
  assert.deepStrictEqual(d.lit(), ['SPY'], 'one card marked: the one clicked');
});

test('the card\'s own controls do their own thing, and a second click on the focused chart is quiet', () => {
  for (const hit of ['button', '.card-ticker', '.drag-handle', 'input']) {
    const d = deck(['QQQ', 'SPY'], { active: 'QQQ' });
    d.fns.selectChart('SPY', clickOn(hit));
    assert.strictEqual(d.fns.active(), 'QQQ', 'a click on ' + hit + ' is not a focus');
    assert.strictEqual(d.calls.info.length, 0);
  }
  const d = deck(['QQQ', 'SPY'], { active: 'SPY' });
  d.fns.selectChart('SPY', clickOn(null));
  assert.strictEqual(d.calls.info.length + d.calls.watchlist, 0, 'panning the focused chart re-renders nothing');
});

test('a guest\'s click focuses the details but never touches a ticket; a lone chart is never marked', () => {
  const g = deck(['QQQ', 'SPY'], { guest: true, active: 'QQQ' });
  g.fns.selectChart('SPY', null);
  assert.deepStrictEqual(g.calls.info, ['SPY']);
  assert.deepStrictEqual(g.calls.order, []);
  const one = deck(['QQQ'], { active: 'SPY' });
  one.fns.selectChart('QQQ', null);
  assert.deepStrictEqual(one.lit(), [], 'a lone card lit up reads as a stuck state (31f580e6)');
});

test('←/→ walk through selectChart, and a rebuilt or re-picked deck keeps the mark', () => {
  const keys = PAGE.slice(PAGE.indexOf("if(e.key==='ArrowLeft' || e.key==='ArrowRight'){"), PAGE.indexOf("if(/^[0-6]$/.test(e.key)"));
  assert.match(keys, /selectChart\(next, null\);/);
  const render = PAGE.slice(PAGE.indexOf('function renderCards(){'), PAGE.indexOf('function editSlot('));
  assert.match(render, /grid\.innerHTML = list\.map\(t => buildCard\(t, zonesData\[t\]\|\|\{\}\)\)\.join\(''\);\n.*\n  _markActiveCard\(\);/);
  const focus = PAGE.slice(PAGE.indexOf('function focusTicker(t){'), PAGE.indexOf('\n// Click a chart in the grid to FOCUS it'));
  assert.match(focus, /renderSymbolInfo\(t\);\n  _markActiveCard\(\);/);
});
