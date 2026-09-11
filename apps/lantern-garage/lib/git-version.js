'use strict';
/**
 * git-version.js — which code is this server running? Backs GET /api/version.
 *
 * Normally git answers. Production has no git: Railway runs an upload made by
 * scripts/railway-deploy.mjs, and .railwayignore keeps .git out of it, so /api/version
 * said commit "unknown" and nobody could tell which code was live (#3524). The deploy
 * script leaves build-info.json at the root of the upload; this reads it when git can't
 * answer. On Railway repoRoot is /app/apps, so it looks in repoRoot and in its parent.
 */
const fs = require('fs');
const path = require('path');
const { safeExec } = require('./safe-exec');

function _readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}
function _nearest(repoRoot, name) {
  for (const dir of [repoRoot, path.join(repoRoot, '..')]) {
    const j = _readJson(path.join(dir, name));
    if (j) return j;
  }
  return null;
}
// The version source of truth is the ROOT package.json (bumped on every release, e.g.
// 1.9.6). public/version.json routinely lags the real build (#2334), so it comes second,
// then the git tag.
function _semver(repoRoot, fallback) {
  const root = _readJson(path.join(repoRoot, 'package.json'));
  if (root && root.version) return root.version;
  const vj = _readJson(path.join(repoRoot, 'apps', 'lantern-garage', 'public', 'version.json'));
  return (vj && vj.version) || fallback;
}

function getGitVersion(repoRoot) {
  try {
    // No shell (lib/safe-exec). stderr ignored: without a .git, every /api/version call
    // printed "fatal: not a git repository" into the server log.
    const git = (...args) => String(safeExec(['git', ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    const commit = git('rev-parse', 'HEAD');
    const tag = git('describe', '--tags', '--always');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const date = git('log', '-1', '--format=%cI');
    return { commit, tag, branch, date, semver: _semver(repoRoot, tag) };
  } catch (_e) {
    const b = _nearest(repoRoot, 'build-info.json');
    if (b && b.commit) {
      const pkg = _nearest(repoRoot, 'package.json');
      return {
        commit: b.commit, tag: b.ref || 'unknown', branch: b.ref || 'unknown',
        date: b.date || new Date().toISOString(), semver: (pkg && pkg.version) || 'unknown',
        deployedAt: b.deployedAt || null, source: 'build-info',
      };
    }
    return { commit: 'unknown', tag: 'unknown', branch: 'unknown', date: new Date().toISOString(), semver: 'unknown' };
  }
}

module.exports = { getGitVersion };
