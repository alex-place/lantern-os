'use strict';
// #3087 — LANTERN_ADMIN_IDS must be able to elevate an email/password (local) account, and a
// bare/mis-qualified entry must warn instead of silently no-op'ing. auth-providers reads the env
// ONCE at module load, so each case sets the env then loads a fresh copy of the module.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'lib', 'auth-providers.js');

function loadFresh(adminIds) {
  delete require.cache[require.resolve(MOD)];
  const prev = process.env.LANTERN_ADMIN_IDS;
  if (adminIds === undefined) delete process.env.LANTERN_ADMIN_IDS;
  else process.env.LANTERN_ADMIN_IDS = adminIds;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let mod;
  try { mod = require(MOD); } finally { console.warn = origWarn; }
  if (prev === undefined) delete process.env.LANTERN_ADMIN_IDS; else process.env.LANTERN_ADMIN_IDS = prev;
  return { mod, warnings };
}

// A local email/password account carries a {provider:"local"} identity (user-profiles.createLocalAccount).
const localProfile = (email) => ({
  id: 'abc', role: 'guest',
  identities: [{ provider: 'local', providerId: String(email).toLowerCase(), email }],
});

test('a qualified local: entry elevates a local account', () => {
  const { mod } = loadFresh('local:owner@example.com');
  assert.equal(mod.profileHasAdminOverride(localProfile('owner@example.com')), true);
  assert.equal(mod.isAdminOverride('local', 'owner@example.com'), true);
});

test('a non-owner local account is NOT elevated', () => {
  const { mod } = loadFresh('local:owner@example.com');
  assert.equal(mod.profileHasAdminOverride(localProfile('someone-else@example.com')), false);
});

test('a bare email entry does NOT match a local account (it becomes google:) and warns', () => {
  const { mod, warnings } = loadFresh('owner@example.com');
  // Bare → google:owner@example.com, which no local account can be — the #3087 silent no-op.
  assert.equal(mod.profileHasAdminOverride(localProfile('owner@example.com')), false);
  assert.ok(
    warnings.some((w) => w.includes('owner@example.com') && w.includes('local:')),
    'expected a warning steering a bare email entry toward local:'
  );
});

test('an unknown provider prefix warns that it can never grant admin', () => {
  const { warnings } = loadFresh('slack:U123');
  assert.ok(warnings.some((w) => w.includes('slack') && w.toLowerCase().includes('never')));
});

test('a plain Google id stays bare→google and does not warn (legit common case)', () => {
  const { mod, warnings } = loadFresh('108451923456789');
  assert.equal(mod.isAdminOverride('google', '108451923456789'), true);
  assert.equal(warnings.length, 0);
});
