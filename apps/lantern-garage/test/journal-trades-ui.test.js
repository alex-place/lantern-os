'use strict';
/**
 * test/journal-trades-ui.test.js — #3558.
 *
 * The card's contract: sorting and paging go to the server (sorting the visible page
 * rather than the set looks like sorting and is not), expanding a row costs nothing
 * because the row is already in hand, and a field the record does not carry says so
 * rather than rendering as a blank that reads like a zero.
 *
 * Run: node --test apps/lantern-garage/test/journal-trades-ui.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
  assert.ok(i >= 0, 'function not found: ' + name);
  let depth = 0, started = false;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};
const grabDecl = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const P = new Function([
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpSign'), grabDecl('jpR'),
  grabDecl('JP_TRADE_COLS'),
  'let jpTradeQ = { limit: 25, offset: 0, sort: "ts", dir: "desc", symbol: "", result: "all" };',
  'const jpTradeOpen = new Set();',
  grabFn('jpHeld'), grabFn('jpTradeWhen'), grabFn('jpLabelValue'),
  grabFn('jpTradeDetail'), grabFn('jpTradeRNote'), grabFn('jpTradeControls'), grabFn('jpTrades'),
].join('\n') + '\nreturn { jpHeld, jpTrades, jpTradeDetail, jpTradeRNote, open: jpTradeOpen };')();

const trade = (o) => Object.assign({
  id: 't1', ts: '2026-09-04T18:00:00.000Z', openedAt: null, heldMs: null,
  symbol: 'AAPL', side: 'long', qty: 10, entry: 180, exit: 185,
  pnl: 50, pnl_pct: 2.78, r: null, reason: 'signal_exit', source: null,
  confirmed: true, estimated: false, mfe_pct: null, mae_pct: null,
}, o);

const data = (o) => Object.assign({
  trades: [trade({})], total: 1, offset: 0, limit: 25, sort: 'ts', dir: 'desc', view: 'confirmed',
  filter: { symbol: null, from: null, to: null, result: 'all' },
  totals: { trades: 1, wins: 1, losses: 0, net: 50, withR: 0 },
  symbols: ['AAPL', 'MSFT'],
}, o);

test('a hold reads as time, not as milliseconds', () => {
  assert.strictEqual(P.jpHeld(45 * 60000), '45m');
  assert.strictEqual(P.jpHeld(3.5 * 3600000), '3h 30m');
  assert.strictEqual(P.jpHeld(2 * 3600000), '2h');
  assert.strictEqual(P.jpHeld(50 * 3600000), '2d 2h');
  assert.strictEqual(P.jpHeld(null), '—', 'an unrecorded hold is absent, never zero');
  assert.strictEqual(P.jpHeld(-5), '—');
});

test('the table draws a trade', () => {
  const html = P.jpTrades(data());
  assert.match(html, /AAPL/);
  assert.match(html, /\$50\.00/);
  assert.match(html, /2\.8%/);
  assert.match(html, /1 trade · 1W \/ 0L/);
});

test('sorting and paging are server-side, because sorting a page is not sorting', () => {
  const sort = grabFn('jpTradeSort');
  assert.match(sort, /jpTradeLoad\(\)/, 'a re-sort asks the server for the set in that order');
  assert.match(sort, /offset = 0/, 'and starts at the top rather than mid-list');
  assert.doesNotMatch(sort, /\.sort\(/, 'it never re-orders the page it happens to hold');
  const page = grabFn('jpTradePage');
  assert.match(page, /jpTradeLoad\(\)/);
  assert.match(page, /next < 0/, 'and cannot page off either end');
});

test('one request repaints one card, and never the page', () => {
  const load = grabFn('jpTradeLoad');
  assert.match(load, /getElementById\('jpTradesCard'\)/);
  assert.match(load, /card\.innerHTML = jpTrades/);
  assert.doesNotMatch(load, /jpLoad\(/, 'changing how the list looks never re-reads the record');
  assert.match(load, /aria-busy/, 'and says it is working while it does');
});

test('expanding a row costs nothing — the row is already in hand', () => {
  const toggle = grabFn('jpTradeToggle');
  assert.doesNotMatch(toggle, /fetch\(/);
  assert.doesNotMatch(toggle, /jpTradeLoad\(/);
  assert.match(toggle, /jpTrades\(jpTradeData\)/, 'it repaints from what was already fetched');
});

test('the detail says what the record does NOT have, rather than leaving it blank', () => {
  const html = P.jpTradeDetail(trade({}));
  assert.match(html, /Opened[\s\S]*not recorded/);
  assert.match(html, /Exit reason/);
  assert.match(html, /not recorded for this trade/, 'excursions that were never observed');
  assert.match(html, /no stop recorded to measure against/, 'and an R with no denominator');
});

test('an imported trade is named as the reader\'s own, not as the autopilot\'s', () => {
  assert.match(P.jpTradeDetail(trade({ source: 'broker-import' })), /imported from your broker/);
  assert.match(P.jpTradeDetail(trade({ source: 'fill' })), /the autopilot/);
});

test('a trade priced off a mark rather than a fill says so', () => {
  assert.match(P.jpTradeDetail(trade({ estimated: true })), /last observed mark/);
  assert.doesNotMatch(P.jpTradeDetail(trade({ estimated: false })), /last observed mark/);
});

test('"none of them" and "some of them" are different sentences about R', () => {
  assert.strictEqual(P.jpTradeRNote({ trades: 5, withR: 5 }), '.', 'nothing to caveat');
  assert.match(P.jpTradeRNote({ trades: 5, withR: 0 }), /None of these recorded the stop/);
  assert.match(P.jpTradeRNote({ trades: 5, withR: 2 }), /R is shown for the 2 of them/);
  // The bug this replaced: "R is shown for the 0 opened with a recorded stop".
  assert.doesNotMatch(P.jpTradeRNote({ trades: 5, withR: 0 }), /for the 0 /);
});

test('an empty list distinguishes "no trades" from "nothing matched that filter"', () => {
  const none = P.jpTrades(data({ total: 0, trades: [] }));
  assert.match(none, /No closed trades yet/);
  const filtered = P.jpTrades(data({
    total: 0, trades: [], filter: { symbol: 'AAPL', from: null, to: null, result: 'all' },
  }));
  assert.match(filtered, /No trades match that filter/);
  assert.match(filtered, /jp-bar-filters/, 'and the filter is still there to change back');
});

test('a failed load is not reported as an empty book', () => {
  assert.match(P.jpTrades(null), /could not be loaded/);
  assert.doesNotMatch(P.jpTrades(null), /No closed trades/);
  assert.match(P.jpTrades(undefined), /aria-busy/);
});

test('the pager only appears when there is more than one page', () => {
  assert.doesNotMatch(P.jpTrades(data()), /jp-pager/);
  const many = P.jpTrades(data({ total: 80, limit: 25, offset: 25 }));
  assert.match(many, /jp-pager/);
  assert.match(many, /26–50 of 80/);
});

test('the totals describe the filter, and say so', () => {
  const filtered = P.jpTrades(data({
    filter: { symbol: 'AAPL', from: null, to: null, result: 'all' },
    totals: { trades: 3, wins: 2, losses: 1, net: 120, withR: 0 },
  }));
  assert.match(filtered, /3 trades · 2W \/ 1L/);
  assert.match(filtered, /\(this filter\)/, 'so the number is not mistaken for the whole book');
});

test('a hostile symbol cannot smuggle markup into the list', () => {
  const html = P.jpTrades(data({
    trades: [trade({ symbol: '<img src=x onerror=alert(1)>' })],
    symbols: ['<img src=x onerror=alert(1)>'],
  }));
  assert.doesNotMatch(html, /<img/);
});

test('the card is in the arrangement registry, above the statistics drawn from it', () => {
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  const entry = reg.slice(0, reg.indexOf(']'));
  assert.match(entry, /id: 'trades'/);
  assert.ok(entry.indexOf("id: 'trades'") < entry.indexOf("id: 'breakdown'"), 'the list comes before its aggregates');
  assert.match(grabFn('jpCardBody'), /id === 'trades'/);
});
