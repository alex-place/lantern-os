'use strict';
/**
 * test/stable-deploy-market-hold.test.js — the stable box's deploy waits for the close (2026-09-29).
 *
 * scripts/auto-deploy-stable.ps1 brings the stable worktree (the ARMED paper trader) up to master
 * every five minutes and restarts the server when server-side code changed. On 2026-09-29 four
 * merges to master between 13:54 and 14:12 ET rolled it three times in twenty minutes, and the fresh
 * process bought inside an hour bar the entry cadence had already spent. The script now holds a
 * deploy that needs a restart while the regular session is open (weekdays 09:25-16:05 ET, the same
 * window as scripts/railway-deploy.mjs).
 *
 * These pin: the hold sits BEFORE the worktree is touched; it needs a restart, a running server, no
 * -Force and no one-shot flag; a clock that cannot be read never blocks a deploy; and the clock
 * itself, against a table that crosses both daylight-saving changes (run through PowerShell where
 * one is installed, skipped where none is).
 * Run: node --test apps/lantern-garage/test/stable-deploy-market-hold.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'auto-deploy-stable.ps1');
const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const at = (needle) => { const i = src.indexOf(needle); assert.ok(i >= 0, 'the script holds: ' + needle); return i; };

test('the hold is decided before the worktree is touched', () => {
  const gate = at('HELD until 16:05 ET');
  assert.ok(at('$needRestart = ') < gate, 'the restart decision comes first');
  assert.ok(gate < at('reset --hard upstream/master'), 'a held deploy never resets the tree');
  assert.ok(gate < at('StopServer\n  if ($depsChanged) { NpmCi }'), 'and never stops the server');
});

test('the hold needs a restart, a running server, no -Force and no one-shot flag', () => {
  const line = src.split('\n').find((l) => l.includes('(InMarketSession $nowUtc)'));
  assert.ok(line, 'the gate line');
  for (const part of ['$holdOn', '$needRestart', '(ServerPid)', '-not $Force', '-not $flag']) assert.ok(line.includes(part), 'the gate asks for ' + part);
  assert.match(src, /\$holdOn = \(\$env:KEYSTONE_DEPLOY_MARKET_HOLD -ne '0'\)/, 'one env switch turns the hold off');
  assert.match(src, /if \(\$flag\) \{ Remove-Item \$NOWFLAG/, 'the flag is consumed by the run that uses it');
  const exitAfter = src.slice(src.indexOf('HELD until 16:05 ET')).split('\n').slice(0, 3).join('\n');
  assert.match(exitAfter, /exit 0/, 'a held run ends clean: the scheduler must not read it as a failure');
});

test('a server that is down is started inside the session, and a docs-only change still goes out', () => {
  // the gate names (ServerPid): with no listener it is false and the script runs on to "server not running -> starting"
  assert.ok(at('HELD until 16:05 ET') < at('server not running -> starting'));
  // and $needRestart is false for a change outside server.js / lib / routes / package*.json
  assert.match(src, /\$codeRe\s+= '\^\(apps\/lantern-garage\/server\(-dev\)\?\\\.js\|apps\/lantern-garage\/\(lib\|routes\)\/\|\.\*package\(-lock\)\?\\\.json\$\)'/);
});

test('a clock that cannot be read never blocks a deploy', () => {
  const fn = src.slice(at('function InMarketSession('), at('function EtClock('));
  assert.match(fn, /try \{[\s\S]*\} catch \{ return \$false \}/, 'fail open: behave as before the hold');
});

test('what the hold adds is ASCII (Windows PowerShell 5.1 reads scripts as cp1252)', () => {
  const block = src.slice(at('# --- MARKET-HOURS HOLD'), at('# =================== main'));
  const gate = src.slice(at('# --- market-hours hold:'), at('# --- update the worktree to master'));
  assert.ok(!/[^\x00-\x7F]/.test(block + gate));
});

// Eastern time for each instant is in its comment.
const CLOCK = [
  ['2026-09-29T13:24:59Z', false, 'Tue 09:24:59 EDT, a second before the window'],
  ['2026-09-29T13:25:00Z', true, 'Tue 09:25:00 EDT, the window opens'],
  ['2026-09-29T17:56:00Z', true, 'Tue 13:56 EDT, the first restart of 2026-09-29'],
  ['2026-09-29T18:16:00Z', true, 'Tue 14:16 EDT, the restart that opened the spent bar'],
  ['2026-09-29T20:04:59Z', true, 'Tue 16:04:59 EDT, the last second of the window'],
  ['2026-09-29T20:05:00Z', false, 'Tue 16:05:00 EDT, the window is closed'],
  ['2026-09-30T00:14:00Z', false, 'Tue 20:14 EDT, an evening deploy'],
  ['2026-09-30T08:00:00Z', false, 'Wed 04:00 EDT, pre-market'],
  ['2026-10-02T19:59:00Z', true, 'Fri 15:59 EDT'],
  ['2026-10-03T16:00:00Z', false, 'Sat 12:00 EDT'],
  ['2026-10-04T16:00:00Z', false, 'Sun 12:00 EDT'],
  ['2026-10-05T03:30:00Z', false, 'Sun 23:30 EDT, already Monday in UTC'],
  ['2026-11-02T13:30:00Z', false, 'Mon 08:30 EST, after the clocks went back (09:30 if EDT were assumed)'],
  ['2026-11-02T14:24:59Z', false, 'Mon 09:24:59 EST'],
  ['2026-11-02T14:25:00Z', true, 'Mon 09:25:00 EST'],
  ['2026-11-02T21:04:59Z', true, 'Mon 16:04:59 EST'],
  ['2026-11-02T21:05:00Z', false, 'Mon 16:05:00 EST'],
  ['2027-03-12T14:25:00Z', true, 'Fri 09:25 EST, before the clocks go forward'],
  ['2027-03-15T13:25:00Z', true, 'Mon 09:25 EDT, after the clocks went forward'],
  ['2027-03-15T13:24:59Z', false, 'Mon 09:24:59 EDT'],
];

function powershell() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', "[System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time').Id"], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && /Eastern/.test(String(r.stdout))) return exe;
  }
  return null;
}

test('the clock: weekdays 09:25-16:05 Eastern, across both daylight-saving changes', (t) => {
  const exe = powershell();
  if (!exe) { t.skip('no PowerShell that knows the Eastern time zone on this machine'); return; }
  // the helpers are taken from the script as text, never retyped here
  const helpers = src.slice(at('function EtNow('), at('# =================== main'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-hold-'));
  const file = path.join(dir, 'clock.ps1');
  const body = [helpers, "$inv = [System.Globalization.CultureInfo]::InvariantCulture", "$adj = [System.Globalization.DateTimeStyles]::AdjustToUniversal",
    ...CLOCK.map(([iso]) => `Write-Output ('${iso} ' + (InMarketSession ([datetime]::Parse('${iso}', $inv, $adj))))`)].join('\n');
  fs.writeFileSync(file, body);
  const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, 'the helpers run: ' + String(r.stderr).slice(0, 400));
  const got = new Map(String(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => { const [iso, v] = l.trim().split(' '); return [iso, v === 'True']; }));
  for (const [iso, want, what] of CLOCK) assert.strictEqual(got.get(iso), want, `${iso} (${what})`);
  assert.strictEqual(got.size, CLOCK.length);
});
