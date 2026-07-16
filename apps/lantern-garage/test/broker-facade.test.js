'use strict';

/**
 * broker-facade preference tests (BROKER_PREFER, ADR-0027).
 *
 * Verifies the facade's broker precedence: IBKR-first by default (the original
 * behavior), Alpaca-first under BROKER_PREFER=alpaca, and fallback to the OTHER
 * broker in both directions so a preference can never strand a working account.
 * The alpaca-adapter is stubbed via require.cache (no network, no keys).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ADAPTER = require.resolve('../lib/alpaca-adapter');
const FACADE = require.resolve('../lib/broker-facade');

// Install an alpaca-adapter stub BEFORE the facade is required, then (re)load the
// facade against it. Returns the facade module.
function loadFacadeWith(alpacaStub) {
  delete require.cache[FACADE];
  require.cache[ADAPTER] = { id: ADAPTER, filename: ADAPTER, loaded: true, exports: alpacaStub };
  return require(FACADE);
}

const aliveAlpaca = {
  available: () => true,
  getAccount: async () => ({ account_id: 'alpaca-acct', account_number: 'PA000000' }),
  getPositions: async () => ({ positions: [] }),
  getOpenOrders: async () => [],
  getDayPnl: async () => 0,
  placeOrder: async () => ({ status: 'placed' }),
};
const deadAlpaca = { ...aliveAlpaca, available: () => false, getAccount: async () => null };

const aliveIbkr = { getIBKRAccount: async () => ({ account_id: 'DU-TEST' }) };
const deadIbkr = { getIBKRAccount: async () => null };

test.afterEach(() => { delete process.env.BROKER_PREFER; delete require.cache[FACADE]; delete require.cache[ADAPTER]; });

test('default: IBKR wins when both brokers are connected', async () => {
  delete process.env.BROKER_PREFER;
  const { brokerFacadeFor } = loadFacadeWith(aliveAlpaca);
  const r = await brokerFacadeFor('u1', aliveIbkr);
  assert.strictEqual(r.broker, 'ibkr');
  assert.strictEqual(r.accountId, 'DU-TEST');
});

test('BROKER_PREFER=alpaca: Alpaca wins when both brokers are connected', async () => {
  process.env.BROKER_PREFER = 'alpaca';
  const { brokerFacadeFor } = loadFacadeWith(aliveAlpaca);
  const r = await brokerFacadeFor('u1', aliveIbkr);
  assert.strictEqual(r.broker, 'alpaca');
  assert.strictEqual(r.accountId, 'alpaca-acct');
});

test('BROKER_PREFER=alpaca: falls back to IBKR when Alpaca is unavailable', async () => {
  process.env.BROKER_PREFER = 'alpaca';
  const { brokerFacadeFor } = loadFacadeWith(deadAlpaca);
  const r = await brokerFacadeFor('u1', aliveIbkr);
  assert.strictEqual(r.broker, 'ibkr');
});

test('default: falls back to Alpaca when IBKR is unavailable (original behavior)', async () => {
  delete process.env.BROKER_PREFER;
  const { brokerFacadeFor } = loadFacadeWith(aliveAlpaca);
  const r = await brokerFacadeFor('u1', deadIbkr);
  assert.strictEqual(r.broker, 'alpaca');
});

test('neither broker connected → null (caller skips the user)', async () => {
  process.env.BROKER_PREFER = 'alpaca';
  const { brokerFacadeFor } = loadFacadeWith(deadAlpaca);
  const r = await brokerFacadeFor('u1', deadIbkr);
  assert.strictEqual(r, null);
});

test('preferredBroker(): env parsing — only "alpaca" flips it', () => {
  const { preferredBroker } = loadFacadeWith(aliveAlpaca);
  delete process.env.BROKER_PREFER;
  assert.strictEqual(preferredBroker(), 'ibkr');
  process.env.BROKER_PREFER = 'alpaca';
  assert.strictEqual(preferredBroker(), 'alpaca');
  process.env.BROKER_PREFER = 'nonsense';
  assert.strictEqual(preferredBroker(), 'ibkr');
});
