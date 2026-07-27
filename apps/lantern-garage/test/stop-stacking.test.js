'use strict';

/**
 * stop-stacking.test.js — the re-protect pass must RECOGNISE an existing protective
 * stop, whatever vocabulary the broker/normalizer used for its status.
 *
 * 2026-07-27: the guard matched only IBKR's native words (PreSubmitted/Submitted/
 * Pending), but the normalized order shape says `open` / `accepted` / `new` and puts
 * the kind in `type`, not `orderType`. hasStop() therefore never matched, the engine
 * believed every long was naked, and it stacked another GTC stop EVERY scan:
 * 488 resting stop-sells, ~33 per symbol, 95,561 shares against 3,772 held — a 25x
 * oversell that would have flipped the book massively short on any gap down.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');

// Reconstruct the guard exactly as the module defines it, so the test tracks the real
// predicate rather than a paraphrase of it.
function buildHasStop(openOrders) {
  const m = SRC.match(/const hasStop = \(sym\) =>[\s\S]*?\);/);
  assert.ok(m, 'hasStop predicate not found in auto-trader.js');
  // eslint-disable-next-line no-new-func
  return new Function('_openOrders', `const hasStop = ${m[0].replace(/^const hasStop = /, '').replace(/;$/, '')}; return hasStop;`)(openOrders);
}

const STOP = (status, key = 'type') => ({ symbol: 'TSLA', side: 'sell', status, [key]: 'stop' });

test('recognises a resting stop under every status vocabulary the stack produces', () => {
  for (const status of ['open', 'accepted', 'new', 'working', 'PreSubmitted', 'Submitted', 'pending']) {
    for (const key of ['type', 'orderType']) {
      const hasStop = buildHasStop([STOP(status, key)]);
      assert.strictEqual(hasStop('TSLA'), true, `status '${status}' on key '${key}' must count as protected`);
    }
  }
});

test('a filled or cancelled stop does NOT count — the long really is naked', () => {
  for (const status of ['filled', 'canceled', 'cancelled', 'rejected', 'expired']) {
    const hasStop = buildHasStop([STOP(status)]);
    assert.strictEqual(hasStop('TSLA'), false, `status '${status}' must NOT count as protection`);
  }
});

test('another symbol\'s stop never protects this one', () => {
  const hasStop = buildHasStop([{ symbol: 'AAPL', side: 'sell', type: 'stop', status: 'open' }]);
  assert.strictEqual(hasStop('TSLA'), false);
});

test('a BUY stop is not protection for a long', () => {
  const hasStop = buildHasStop([{ symbol: 'TSLA', side: 'buy', type: 'stop', status: 'open' }]);
  assert.strictEqual(hasStop('TSLA'), false);
});
