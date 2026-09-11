'use strict';
/**
 * test/release-deploy-market-guard.test.js — #3524.
 *
 * ops/gce/lantern-release-deploy.sh restarts the production app, and that app is also
 * the users' trader. A new release found during the US session must wait for the
 * close; after the close, and on weekends, it ships; an operator can force it.
 *
 * Runs the REAL script with curl / git / npm / systemctl / logger / sleep replaced by
 * recording stubs on PATH; node stays real (the script's clock check runs on it).
 * Needs bash with GNU grep -P, as on CI's Linux runners; skipped where that's missing.
 * Run: node --test apps/lantern-garage/test/release-deploy-market-guard.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = process.env.DEPLOY_SCRIPT || path.join(__dirname, '..', '..', '..', 'ops', 'gce', 'lantern-release-deploy.sh');
const BASH = process.env.BASH_BIN || 'bash';
const usable = (() => {
  const r = spawnSync(BASH, ['-c', 'printf ab | grep -oP "a\\Kb"; command -v node >/dev/null && echo node'], { encoding: 'utf8' });
  return r.status === 0 && /^b\s+node/.test(r.stdout || '');
})();
const skip = usable ? false : 'needs bash + GNU grep -P + node on PATH';

// Eastern time for each instant is in its comment; 2026-09-11 is a Friday, EDT (UTC-4);
// 2026-01-15 is a Thursday, EST (UTC-5).
const CLOCK = [
  ['2026-09-11T15:00:00Z', 'yes', 'Fri 11:00 EDT'],
  ['2026-09-11T13:24:00Z', 'no', 'Fri 09:24 EDT: before the margin'],
  ['2026-09-11T13:25:00Z', 'yes', 'Fri 09:25 EDT: margin starts'],
  ['2026-09-11T20:04:00Z', 'yes', 'Fri 16:04 EDT: margin still on'],
  ['2026-09-11T20:05:00Z', 'no', 'Fri 16:05 EDT: margin over'],
  ['2026-09-12T15:00:00Z', 'no', 'Sat 11:00 EDT'],
  ['2026-09-13T15:00:00Z', 'no', 'Sun 11:00 EDT'],
  ['2026-01-15T14:30:00Z', 'yes', 'Thu 09:30 EST'],
  ['2026-01-15T20:30:00Z', 'yes', 'Thu 15:30 EST'],
  ['2026-01-15T21:05:00Z', 'no', 'Thu 16:05 EST'],
];
const IN_SESSION = '2026-09-11T15:00:00Z';
const AFTER_CLOSE = '2026-09-11T20:20:00Z';
const SATURDAY = '2026-09-12T15:00:00Z';

test('the session clock: 09:25-16:05 ET on weekdays, DST handled', { skip }, () => {
  for (const [now, want, label] of CLOCK) {
    const r = spawnSync(BASH, [SCRIPT, '--session'], { encoding: 'utf8', env: { ...process.env, LANTERN_NOW: now } });
    assert.strictEqual(r.status, 0, label);
    assert.strictEqual(r.stdout.trim(), want, label);
  }
});

function run({ now, latest = 'v9.9.9', current = 'v1.0.0', env = {}, flag = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log').replace(/\\/g, '/');
  const stub = (name, body = '') => {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  stub('curl', `case "$*" in *releases/latest*) echo '{"tag_name": "${latest}"}';; *) echo 200;; esac`);
  for (const n of ['git', 'npm', 'systemctl', 'logger', 'sleep']) stub(n);
  const state = path.join(dir, 'state', 'deployed-release.tag');
  fs.mkdirSync(path.dirname(state));
  fs.writeFileSync(state, current + '\n');
  const flagFile = path.join(dir, 'state', 'deploy-now');
  if (flag) fs.writeFileSync(flagFile, '');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(checkout);
  const r = spawnSync(BASH, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: dir, LANTERN_NOW: now,
      LANTERN_RELEASE_STATE: state, LANTERN_CHECKOUT: checkout, LANTERN_DEPLOY_FORCE_FLAG: flagFile, ...env,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const out = { status: r.status, stdout: r.stdout + r.stderr, calls, state: fs.readFileSync(state, 'utf8').trim(), flagLeft: fs.existsSync(flagFile) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
const deployed = (o, tag) => {
  assert.strictEqual(o.status, 0, o.stdout);
  assert.match(o.calls, new RegExp(`git checkout -f ${tag}`), o.calls);
  assert.match(o.calls, /npm install --omit=dev/);
  assert.match(o.calls, /systemctl restart lantern\.service/);
  assert.strictEqual(o.state, tag);
};

test('a release found in session waits: no checkout, no npm install, no restart', { skip }, () => {
  const o = run({ now: IN_SESSION });
  assert.strictEqual(o.status, 0, o.stdout);
  assert.match(o.stdout, /waits for the close/);
  assert.doesNotMatch(o.calls, /^(git|npm|systemctl) /m, 'nothing may touch the checkout or the service in session');
  assert.strictEqual(o.state, 'v1.0.0', 'the state file still names the running release');
});

test('after the close it ships, and on a weekend day too', { skip }, () => {
  deployed(run({ now: AFTER_CLOSE }), 'v9.9.9');
  deployed(run({ now: SATURDAY }), 'v9.9.9');
});

test('an operator can force it in session, by env or by the one-shot flag', { skip }, () => {
  deployed(run({ now: IN_SESSION, env: { LANTERN_DEPLOY_FORCE: '1' } }), 'v9.9.9');
  const o = run({ now: IN_SESSION, flag: true });
  deployed(o, 'v9.9.9');
  assert.match(o.stdout, /in-session deploy forced/);
  assert.strictEqual(o.flagLeft, false, 'the flag is consumed');
});

test('the flag is one-shot even when there is nothing to deploy', { skip }, () => {
  const o = run({ now: IN_SESSION, latest: 'v1.0.0', flag: true });
  assert.match(o.stdout, /already on v1\.0\.0/);
  assert.doesNotMatch(o.calls, /^(git|npm|systemctl) /m);
  assert.strictEqual(o.flagLeft, false, 'a stale flag must not force the NEXT release mid-session');
});
