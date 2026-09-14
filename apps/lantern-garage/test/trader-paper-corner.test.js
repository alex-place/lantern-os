'use strict';
/**
 * test/trader-paper-corner.test.js — the account corner on the strip (operator, 2026-09-13).
 *
 * The PAPER badge sits at the strip's left, on the range buttons' line, the way
 * TradingView's "Paper Trading" sits on its trading panel. Clicking it hides or shows the
 * account panel below (positions, orders, order history); the chevron beside it opens the
 * account menu (trading settings, broker settings) and turns up while the menu is open.
 *
 * Run: node --test apps/lantern-garage/test/trader-paper-corner.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');
const CS = require('../public/js/chart-settings.js');

const slice = (from, to) => { const i = PAGE.indexOf(from); assert.ok(i !== -1, 'missing: ' + from); const j = PAGE.indexOf(to, i); assert.ok(j !== -1, 'missing end: ' + to); return PAGE.slice(i, j); };
const strip = slice('<div class="range-strip"', '<!-- Footer -->');
const header = slice('<div class="header" role="region"', '<div class="hgroup"');

test('the badge left the header for the strip\'s left corner, ahead of the range buttons', () => {
  assert.ok(!header.includes('badge-paper'), 'the badge is still in the header');
  assert.strictEqual((PAGE.match(/class="badge badge-paper"/g) || []).length, 1);
  assert.ok(strip.indexOf('id="acctCorner"') !== -1 && strip.indexOf('id="acctCorner"') < strip.indexOf('id="rangeRow"'), 'the corner is not ahead of the range row');
  assert.match(strip, /<button type="button" class="badge badge-paper" id="acctBadge" aria-expanded="true" aria-controls="tradePanel" onclick="toggleTradePanel\(\)"/);
  assert.match(strip, /<button type="button" class="acct-caret" id="acctMenuBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu" onclick="togglePickMenu\('acct', this\)"/);
  // The panel it controls is the footer, by id, exactly once.
  assert.strictEqual((PAGE.match(/id="tradePanel"/g) || []).length, 1);
  assert.match(PAGE, /<div class="footer" id="tradePanel" style="position:relative">/);
  // Guests without the demo lose the whole corner, as they lost the badge before.
  assert.match(PAGE, /body\.guest:not\(\.demo\) \.acct-corner,/);
});

test('the chevron turns up while its menu is open, and the menu offers the two settings', () => {
  assert.match(PAGE, /\.acct-caret\[aria-expanded="true"\] svg\{transform:rotate\(180deg\)\}/);
  assert.match(PAGE, /acct:'Account menu' \}/);
  const branch = slice("} else if(kind === 'acct') {", "  return h;\n}");
  assert.match(branch, /onclick="_closePickMenu\(\\'acct\\'\);openChartSettings\(\\'trading\\'\)"/);
  assert.match(branch, /<a class="pat-menu-item pick-row" role="menuitem" href="\/settings\.html#connections">/);
  assert.match(branch, /Trading settings…/);
  assert.match(branch, /Broker settings…/);
  // The dialog tab the first row opens exists, and the broker page is the one the ☰ links.
  assert.ok(CS.TABS.some((t) => t.id === 'trading'), 'no Trading tab in the settings dialog');
  assert.match(PAGE, /href="\/settings\.html#connections" class="nav-link" id="brokerBtn"/);
  assert.match(PAGE, /a\.pat-menu-item\{text-decoration:none;color:var\(--text0\)\}/);
});

test('clicking the badge collapses the panel, remembered per device, and the tooltip says which way the next click goes', () => {
  const src = slice('function _tradePanelOpen(){', 'function initFooterResize(){');
  const cls = new Set();
  const body = { classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains(c) { return cls.has(c); } } };
  const btn = { attrs: {}, dataset: { desc: 'Paper trading — simulated money.' }, title: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const store = {};
  const make = () => new Function('document', 'localStorage', src + '; return { _tradePanelOpen, _setTradePanel, toggleTradePanel, initTradePanel };')(
    { body, getElementById: () => btn }, { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } });
  const fns = make();
  fns.initTradePanel();
  assert.ok(!cls.has('panel-collapsed'), 'open by default');
  assert.strictEqual(btn.attrs['aria-expanded'], 'true');
  assert.strictEqual(btn.title, 'Paper trading — simulated money. Click to hide the account panel.');
  fns.toggleTradePanel();
  assert.ok(cls.has('panel-collapsed'));
  assert.strictEqual(store['trader.panelOpen'], '0');
  assert.strictEqual(btn.attrs['aria-expanded'], 'false');
  assert.strictEqual(btn.title, 'Paper trading — simulated money. Click to show the account panel.');
  fns.toggleTradePanel();
  assert.ok(!cls.has('panel-collapsed'));
  assert.strictEqual(store['trader.panelOpen'], '1');
  // A remembered collapse comes back collapsed.
  store['trader.panelOpen'] = '0'; cls.clear();
  fns.initTradePanel();
  assert.ok(cls.has('panel-collapsed'));
  // The demo switch renames the description and repaints, so the tooltip never fights it.
  assert.match(PAGE, /badge\.dataset\.desc='Demo account — a simulated "champion" strategy portfolio\. Look around; sign in to trade your own\.';\s*if\(typeof _setTradePanel === 'function'\) _setTradePanel\(\);/);
  assert.match(PAGE, /initFooterResize\(\); initTradePanel\(\);/);
});

test('a collapsed panel drops the footer row on the desktop grid only; phones switch views instead', () => {
  assert.match(PAGE, /@media \(min-width:581px\)\{\s*body\.panel-collapsed \.footer\{display:none\}\s*body\.panel-collapsed \.layout\{grid-template-rows:52px minmax\(0,1fr\) auto\}\s*\}/);
  // On a phone the badge opens the Positions view instead, where the panel lives there.
  assert.match(PAGE, /function toggleTradePanel\(\)\{[\s\S]*?window\.matchMedia\('\(max-width:580px\)'\)\.matches && typeof setMobileView === 'function'\)\{ setMobileView\('positions'\); return; \}/);
  // The phone layout keeps its own footer rules untouched.
  assert.match(PAGE, /\.layout\.mobile-tickers \.range-strip,\s*\.layout\.mobile-positions \.range-strip\{ display:none; \}/);
});
