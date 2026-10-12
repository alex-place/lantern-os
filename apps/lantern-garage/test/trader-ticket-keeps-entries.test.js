'use strict';
/**
 * test/trader-ticket-keeps-entries.test.js — focusing the symbol a ticket is already on
 * leaves the ticket alone (2026-10-11).
 *
 * The ticket follows the focused symbol (#1695) through setOrderSymbol, which starts a fresh
 * ticket: quantity 1, no take-profit, no stop. Every focus called it, including a focus on
 * the symbol the ticket was already on — a card's BUY opens a ticket without moving the
 * focus, so a click on that same chart (or its watchlist row) after entering a quantity and a
 * stop reset both without a word, and the order could go in without the stop. Reproduced on
 * a preview: QQQ ticket at qty 10 with a 700.00 stop, click QQQ's chart -> qty 1, stop off.
 * The page's own selectChart and focusTicker are run.
 *
 * Run: node --test apps/lantern-garage/test/trader-ticket-keeps-entries.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const between = (a, b) => { const i = PAGE.indexOf(a); assert.ok(i >= 0, 'found: ' + a); return PAGE.slice(i, PAGE.indexOf(b, i)); };
const SELECT = between('function selectChart(t, ev){', '\n// ── Zoom a ticker (#1629)');
const FOCUS = between('function focusTicker(t){', '\n// Click a chart in the grid to FOCUS it');

const DOC = { querySelectorAll: () => [], body: { classList: { contains: () => false } } };
const STORE = { setItem() {} };

function run(src, name, { active, ticket }) {
  const tickets = [];
  const fn = new Function('document', 'localStorage', 'renderWatchlist', 'renderSymbolInfo', 'setOrderSymbol', '_markActiveCard',
    'slotCount', 'chartSlots', 'wlPrices', 'persistSlots', 'renderCards',
    'let activeTicker = ' + JSON.stringify(active) + ', otTicker = ' + JSON.stringify(ticket) + ', lastCardOrder;\n' + src + '\nreturn ' + name + ';')(
    DOC, STORE, () => {}, () => {}, (t) => tickets.push(t), () => {}, 2, ['QQQ', 'DIA'], [{ ticker: 'QQQ' }, { ticker: 'DIA' }], () => {}, () => {});
  return { fn, tickets };
}

test('a click on the chart a ticket is already on leaves the ticket alone', () => {
  const r = run(SELECT, 'selectChart', { active: 'DIA', ticket: 'QQQ' });
  r.fn('QQQ', null);
  assert.deepStrictEqual(r.tickets, [], 'the quantity and the stop just entered survive');
  const other = run(SELECT, 'selectChart', { active: 'DIA', ticket: 'QQQ' });
  other.fn('SPY', null);
  assert.deepStrictEqual(other.tickets, ['SPY'], 'another symbol still retargets the ticket (#1695)');
});

test('so does a pick of its watchlist row — and a different row still moves the ticket', () => {
  const same = run(FOCUS, 'focusTicker', { active: 'DIA', ticket: 'QQQ' });
  same.fn('QQQ');
  assert.deepStrictEqual(same.tickets, []);
  const other = run(FOCUS, 'focusTicker', { active: 'QQQ', ticket: 'QQQ' });
  other.fn('DIA');
  assert.deepStrictEqual(other.tickets, ['DIA']);
});

test('the BUY/SELL buttons still open a fresh ticket', () => {
  // openOrderTicket is the deliberate "new order" path: it resets through setOrderSymbol
  // whatever symbol the ticket was on.
  const open = between('function openOrderTicket(ticker, side){', 'function closeOrderTicket(){');
  assert.match(open, /otSide = side; otOrderType = 'market';\n  setOrderSymbol\(ticker\);/);
});
