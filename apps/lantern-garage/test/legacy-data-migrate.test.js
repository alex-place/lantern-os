'use strict';

/**
 * legacy-data-migrate.test.js — the #3136 follow-up merge that un-orphans
 * pre-collapse accounts (the GCE v1.14.2 incident: email+password 401'd and
 * Google minted fresh guest profiles because the store the server read was
 * empty while the real accounts sat in the old cwd-relative tree).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const p = require('path');

function mkTmp(prefix) { return fs.mkdtempSync(p.join(os.tmpdir(), prefix)); }
const quiet = { info: () => {}, warn: () => {} };

function setup() {
  const stateRoot = mkTmp('canon-');       // UNISONA_STATE_DIR → canonical root = <state>/data
  const legacyCwd = mkTmp('legacy-');      // simulated service cwd → legacy root = <cwd>/data
  process.env.UNISONA_STATE_DIR = stateRoot;
  const canon = p.join(stateRoot, 'data');
  const legacy = p.join(legacyCwd, 'data');
  return { canon, legacy, legacyCwd };
}

test('orphaned legacy profiles are merged in, legacy-first, and the legacy file is retired', () => {
  const { canon, legacy, legacyCwd } = setup();
  fs.mkdirSync(p.join(legacy, 'profiles'), { recursive: true });
  fs.writeFileSync(p.join(legacy, 'profiles', 'index.jsonl'),
    '{"id":"old-user","role":"admin"}\n');
  fs.mkdirSync(p.join(canon, 'profiles'), { recursive: true });
  fs.writeFileSync(p.join(canon, 'profiles', 'index.jsonl'),
    '{"id":"new-user","role":"guest"}\n');

  const { migrateLegacyData } = require('../lib/legacy-data-migrate');
  const r = migrateLegacyData({ cwd: legacyCwd, logger: quiet });
  assert.ok(r.migrated, 'migration must report work done');

  const merged = fs.readFileSync(p.join(canon, 'profiles', 'index.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(merged.length, 2, 'both accounts present after merge');
  assert.ok(merged[0].includes('old-user'), 'legacy lines come FIRST (latest-record-wins keeps canonical authority)');
  assert.ok(merged[1].includes('new-user'), 'canonical lines preserved after');
  assert.ok(fs.existsSync(p.join(canon, 'profiles', 'index.jsonl.pre-merge.bak')), 'canonical backed up');
  assert.ok(fs.existsSync(p.join(legacy, 'profiles', 'index.jsonl.migrated')), 'legacy file retired');
  assert.ok(!fs.existsSync(p.join(legacy, 'profiles', 'index.jsonl')), 'legacy file no longer live');
});

test('a store missing canonically is moved wholesale; second run is a no-op', () => {
  const { canon, legacy, legacyCwd } = setup();
  fs.mkdirSync(p.join(legacy, 'auth'), { recursive: true });
  fs.writeFileSync(p.join(legacy, 'auth', 'verify-codes.jsonl'), '{"code":"123456"}\n');
  fs.writeFileSync(p.join(legacy, 'auth', 'consumed-tokens.jsonl'), '{"jti":"t1"}\n');

  const { migrateLegacyData } = require('../lib/legacy-data-migrate');
  const r1 = migrateLegacyData({ cwd: legacyCwd, logger: quiet });
  assert.ok(r1.migrated);
  assert.ok(fs.existsSync(p.join(canon, 'auth', 'verify-codes.jsonl')), 'store moved to canonical root');
  assert.ok(!fs.existsSync(p.join(legacy, 'auth')), 'whole legacy dir moved when canonical was absent');

  const r2 = migrateLegacyData({ cwd: legacyCwd, logger: quiet });
  assert.strictEqual(r2.migrated, false, 'second run finds nothing to do');
});

test('binary files never overwrite an existing canonical file', () => {
  const { canon, legacy, legacyCwd } = setup();
  fs.mkdirSync(p.join(legacy, 'profiles'), { recursive: true });
  fs.mkdirSync(p.join(canon, 'profiles'), { recursive: true });
  fs.writeFileSync(p.join(legacy, 'profiles', 'profiles.csf'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(p.join(canon, 'profiles', 'profiles.csf'), Buffer.from([9, 9, 9]));

  const { migrateLegacyData } = require('../lib/legacy-data-migrate');
  migrateLegacyData({ cwd: legacyCwd, logger: quiet });
  assert.deepStrictEqual([...fs.readFileSync(p.join(canon, 'profiles', 'profiles.csf'))], [9, 9, 9],
    'canonical binary untouched');
  assert.ok(fs.existsSync(p.join(legacy, 'profiles', 'profiles.csf')), 'ambiguous binary left for the operator');
});

test('same-root launch (documented default) is a hard no-op', () => {
  const stateRoot = mkTmp('same-');
  process.env.UNISONA_STATE_DIR = stateRoot;
  fs.mkdirSync(p.join(stateRoot, 'data', 'profiles'), { recursive: true });
  fs.writeFileSync(p.join(stateRoot, 'data', 'profiles', 'index.jsonl'), '{"id":"u"}\n');
  const { migrateLegacyData } = require('../lib/legacy-data-migrate');
  const r = migrateLegacyData({ cwd: stateRoot, logger: quiet });
  assert.strictEqual(r.migrated, false);
  assert.ok(fs.existsSync(p.join(stateRoot, 'data', 'profiles', 'index.jsonl')), 'store untouched');
});
