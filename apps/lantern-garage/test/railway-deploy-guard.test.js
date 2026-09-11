'use strict';
/**
 * test/railway-deploy-guard.test.js — #3524.
 *
 * Production is Railway and runs whatever `railway up` last uploaded, and a deploy
 * restarts the users' trader. scripts/railway-deploy.mjs is the guarded way to ship:
 * it refuses during the US session unless forced, ships a clean checkout of a known
 * commit, and leaves build-info.json so /api/version names that commit. lib/git-version
 * reads it where there is no .git.
 * Run: node --test apps/lantern-garage/test/railway-deploy-guard.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// A hook run sets GIT_DIR, which would let git answer inside the temp dir below.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'railway-deploy.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);

// Eastern time for each instant is in its comment. 2026-09-11 is a Friday (EDT, UTC-4);
// 2026-01-15 is a Thursday (EST, UTC-5).
const CLOCK = [
  ['2026-09-11T15:00:00Z', true, 'Fri 11:00 EDT'],
  ['2026-09-11T13:24:00Z', false, 'Fri 09:24 EDT: before the margin'],
  ['2026-09-11T13:25:00Z', true, 'Fri 09:25 EDT: margin starts'],
  ['2026-09-11T20:04:00Z', true, 'Fri 16:04 EDT: margin still on'],
  ['2026-09-11T20:05:00Z', false, 'Fri 16:05 EDT: margin over'],
  ['2026-09-12T15:00:00Z', false, 'Sat 11:00 EDT'],
  ['2026-09-13T15:00:00Z', false, 'Sun 11:00 EDT'],
  ['2026-01-15T14:30:00Z', true, 'Thu 09:30 EST'],
  ['2026-01-15T20:30:00Z', true, 'Thu 15:30 EST'],
  ['2026-01-15T21:05:00Z', false, 'Thu 16:05 EST'],
];

test('the session clock: 09:25-16:05 ET on weekdays, DST handled', async () => {
  const { inSession } = await load();
  for (const [iso, want, label] of CLOCK) assert.strictEqual(inSession(new Date(iso)), want, label);
});

test('arguments: a plan by default; --yes, --force, --ref', async () => {
  const { parseArgs } = await load();
  assert.deepStrictEqual(parseArgs([]), { yes: false, force: false, ref: 'origin/master', help: false });
  assert.deepStrictEqual(parseArgs(['--yes', '--force', '--ref', 'v1.16.0']), { yes: true, force: true, ref: 'v1.16.0', help: false });
  assert.throws(() => parseArgs(['--prod']), /unknown argument/);
  assert.throws(() => parseArgs(['--ref']), /needs a value/);
});

test('--yes during the session is refused before git or railway runs', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--yes'], { encoding: 'utf8', env: { ...process.env, LANTERN_NOW: '2026-09-11T15:00:00Z', PATH: '' } });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /session is open/);
});

test('build-info content, and the LFS pointer check', async () => {
  const { buildInfo, isLfsPointer } = await load();
  assert.deepStrictEqual(buildInfo({ commit: 'abc', ref: 'origin/master', date: 'd', subject: 's', by: 'k', at: 'a' }),
    { commit: 'abc', ref: 'origin/master', date: 'd', subject: 's', deployedBy: 'k', deployedAt: 'a', via: 'scripts/railway-deploy.mjs' });
  assert.strictEqual(isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 12\n')), true);
  assert.strictEqual(isLfsPointer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false, 'a real PNG');
});

test('/api/version names the deployed commit where there is no .git', () => {
  const { getGitVersion } = require('../lib/git-version');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitver-'));
  try {
    const repoRoot = path.join(root, 'apps');   // Railway's layout: repoRoot is /app/apps
    fs.mkdirSync(repoRoot);
    assert.strictEqual(getGitVersion(repoRoot).commit, 'unknown', 'no git and no build-info: unknown, as before');
    fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ commit: 'abc123', ref: 'origin/master', date: '2026-09-11T20:00:00Z', deployedAt: '2026-09-11T20:20:00Z' }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.15.4' }));
    const v = getGitVersion(repoRoot);
    assert.deepStrictEqual([v.commit, v.branch, v.semver, v.source, v.deployedAt],
      ['abc123', 'origin/master', '1.15.4', 'build-info', '2026-09-11T20:20:00Z']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('where git works, git answers', () => {
  const { getGitVersion } = require('../lib/git-version');
  const v = getGitVersion(path.join(__dirname, '..', '..', '..'));
  assert.match(v.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(v.source, undefined);
});
