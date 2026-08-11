'use strict';

/**
 * reset-root-email-only.test.js — password-reset lookups must match the
 * profile's ROOT email only, never a linked-identity email (2026-08-11: a
 * reset requested for a linked gmail resolved the founder profile and mailed
 * the link to founder@'s inbox — "wrong email to the wrong person").
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const p = require('path');

{
  const tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'resetroot-'));
  process.env.UNISONA_STATE_DIR = tmp;
}
const profiles = require('../lib/user-profiles');

test('rootOnly ignores linked-identity emails; default still matches them', () => {
  const u = profiles.createProfile('root-only-test-user', {
    name: 'Root Owner', email: 'owner@example.com',
  });
  profiles.linkIdentity(u.id, 'google', 'g-123', 'linked@gmail.example', true);

  // Default behavior (unchanged): identity emails resolve the profile.
  const viaIdentity = profiles.getProfileByEmail('linked@gmail.example');
  assert.ok(viaIdentity && viaIdentity.id === u.id, 'default lookup matches identity email');

  // rootOnly: identity emails must NOT resolve — reset mail goes to the typed
  // address or nowhere.
  assert.strictEqual(profiles.getProfileByEmail('linked@gmail.example', { rootOnly: true }), null,
    'rootOnly must not match a linked-identity email');
  const viaRoot = profiles.getProfileByEmail('owner@example.com', { rootOnly: true });
  assert.ok(viaRoot && viaRoot.id === u.id, 'rootOnly still matches the root email');
});
