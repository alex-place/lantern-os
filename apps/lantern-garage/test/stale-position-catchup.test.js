'use strict';

/**
 * stale-position-catchup.test.js — a missed exit window must degrade to a worse
 * fill, never to NO exit.
 *
 * 2026-07-29: the engine was down across the only exit path (09:31–09:50 ET), a
 * 10-leg 0-DTE call ladder was never sold, and it expired worthless — a −$2,006
 * total loss. The server was back at 15:38 ET, still inside the session: a
 * catch-up would have sold them. This locks the guarantee.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const OT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'overnight-trader.js'), 'utf8');

// The window logic is inline in tick(); assert on its shape, then on the pure
// predicate it encodes (recomputed here exactly as written).
const shouldExit = (hm, stale) => stale && ((hm >= 931 && hm <= 950) || (hm > 950 && hm <= 1555));

test('the exit path is no longer a single 20-minute window', () => {
  assert.match(OT, /const inCatchUp = hm > 950 && hm <= 1555/, 'catch-up branch exists');
  assert.match(OT, /staleOpen && \(inExitWindow \|\| inCatchUp\)/, 'either path triggers the exit');
});

test('a stale position exits at ANY point in the session, not just 09:31-09:50', () => {
  assert.ok(shouldExit(935, true),  'normal window still exits');
  assert.ok(shouldExit(1038, true), 'mid-morning catch-up exits');   // the 07-29 recovery time
  assert.ok(shouldExit(1538, true), '15:38 catch-up exits — the fill that was missed');
  assert.ok(shouldExit(1554, true), 'still exits just before the close');
});

test('it does NOT fire outside the session or on a same-day position', () => {
  assert.ok(!shouldExit(1556, true), 'past 15:55 → leave it, the close is seconds away');
  assert.ok(!shouldExit(800, true),  'pre-market → no');
  assert.ok(!shouldExit(1038, false), 'a position opened TODAY is not stale');
});

test('catch-ups are flagged so they do not pollute measured expectancy', () => {
  assert.match(OT, /const lateExit = !inExitWindow/, 'lateness is computed');
  const exitRows = OT.match(/_append\(\{ phase: 'exit'[^;]*\);/g) || [];
  assert.ok(exitRows.length >= 4, 'found the exit rows');
  for (const row of exitRows) assert.match(row, /late: lateExit/, `exit row missing the late flag: ${row.slice(0, 70)}`);
});

test('the catch-up announces itself once, with the reason', () => {
  assert.match(OT, /phase: 'late_exit_start'/);
  assert.match(OT, /_appendOnce\('late_' \+ today/, 'once per day, not per tick');
});
