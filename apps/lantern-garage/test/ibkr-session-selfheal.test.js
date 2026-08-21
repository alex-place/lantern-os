'use strict';
/**
 * ibkr-session-selfheal.test.js — the morning-blindness cure (#3394).
 *
 * The stuck state, live twice in one day (2026-08-20): IBKR's maintenance kills
 * the brokerage session; the cached LST lives ~24h; ssodh/init only runs when a
 * NEW LST is minted; so every request signs correctly against a dead session
 * until a restart happens to re-handshake. At 03:48 the engine was blind and a
 * lucky deploy restart fixed it. These tests pin the cure's exact boundaries.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const mod = require('../lib/ibkr-cpapi.js');
const Client = mod.IbkrCpapi || mod;

const mk = (over = {}) => Object.assign(Object.create(Client.prototype), {
  _lst: { token: 'x', expiresAt: Date.now() + 20 * 3600e3 },
  _lstMintedAt: Date.now() - 10 * 60e3,          // minted 10 min ago
  _statusCache: { at: Date.now(), value: {} },
}, over);

test('THE STUCK STATE: reachable + unauthenticated + old LST → LST dropped, cache cleared', () => {
  const c = mk();
  assert.strictEqual(c._maybeInvalidateStaleSession({ reachable: true, authenticated: false }), true);
  assert.strictEqual(c._lst, null, 'the dead-session LST is gone — next call re-mints + ssodh/init');
  assert.strictEqual(c._statusCache, null, 'status cache cleared so the recovery is visible immediately');
});

test('a FRESH mint is not the stuck state — a mint race must not thrash', () => {
  const c = mk({ _lstMintedAt: Date.now() - 10e3 });
  assert.strictEqual(c._maybeInvalidateStaleSession({ reachable: true, authenticated: false }), false);
  assert.ok(c._lst, 'an LST minted seconds ago is kept');
});

test('UNREACHABLE is not the stuck state — never drop the LST when IBKR itself is down', () => {
  const c = mk();
  assert.strictEqual(c._maybeInvalidateStaleSession({ reachable: false, authenticated: false }), false);
  assert.ok(c._lst, 'network outage keeps the token — it may be perfectly valid');
});

test('an AUTHENTICATED session is never touched', () => {
  const c = mk();
  assert.strictEqual(c._maybeInvalidateStaleSession({ reachable: true, authenticated: true }), false);
  assert.ok(c._lst);
});

test('no LST cached → nothing to invalidate', () => {
  const c = mk({ _lst: null });
  assert.strictEqual(c._maybeInvalidateStaleSession({ reachable: true, authenticated: false }), false);
});

test('handshake cooldown: after a refused mint, _ensureLst backs off instead of hammering', async () => {
  const c = Object.assign(Object.create(Client.prototype), {
    oauth1: { buildLiveSessionTokenRequest() { throw new Error('must not be called during cooldown'); } },
    _lst: null,
    _lstRetryAfter: Date.now() + 60e3,
  });
  assert.strictEqual(await c._ensureLst(), null, 'cooldown returns null without a network attempt');
});
