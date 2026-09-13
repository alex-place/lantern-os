'use strict';
/**
 * test/trader-heartbeat.test.js — #3525.
 *
 * The four cases the issue asks for are four assertions on a pure function, because
 * `decide` takes its clock, its session, its budget and its mode as arguments. Nothing
 * here needs a market to be open, a mailer to exist, or a process to kill.
 *
 * The rest of the file pins the things that make this safe to run next to real money:
 * that it is OFF unless someone armed it, that it cannot alert in a loop, that the
 * restart budget survives the exit it caused, and that the beat is a COMPLETED scan
 * rather than a tick.
 *
 * Run: node --test apps/lantern-garage/test/trader-heartbeat.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The ledger path is resolved when the module loads, so this has to come first.
const LEDGER = path.join(os.tmpdir(), 'lantern-heartbeat-test-' + process.pid + '.json');
process.env.TRADER_HEARTBEAT_FILE = LEDGER;
const HB = require('../lib/trader-heartbeat');

const T0 = Date.UTC(2026, 8, 15, 15, 0, 0);      // a Tuesday, mid-session
const MIN = 60000;
const base = (over) => Object.assign({
  mode: 'restart',
  inSession: true,
  lastScanAt: T0 - 9 * MIN,
  startedAt: T0 - 60 * MIN,
  now: T0,
  staleMs: 5 * MIN,
  restarts: 0,
  maxRestarts: 3,
  lastAlertAt: null,
  cooldownMs: 15 * MIN,
}, over || {});

// ── the four cases #3525 names ───────────────────────────────────────────────

test('stale in session: restart', () => {
  const v = HB.decide(base());
  assert.strictEqual(v.action, 'restart');
  assert.strictEqual(v.reason, 'stale');
  assert.strictEqual(v.ageMs, 9 * MIN);
});

test('fresh: nothing', () => {
  const v = HB.decide(base({ lastScanAt: T0 - 90000 }));   // 1.5 min — a normal gap
  assert.strictEqual(v.action, 'none');
  assert.strictEqual(v.reason, 'fresh');
});

test('market closed: nothing, however stale', () => {
  const v = HB.decide(base({ inSession: false, lastScanAt: T0 - 12 * 60 * MIN }));
  assert.strictEqual(v.action, 'none');
  assert.strictEqual(v.reason, 'market_closed');
});

test('budget spent: alert, and never another restart', () => {
  const v = HB.decide(base({ restarts: 3 }));
  assert.strictEqual(v.action, 'alert');
  assert.strictEqual(v.reason, 'restart_budget_spent');
  // One over, too — a counter that only compares equal would let the fourth through.
  assert.strictEqual(HB.decide(base({ restarts: 9 })).action, 'alert');
});

// ── the postures ─────────────────────────────────────────────────────────────

test('unset is off, and off is off even when everything else says restart', () => {
  /* This module can end the process, and the operator's two ARMED boxes run the same
     file. Shipping it armed would mean its first real-world test happened on a live
     account. */
  for (const mode of [undefined, '', 'off', '0', 'no', 'true']) {
    assert.strictEqual(HB.decide(base({ mode })).action, 'none', String(mode) + ' armed it');
  }
  assert.strictEqual(HB.config({}).mode, 'off');
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT: '0' }).mode, 'off');
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT: 'alert' }).mode, 'alert');
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT: ' Restart ' }).mode, 'restart');
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT: '1' }).mode, 'restart');
});

test('alert mode watches and mails but never exits', () => {
  const v = HB.decide(base({ mode: 'alert' }));
  assert.strictEqual(v.action, 'alert');
  assert.strictEqual(v.reason, 'stale');
});

test('an alert does not repeat until the cooldown is up', () => {
  // Once the budget is spent the stall lasts until a human looks at it. Without this
  // that is one mail per check, forever.
  const spent = { mode: 'alert', lastAlertAt: T0 - 5 * MIN };
  assert.strictEqual(HB.decide(base(spent)).action, 'none');
  assert.match(HB.decide(base(spent)).reason, /_muted$/);
  assert.strictEqual(HB.decide(base({ mode: 'alert', lastAlertAt: T0 - 16 * MIN })).action, 'alert');
});

// ── the threshold ────────────────────────────────────────────────────────────

test('the stale threshold cannot be set below the loop\'s own rhythm', () => {
  /* #3525 asked for 2x the cadence. At 60s cadence with a scan that takes 45-60s, a
     HEALTHY loop is silent for about two minutes between completions — 2x would page on
     a working trader. Five minutes is the default, and 2x cadence is the floor a
     hand-set value cannot go under. */
  assert.strictEqual(HB.config({}).staleMs, 5 * MIN);
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT_STALE_MS: '30000' }).staleMs, 2 * MIN);
  assert.strictEqual(HB.config({ TRADER_HEARTBEAT_STALE_MS: '600000' }).staleMs, 10 * MIN);
  // A slower cadence raises the floor with it.
  const slow = HB.config({ TRADER_AUTOSCAN_MS: '300000', TRADER_HEARTBEAT_STALE_MS: '60000' });
  assert.strictEqual(slow.staleMs, 10 * MIN);
});

test('a trader that booted and never scanned is measured from boot', () => {
  // "No scan has completed" has to cover the process that came up wedged, which has no
  // last-scan time at all.
  const v = HB.decide(base({ lastScanAt: null, startedAt: T0 - 7 * MIN }));
  assert.strictEqual(v.action, 'restart');
  assert.strictEqual(v.ageMs, 7 * MIN);
  assert.strictEqual(HB.decide(base({ lastScanAt: null, startedAt: T0 - MIN })).action, 'none');
});

// ── the beat is a completed scan ─────────────────────────────────────────────

test('ticking is not a heartbeat', () => {
  /* A wedged broker session leaves the loop ticking on schedule while every scan throws
     into the catch. That is a dead trader, and a watchdog counting ticks would call it
     healthy. */
  HB._reset(T0 - 60 * MIN);
  for (let i = 0; i < 20; i += 1) HB.ticked(T0 - (20 - i) * MIN);
  assert.strictEqual(HB._state.ticks, 20);
  assert.strictEqual(HB._state.lastScanAt, null);
  const v = HB.decide(base({ lastScanAt: HB._state.lastScanAt, startedAt: HB._state.startedAt }));
  assert.strictEqual(v.action, 'restart', 'a loop that only ticks reads as alive');
  HB.scanned(T0);
  assert.strictEqual(HB.decide(base({ lastScanAt: HB._state.lastScanAt })).action, 'none');
});

// ── the ledger ───────────────────────────────────────────────────────────────

test('the restart budget survives the exit it caused', () => {
  /* An in-memory count would reset with the process it just killed and cap nothing at
     all — which is the whole reason the budget exists. */
  try { fs.unlinkSync(LEDGER); } catch (_e) { /* not there */ }
  assert.deepStrictEqual(HB.readRestarts(T0), []);
  HB.recordRestart(T0 - 50 * MIN);
  HB.recordRestart(T0 - 20 * MIN);
  assert.strictEqual(HB.readRestarts(T0).length, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).restarts.length, 2);
  // Rolling hour, not a running total: yesterday's three restarts are not today's budget.
  assert.strictEqual(HB.readRestarts(T0 + 30 * MIN).length, 1);
  assert.strictEqual(HB.readRestarts(T0 + 24 * 60 * MIN).length, 0);
});

test('an unreadable ledger does not mean "never restart"', () => {
  // Failing closed here would turn a recoverable stall into a permanent one.
  fs.writeFileSync(LEDGER, 'not json {');
  assert.deepStrictEqual(HB.readRestarts(T0), []);
  fs.writeFileSync(LEDGER, JSON.stringify({ restarts: 'nonsense' }));
  assert.deepStrictEqual(HB.readRestarts(T0), []);
  try { fs.unlinkSync(LEDGER); } catch (_e) { /* fine */ }
});

// ── check(): the order things happen in ──────────────────────────────────────

function harness(over) {
  const calls = { sent: [], exited: [], recorded: [] };
  const deps = Object.assign({
    env: { TRADER_HEARTBEAT: '1', TRADER_HEARTBEAT_EMAIL: 'ops@example.com' },
    inSession: () => true,
    readRestarts: () => [],
    recordRestart: (t) => { calls.recorded.push(t); },
    exit: (code) => { calls.exited.push(code); },
    send: async (opts) => { calls.sent.push(opts); return { ok: true }; },
    configured: () => true,
  }, over || {});
  return { calls, deps };
}

test('a restart is mailed before it happens, and exits non-zero', async () => {
  // An unawaited send would never leave the process it is about to end.
  HB._reset(T0 - 60 * MIN);
  const { calls, deps } = harness();
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'restart');
  assert.strictEqual(calls.sent.length, 1);
  assert.deepStrictEqual(calls.exited, [1]);
  assert.strictEqual(calls.recorded.length, 1);
  assert.match(calls.sent[0].subject, /restarting/i);
  assert.match(calls.sent[0].text, /never \(since boot\)/);
});

test('alert mode mails and leaves the process alone', async () => {
  HB._reset(T0 - 60 * MIN);
  const { calls, deps } = harness({ env: { TRADER_HEARTBEAT: 'alert', TRADER_HEARTBEAT_EMAIL: 'ops@example.com' } });
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'alert');
  assert.deepStrictEqual(calls.exited, []);
  assert.deepStrictEqual(calls.recorded, []);
  assert.strictEqual(calls.sent.length, 1);
});

test('a stall is still logged when no mailer or address is configured', async () => {
  // The alert is best-effort; the restart is not conditional on it.
  HB._reset(T0 - 60 * MIN);
  const { calls, deps } = harness({ env: { TRADER_HEARTBEAT: '1' } });   // no address
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'restart');
  assert.strictEqual(calls.sent.length, 0);
  assert.deepStrictEqual(calls.exited, [1]);
});

test('a mailer that throws does not stop the restart', async () => {
  HB._reset(T0 - 60 * MIN);
  const { calls, deps } = harness({ send: async () => { throw new Error('resend down'); } });
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'restart');
  assert.deepStrictEqual(calls.exited, [1]);
});

test('an address with no mailer behind it still restarts, and says why it did not mail', async () => {
  /* The likeliest misconfiguration: TRADER_HEARTBEAT_EMAIL set, RESEND_API_KEY never
     added. It used to take the silent branch — no mail and no reason given. */
  HB._reset(T0 - 60 * MIN);
  const { calls, deps } = harness({ configured: () => false });
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'restart');
  assert.strictEqual(calls.sent.length, 0);
  assert.deepStrictEqual(calls.exited, [1]);
});

test('the alert says which of the three reasons it is', async () => {
  /* Caught on a live run, not by a test: an alert-mode alert with an untouched budget
     announced "this hour's restart budget is spent". Three paths reach the same mail and
     they are not the same news. */
  HB._reset(T0 - 60 * MIN);
  const watch = harness({ env: { TRADER_HEARTBEAT: 'alert', TRADER_HEARTBEAT_EMAIL: 'ops@example.com' } });
  await HB.check(T0, watch.deps);
  assert.match(watch.calls.sent[0].subject, /watching only/);
  assert.match(watch.calls.sent[0].text, /Watching only/);
  assert.doesNotMatch(watch.calls.sent[0].text, /budget is spent/);

  HB._reset(T0 - 60 * MIN);
  const spent = harness({ readRestarts: () => [T0 - MIN, T0 - 2 * MIN, T0 - 3 * MIN] });
  await HB.check(T0, spent.deps);
  assert.match(spent.calls.sent[0].subject, /restart budget spent/);
  assert.deepStrictEqual(spent.calls.exited, [], 'it restarted past its own budget');

  HB._reset(T0 - 60 * MIN);
  const go = harness();
  await HB.check(T0, go.deps);
  assert.match(go.calls.sent[0].subject, /restarting/);
});

test('a healthy loop is silent: nothing sent, nothing killed', async () => {
  HB._reset(T0 - 60 * MIN);
  HB.scanned(T0 - 30000);
  const { calls, deps } = harness();
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.action, 'none');
  assert.strictEqual(v.reason, 'fresh');
  assert.deepStrictEqual([calls.sent.length, calls.exited.length], [0, 0]);
});

test('closed for the weekend: silent, whatever the clock says', async () => {
  HB._reset(T0 - 12 * 60 * MIN);
  const { calls, deps } = harness({ inSession: () => false });
  const v = await HB.check(T0, deps);
  assert.strictEqual(v.reason, 'market_closed');
  assert.deepStrictEqual([calls.sent.length, calls.exited.length], [0, 0]);
});

// ── starting it ──────────────────────────────────────────────────────────────

test('it will not start without being told when the session is', () => {
  /* The trading loop owns the one definition of US market hours. A second copy in here
     would be a second thing to keep right, so the predicate is injected — and a caller
     that forgets gets no watchdog rather than a watchdog that guesses. */
  const saved = process.env.TRADER_HEARTBEAT;
  process.env.TRADER_HEARTBEAT = '1';
  try {
    assert.strictEqual(HB.start({}), null);
    assert.strictEqual(HB.start({ inSession: 'yes' }), null);
    const t = HB.start({ inSession: () => false });
    assert.ok(t, 'it did not start with a predicate');
    HB.stop();
  } finally {
    if (saved == null) delete process.env.TRADER_HEARTBEAT; else process.env.TRADER_HEARTBEAT = saved;
  }
});

test('unset means no timer at all', () => {
  const saved = process.env.TRADER_HEARTBEAT;
  delete process.env.TRADER_HEARTBEAT;
  try {
    assert.strictEqual(HB.start({ inSession: () => true }), null);
  } finally {
    if (saved != null) process.env.TRADER_HEARTBEAT = saved;
  }
});

// ── the wiring ───────────────────────────────────────────────────────────────

const TRADING = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading.js'), 'utf8');

test('the beat is recorded where a scan CYCLE completes, not at the bottom of the tick', () => {
  const tick = TRADING.slice(TRADING.indexOf('async function _autoscanTick()'),
    TRADING.indexOf('if (traderAgent && process.env.TRADER_AUTOSCAN'));
  const beat = tick.indexOf('traderHeartbeat.scanned()');
  const caught = tick.indexOf("console.error('[Trading] autoscan failed:'");
  assert.ok(beat > 0, 'the loop never records a heartbeat');
  assert.ok(beat < caught, 'the beat is outside the try, so a failing scan still counts as one');
  assert.ok(tick.indexOf('traderHeartbeat.ticked()') > caught, 'liveness is recorded inside the try');
});

test('the watchdog is handed the loop\'s own session predicate', () => {
  assert.match(TRADING, /traderHeartbeat\.start\(\{\s*[\s\S]{0,200}?inSession:/);
  assert.match(TRADING, /inSession: \(\) => _isUsMarketHours\(\)/);
  // Extended hours count only when a toggle actually has the loop running in them.
  assert.match(TRADING, /_isUsExtendedHours\(\) && \(_extendedTrading \|\| _extendedExitsOnly\(\)\)/);
});

test('a stalled loop is visible on the status endpoint', () => {
  const status = fs.readFileSync(path.join(__dirname, '..', 'lib', 'status.js'), 'utf8');
  assert.match(status, /trader_heartbeat: getTraderHeartbeat\(\)/);
  const s = HB.status();
  for (const k of ['mode', 'watching', 'lastScanAt', 'ageMs', 'staleMs', 'scans', 'ticks', 'restartsThisHour']) {
    assert.ok(k in s, 'status() omits ' + k);
  }
  // It is a public endpoint: liveness, never an address.
  assert.ok(!JSON.stringify(s).includes('@'), 'status() leaks the alert address');
});

test('the platform actually restarts what the watchdog exits', () => {
  /* exit(1) is only a restart if something restarts it. ON_FAILURE with three retries
     left the service DOWN after the third crash — for a trader that is the worst of both
     worlds: it dies quietly mid-session and nothing brings it back. */
  const rw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'railway.json'), 'utf8'));
  assert.strictEqual(rw.deploy.restartPolicyType, 'ALWAYS');
});

test('every knob is documented where an operator would look', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
  for (const k of ['TRADER_HEARTBEAT', 'TRADER_HEARTBEAT_EMAIL', 'TRADER_HEARTBEAT_STALE_MS',
    'TRADER_HEARTBEAT_MAX_RESTARTS', 'TRADER_HEARTBEAT_COOLDOWN_MS']) {
    assert.ok(env.includes(k), k + ' is not in .env.example');
  }
});

test('the web half of a split never starts a watchdog it could not feed', () => {
  /* The web process answers routes and runs no scan loop, so a watchdog there would find
     the heartbeat permanently stale and restart the WEBSITE every five minutes. What
     stops it is that both live in the same block: applyRoleEnv() sets TRADER_AUTOSCAN=0
     for the web role, and that is the block's own kill switch. */
  const role = fs.readFileSync(path.join(__dirname, '..', 'lib', 'process-role.js'), 'utf8');
  assert.match(role, /if \(r === 'web'\) env\.TRADER_AUTOSCAN = '0';/);
  const gate = TRADING.indexOf("if (traderAgent && process.env.TRADER_AUTOSCAN !== '0')");
  assert.ok(gate > 0 && gate < TRADING.indexOf('traderHeartbeat.start('),
    'the watchdog starts outside the block the web role switches off');
});

test('something restarts what it kills, and the supervisor is it', () => {
  /* exit(1) is only a restart because lib/split-supervisor.js is the trader's parent in
     production and already brings an exited child back. Railway's policy is the outer
     net, for the supervisor itself. */
  const sup = fs.readFileSync(path.join(__dirname, '..', 'lib', 'split-supervisor.js'), 'utf8');
  assert.match(sup, /restarting in/, 'the supervisor no longer restarts a dead child');
  assert.match(sup, /const backoffMs = /);
});

test.after(() => { try { fs.unlinkSync(LEDGER); } catch (_e) { /* already gone */ } });
