'use strict';
/**
 * test/trader-jump-symbol.test.js — "/" jumps the chart to the symbol, not only the details
 * (2026-10-11).
 *
 * Jump to symbol ("/", #2438) searches every symbol, but it handed the pick straight to
 * focusTicker. For a symbol not on the list the details panel and the order ticket moved to
 * it — priced "$—", since prices arrive through the list — while the chart stayed on the old
 * symbol: slots are pruned to the list (#3514), so focusTicker cannot chart it. B/S then
 * opened a ticket for a symbol that was not on screen. The page's own jumpToSymbol is run.
 *
 * Run: node --test apps/lantern-garage/test/trader-jump-symbol.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('async function jumpToSymbol(sym){'), PAGE.indexOf('\n// ── Keyboard-first trading (#2438)'));

function page({ list, addWorks }) {
  const calls = [];
  const env = { MY_LIST: new Set(list) };
  const addWatchlistSymbol = async (s) => {
    calls.push('add ' + s);
    if (addWorks) env.MY_LIST = new Set([...env.MY_LIST, s]);   // loadMyList(true) replaces the set
  };
  const focusTicker = (s) => calls.push('focus ' + s);
  const jump = new Function('env', 'addWatchlistSymbol', 'focusTicker',
    'with (env) {\n' + SRC + '\nreturn jumpToSymbol; }')(env, addWatchlistSymbol, focusTicker);
  return { jump, calls };
}

test('a symbol not on the list goes on first, then is focused — which charts it', async () => {
  assert.ok(SRC.length > 200, 'jumpToSymbol found');
  const p = page({ list: ['SPY', 'QQQ'], addWorks: true });
  await p.jump('AAPL');
  assert.deepStrictEqual(p.calls, ['add AAPL', 'focus AAPL']);
});

test('a symbol already on the list is focused without asking the server', async () => {
  const p = page({ list: ['SPY', 'QQQ'], addWorks: true });
  await p.jump('QQQ');
  assert.deepStrictEqual(p.calls, ['focus QQQ']);
});

test('when it does not go on (signed out, refused, failed) nothing moves', async () => {
  const p = page({ list: ['SPY', 'QQQ'], addWorks: false });
  await p.jump('AAPL');
  assert.deepStrictEqual(p.calls, ['add AAPL'], 'no half-jump: details on AAPL, chart on QQQ');
  const none = page({ list: ['SPY'], addWorks: true });
  await none.jump('');
  assert.deepStrictEqual(none.calls, []);
});

test('"/" goes through it', () => {
  assert.match(PAGE, /if\(e\.key==='\/'\)\{ e\.preventDefault\(\); openSymbolSearch\(sym=>jumpToSymbol\(sym\), \{title:'Jump to symbol'\}\); return; \}/);
});
