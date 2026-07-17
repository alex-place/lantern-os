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
  withPrefStore(() => {   // pin an empty store so a stray local-owner.json can't interfere
    const { preferredBroker } = loadFacadeWith(aliveAlpaca);
    delete process.env.BROKER_PREFER;
    assert.strictEqual(preferredBroker(), 'ibkr');
    process.env.BROKER_PREFER = 'alpaca';
    assert.strictEqual(preferredBroker(), 'alpaca');
    process.env.BROKER_PREFER = 'nonsense';
    assert.strictEqual(preferredBroker(), 'ibkr');
  });
});

test('preferredBroker(): no session id resolves as the owner (local-owner store)', () => {
  withPrefStore((prefs) => {
    const { preferredBroker } = loadFacadeWith(aliveAlpaca);
    delete process.env.BROKER_PREFER;
    assert.strictEqual(preferredBroker(null), 'ibkr');           // no stored choice → default
    assert.ok(prefs.set('local-owner', 'alpaca'));               // ☰ switch on an auth-off box
    assert.strictEqual(preferredBroker(null), 'alpaca');         // honored for id-less requests
    assert.strictEqual(preferredBroker(undefined), 'alpaca');
    assert.strictEqual(preferredBroker('someone-else'), 'ibkr'); // other users unaffected
  });
});

// ── Per-user preference (broker-preference.js) — uses the REAL store in a temp dir ──

const os = require('os');
const fs = require('fs');
const PREFS = require.resolve('../lib/broker-preference');

function withPrefStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-pref-test-'));
  process.env.BROKER_PREF_DIR = dir;
  delete require.cache[PREFS];
  try { return fn(require(PREFS)); }
  finally {
    delete process.env.BROKER_PREF_DIR; delete require.cache[PREFS];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* temp */ }
  }
}

test('per-user preference beats the env default in both directions', () => {
  withPrefStore((prefs) => {
    const { preferredBroker } = loadFacadeWith(aliveAlpaca);
    process.env.BROKER_PREFER = 'alpaca';          // server default: alpaca
    assert.ok(prefs.set('u-ibkr', 'ibkr'));
    assert.strictEqual(preferredBroker('u-ibkr'), 'ibkr');       // user overrides TO ibkr
    delete process.env.BROKER_PREFER;              // server default: ibkr
    assert.ok(prefs.set('u-alp', 'alpaca'));
    assert.strictEqual(preferredBroker('u-alp'), 'alpaca');      // user overrides TO alpaca
    assert.ok(prefs.set('u-auto', 'auto'));
    assert.strictEqual(preferredBroker('u-auto'), 'ibkr');       // auto = follow default
    assert.strictEqual(preferredBroker('u-unset'), 'ibkr');      // no file = follow default
  });
});

test('broker-preference store: rejects invalid values, round-trips valid ones', () => {
  withPrefStore((prefs) => {
    assert.strictEqual(prefs.set('u1', 'robinhood'), false);
    assert.strictEqual(prefs.get('u1'), 'auto');                 // invalid never stored
    assert.ok(prefs.set('u1', 'alpaca'));
    assert.strictEqual(prefs.get('u1'), 'alpaca');
    assert.ok(prefs.set('u1', 'auto'));
    assert.strictEqual(prefs.get('u1'), 'auto');
  });
});

test('broker-preference store: anonymous (null) identity can never store or resolve a choice', () => {
  withPrefStore((prefs) => {
    assert.strictEqual(prefs.set(null, 'alpaca'), false);        // no shared null.json
    assert.strictEqual(prefs.set(undefined, 'ibkr'), false);
    assert.strictEqual(prefs.get(null), 'auto');
    assert.strictEqual(prefs.get(undefined), 'auto');
  });
});
