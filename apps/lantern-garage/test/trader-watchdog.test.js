'use strict';

/**
 * trader-watchdog.test.js — the watchdog must actually FIRE.
 *
 * A health check that only ever returns "ok" is worse than none: it converts an
 * outage into a clean bill of health. On 2026-08-05 the trader was verified
 * healthy mid-morning and then sat idle for the rest of the session, because
 * every failure mode below looks identical to a quiet market.
 *
 * These tests pin that each of those modes produces a PROBLEM, and — just as
 * important — that a genuinely healthy trader does NOT.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const wd = require(path.join(__dirname, '..', '..', '..', 'scripts', 'trader-watchdog'));

const HEALTHY = {
  open: true,
  httpStatus: 200,
  lock: { pid: 3424, armed: true },
  lockAgeMs: 5_000,
  stateAgeMs: 30_000,
  stateMissing: false,
  today: { entry: 2, exit: 1, skip: 40, entry_blocked: 0, error: 0 },
};

test('a healthy armed trader during market hours is ok', () => {
  const r = wd.evaluate(HEALTHY);
  assert.strictEqual(r.verdict, 'ok', r.problems.join(' | '));
});

test('THE 2026-08-05 BUG: a DISARMED process holding the lock is a PROBLEM', () => {
  const r = wd.evaluate({ ...HEALTHY, lock: { pid: 9948, armed: false } });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /DISARMED pid 9948.*locked out/);
});

test('no lock at all during market hours is a PROBLEM (trader not scanning)', () => {
  const r = wd.evaluate({ ...HEALTHY, lock: null });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /not scanning/);
});

test('server answering but scan loop stalled is a PROBLEM', () => {
  // The nastiest mode: HTTP 200, lock healthy, everything "up" — and no scans.
  const r = wd.evaluate({ ...HEALTHY, stateAgeMs: 45 * 60 * 1000 });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /scan loop stalled/);
});

test('a dead lock holder (stale heartbeat) is a PROBLEM', () => {
  const r = wd.evaluate({ ...HEALTHY, lockAgeMs: 10 * 60 * 1000 });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /heartbeat stale/);
});

test('server down is a PROBLEM whether or not the market is open', () => {
  for (const open of [true, false]) {
    const r = wd.evaluate({ ...HEALTHY, open, httpStatus: 0 });
    assert.strictEqual(r.verdict, 'PROBLEM');
    assert.match(r.problems.join(' '), /not answering/);
  }
});

test('refused entries are a PROBLEM even when everything else is green', () => {
  const r = wd.evaluate({ ...HEALTHY, today: { ...HEALTHY.today, entry_blocked: 25 } });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /25 entry_blocked/);
});

test('lock checks do NOT fire outside market hours — no overnight false alarms', () => {
  const r = wd.evaluate({ ...HEALTHY, open: false, lock: null, stateAgeMs: 12 * 60 * 60 * 1000 });
  assert.strictEqual(r.verdict, 'ok', r.problems.join(' | '));
});

test('a missing state file is a PROBLEM regardless of session', () => {
  const r = wd.evaluate({ ...HEALTHY, open: false, stateMissing: true });
  assert.strictEqual(r.verdict, 'PROBLEM');
  assert.match(r.problems.join(' '), /state\.json missing/);
});

test('summarise counts events and splits entries by tier', () => {
  const { today, tiers } = wd.summarise([
    { event: 'entry', tier: 'A' }, { event: 'entry', tier: 'A' }, { event: 'entry', tier: 'A+' },
    { event: 'entry', tier: 'B' }, { event: 'exit', status: 'error' },
    { event: 'skip' }, { event: 'entry_blocked' }, null,
  ]);
  assert.deepStrictEqual(tiers, { A: 2, 'A+': 1, B: 1 });
  assert.strictEqual(today.entry, 4);
  assert.strictEqual(today.exit, 1);
  assert.strictEqual(today.skip, 1);
  assert.strictEqual(today.entry_blocked, 1);
  assert.strictEqual(today.error, 1);
});

test('market hours: weekend is closed, and the force hook overrides the clock', () => {
  const saved = process.env.WATCHDOG_FORCE_OPEN;
  try {
    delete process.env.WATCHDOG_FORCE_OPEN;
    // 2026-08-08 is a Saturday.
    assert.strictEqual(wd.marketOpenNow(new Date('2026-08-08T15:00:00Z')), false);
    process.env.WATCHDOG_FORCE_OPEN = '1';
    assert.strictEqual(wd.marketOpenNow(new Date('2026-08-08T15:00:00Z')), true);
    process.env.WATCHDOG_FORCE_OPEN = '0';
    assert.strictEqual(wd.marketOpenNow(new Date('2026-08-06T15:00:00Z')), false);
  } finally {
    if (saved === undefined) delete process.env.WATCHDOG_FORCE_OPEN; else process.env.WATCHDOG_FORCE_OPEN = saved;
  }
});
