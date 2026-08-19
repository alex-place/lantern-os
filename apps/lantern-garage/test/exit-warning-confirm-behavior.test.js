'use strict';

/**
 * exit-warning-confirm-behavior.test.js — BEHAVIORAL proof that a risk-reducing exit
 * now clears IBKR's order-warning handshake, driving the real placeOrder() with only
 * its network/account seams stubbed.
 *
 * This is the test that would have caught 2026-07-27, when 13 exit decisions all
 * returned needs_confirmation and nothing was ever sold (TSLA max-loss decided at
 * -16.9% sat until -18.9%). The existing tests asserted the flag was PASSED; this one
 * asserts the broker handshake actually COMPLETES.
 */

const test = require('node:test');
const assert = require('node:assert');
const IbkrCpapi = require('../lib/ibkr-cpapi');

// The engine runs armed against the PAPER account (TRADER_LIVE=1 in the operator's
// env); the guard would otherwise short-circuit every order to dry_run and the
// warning handshake below would never be exercised. Paper mode only — a live U…
// account additionally needs TRADER_ALLOW_LIVE_ACCOUNT, which is NOT set here.
process.env.TRADER_LIVE = '1';

// IBKR's real two-step flow: POST /orders answers with a warning message that must be
// confirmed via POST /reply/<id>; only then does the order become PreSubmitted.
function stubClient({ acceptWarningsExpected } = {}) {
  const client = new IbkrCpapi({});
  const calls = [];
  client.getStatus = async () => ({ connected: true, authenticated: true, mode: 'paper', accountId: 'DUR000000' });
  client.getAccountSummary = async () => ({ equity: 100000 });
  client.searchContract = async () => ({ conid: 1234 });
  client.resolveAccountId = async () => 'DUR000000';
  client._request = async (method, pathname) => {
    calls.push(`${method} ${pathname.replace(/DUR\d+/, 'ACCT')}`);
    if (/\/orders$/.test(pathname)) {
      // The exact shape that stalled every exit: a warning with an id to confirm.
      return { ok: true, json: [{ id: 'warn-1', message: ['Size exceeds a % of average daily volume'], messageIds: ['o10153'] }] };
    }
    if (/\/reply\//.test(pathname)) {
      return { ok: true, json: [{ order_id: '99887766', order_status: 'PreSubmitted' }] };
    }
    return { ok: false, error: 'unexpected path ' + pathname };
  };
  return { client, calls };
}

test('EXIT (acceptWarnings) completes the warning handshake and submits', async () => {
  const { client, calls } = stubClient();
  const r = await client.placeOrder({ symbol: 'TSLA', side: 'SELL', qty: 95, orderType: 'MKT', equity: 100000, acceptWarnings: true });
  assert.strictEqual(r.status, 'submitted', `exit must reach the broker, got '${r.status}' (${r.note || r.error || ''})`);
  assert.notStrictEqual(r.status, 'needs_confirmation', 'the 2026-07-27 stall must not recur');
  assert.ok(calls.some((c) => c.includes('/reply/')), 'the confirmation call must actually be made');
  assert.strictEqual(r.dry, false, 'a confirmed exit is not a dry run');
});

test('ENTRY (default) still refuses to click through — P0-8 intact', async () => {
  const { client, calls } = stubClient();
  const r = await client.placeOrder({ symbol: 'TSLA', side: 'BUY', qty: 95, orderType: 'MKT', equity: 100000 });
  assert.strictEqual(r.status, 'needs_confirmation', 'entries must surface warnings for a human');
  assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1, 'the warning is reported, not swallowed');
  assert.ok(!calls.some((c) => c.includes('/reply/')), 'no auto-confirmation on an entry');
});

test('a warning-free exit submits without needing any confirmation call', async () => {
  const { client, calls } = stubClient();
  client._request = async (method, pathname) => {
    calls.push(`${method} ${pathname}`);
    return { ok: true, json: [{ order_id: '1', order_status: 'PreSubmitted' }] };
  };
  const r = await client.placeOrder({ symbol: 'SPY', side: 'SELL', qty: 10, orderType: 'MKT', equity: 100000, acceptWarnings: true });
  assert.strictEqual(r.status, 'submitted');
  assert.ok(!calls.some((c) => c.includes('/reply/')), 'no spurious confirmation when there is nothing to confirm');
});

test('the confirmation loop is bounded (cannot spin on repeated warnings)', async () => {
  const { client, calls } = stubClient();
  // Pathological broker: every reply raises ANOTHER warning.
  client._request = async (method, pathname) => {
    calls.push(`${method} ${pathname}`);
    return { ok: true, json: [{ id: 'warn-n', message: ['another warning'], messageIds: ['x'] }] };
  };
  const r = await client.placeOrder({ symbol: 'SPY', side: 'SELL', qty: 10, orderType: 'MKT', equity: 100000, acceptWarnings: true });
  const replies = calls.filter((c) => c.includes('/reply/')).length;
  assert.ok(replies <= 5, `confirmation loop must be capped, made ${replies} calls`);
  assert.ok(r.status !== 'submitted' || replies <= 5, 'bounded either way');
});
