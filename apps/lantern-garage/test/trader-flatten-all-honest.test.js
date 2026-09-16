'use strict';
/**
 * test/trader-flatten-all-honest.test.js — Close all reports what actually closed
 * (QA, 2026-09-16).
 *
 * The loop threw away flattenPosition's verdict:
 *
 *   for(const p of snapshot) await flattenPosition(p.symbol, p.side, p.qty, true);
 *   _alertToast(`Closed ${snapshot.length} position…s (paper)`);
 *
 * so the summary counted the positions it TRIED, not the ones that closed. With every
 * order rejected the reader's last line was "Closed 2 positions (paper)" while both were
 * still open — the individual failures having scrolled past behind it.
 *
 * "(paper)" was hardcoded too. Every other toast on the page derives it from the
 * server's result.mode; this one asserted it, so a LIVE account was told its real closes
 * were paper ones — on the single most destructive control in the app.
 *
 * Run: node --test apps/lantern-garage/test/trader-flatten-all-honest.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const a = PAGE.indexOf('async function flattenPosition(');
const b = PAGE.indexOf('/* Even columns', a);
assert.ok(a > 0 && b > a, 'the flatten block was not found');
const SRC = PAGE.slice(a, b);

/**
 * Run Close all over `positions`, with the broker answering `reply` for each order.
 * `reply` may be a function of the symbol, so a run can succeed for one and fail another.
 */
function closeAll(positions, reply) {
  const out = { toasts: [], posted: [], confirms: [] };
  const answer = typeof reply === 'function' ? reply : () => reply;
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    out.posted.push(body);
    const r = answer(body.ticker);
    return { ok: true, statusText: 'OK', json: async () => r };
  };
  const scope = new Function('fetch', '_alertToast', 'window', 'journalLog', 'refreshAfterOrder', '_twoStep', '_lastPositions',
    SRC + '\nreturn { flattenAll, flattenPosition };')(
    fetch, (m) => out.toasts.push(m),
    { confirm: (m) => { out.confirms.push(m); return true; } },
    () => {}, () => {}, () => true, positions);
  return { run: () => scope.flattenAll(null), out };
}

const PLACED = { status: 'placed', fill_price: 199.5, mode: 'paper' };
const LIVE_PLACED = { status: 'placed', fill_price: 199.5, mode: 'live' };
const REJECTED = { status: 'rejected', reason: 'insufficient buying power', mode: 'live' };
const TWO = [{ symbol: 'AAPL', side: 'long', qty: 10, market_value: 2000 },
             { symbol: 'MSFT', side: 'long', qty: 5, market_value: 1800 }];

test('when every order is rejected, the summary does not claim they closed', async () => {
  const t = closeAll(TWO, REJECTED);
  await t.run();
  assert.strictEqual(t.out.posted.length, 2, 'both were attempted');
  const last = t.out.toasts[t.out.toasts.length - 1];
  assert.doesNotMatch(last, /^Closed 2 position/, 'the last line still claims both closed');
  assert.match(last, /Closed 0 of 2/);
  assert.match(last, /AAPL, MSFT/, 'the reader is not told WHICH ones are still open');
});

test('a partial run says how many, and names the ones still open', async () => {
  const t = closeAll(TWO, (sym) => (sym === 'AAPL' ? PLACED : REJECTED));
  await t.run();
  const last = t.out.toasts[t.out.toasts.length - 1];
  assert.match(last, /Closed 1 of 2/);
  assert.match(last, /MSFT/);
  assert.doesNotMatch(last, /AAPL[^,]*didn/, 'the one that closed is named as a failure');
});

test('a clean run reports the count it actually closed', async () => {
  const t = closeAll(TWO, PLACED);
  await t.run();
  assert.strictEqual(t.out.toasts[t.out.toasts.length - 1], 'Closed 2 positions');
  const one = closeAll([TWO[0]], PLACED);
  await one.run();
  assert.strictEqual(one.out.toasts[one.out.toasts.length - 1], 'Closed 1 position', 'singular');
});

test('the summary claims no mode — a live close is never called paper', async () => {
  const live = closeAll(TWO, LIVE_PLACED);
  await live.run();
  const last = live.out.toasts[live.out.toasts.length - 1];
  assert.doesNotMatch(last, /paper/i, 'a LIVE account was told its closes were paper');
  // and each individual flatten still reports the mode the server gave it
  const paper = closeAll([TWO[0]], PLACED);
  await paper.run();
  assert.match(paper.out.toasts[0], /\(paper\)/, 'the per-position toast lost its mode');
  assert.match(live.out.toasts[0], /Flattened AAPL/);
  assert.doesNotMatch(live.out.toasts[0], /\(paper\)/);
});

test('Close all still asks first, with the count and the money at stake', async () => {
  const t = closeAll(TWO, PLACED);
  await t.run();
  assert.strictEqual(t.out.confirms.length, 1, 'the hard confirm is what Rapid mode cannot skip');
  assert.match(t.out.confirms[0], /Close ALL 2 open positions/);
  assert.match(t.out.confirms[0], /3,800/, 'the total market value is what makes a misclick obvious');
});
