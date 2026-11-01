'use strict';
/**
 * two-sleeve-tick-schedule.test.js — bar-aligned ticks for the two-sleeve runner (2026-10-25).
 *
 * The runner waited a flat 60 s after each tick finished, so ticks drifted through the minute and a decision bar was
 * acted on 20-85 s after its close (the live latency audit: orders 55-80 s after the replay's price). nextTickDelay():
 *   - keeps the flat cadence when no bar close + 22 s comes before it;
 *   - otherwise waits for that instant (so every 5-minute bar is scanned 22 s after its close);
 *   - ticks again at once when a tick ran across such an instant;
 * and the runner wires it in session only, with TWO_SLEEVE_BAR_ALIGN=0 as the way back.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { nextTickDelay, nextAligned, BAR_MS, ALIGN_OFFSET_MS } = require('../lib/two-sleeve/tick-schedule');

// 2026-10-26 is a Monday; EDT (ET = UTC-4). at(h, m, s) = that ET wall time in ms.
const at = (h, m, s = 0, ms = 0) => Date.parse(`2026-10-26T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);

test('the aligned instants are every 5-minute bar close + 22 s', () => {
  assert.equal(ALIGN_OFFSET_MS, 22000); assert.equal(BAR_MS, 300000);
  assert.equal(nextAligned(at(9, 40, 0)), at(9, 40, 22), 'just after the 09:40 close');
  assert.equal(nextAligned(at(9, 40, 21)), at(9, 40, 22));
  assert.equal(nextAligned(at(9, 40, 22)), at(9, 45, 22), 'strictly after');
  assert.equal(nextAligned(at(15, 52, 10)), at(15, 55, 22), 'the 15:55 decision bar');
});

test('a tick that ends well before the next bar close keeps the flat 60 s cadence', () => {
  const r = nextTickDelay(at(9, 41, 30), at(9, 41, 25), 60000);
  assert.deepEqual(r, { delayMs: 60000, aligned: false, missed: false });
});

test('the next tick moves onto the bar close + 22 s when that comes first', () => {
  // the drifting schedule of 10-23 (09:40:00, 09:41:08 ...): a tick ending 09:39:58 used to wait to 09:40:58
  const r = nextTickDelay(at(9, 39, 58), at(9, 39, 52), 60000);
  assert.equal(r.aligned, true); assert.equal(r.missed, false);
  assert.equal(at(9, 39, 58) + r.delayMs, at(9, 40, 22), 'the 09:40 bar is read at 09:40:22, not 09:40:58');
  // the C / O decisions at 15:55: a tick ending 15:55:05 waits for 15:55:22, not 15:56:05
  const c = nextTickDelay(at(15, 55, 5), at(15, 54, 59), 60000);
  assert.equal(at(15, 55, 5) + c.delayMs, at(15, 55, 22));
});

test('a tick that ran across a bar close + 22 s ticks again at once', () => {
  // started 09:40:15 (the 09:40 bar not yet readable), finished 09:40:30
  const r = nextTickDelay(at(9, 40, 30), at(9, 40, 15), 60000);
  assert.deepEqual(r, { delayMs: 250, aligned: true, missed: true });
  // a tick that STARTED after the instant already read the bar: no extra tick
  const s = nextTickDelay(at(9, 40, 40), at(9, 40, 23), 60000);
  assert.equal(s.missed, false); assert.equal(at(9, 40, 40) + s.delayMs, at(9, 41, 40), 'the regular cadence');
});

test('never a tick sooner than 250 ms; a long regular cadence still catches every bar', () => {
  const r = nextTickDelay(at(9, 40, 21, 900), at(9, 40, 10), 60000);
  assert.ok(r.delayMs >= 250);
  const l = nextTickDelay(at(10, 1, 0), at(10, 0, 50), 300000);   // a 5-minute cadence
  assert.equal(at(10, 1, 0) + l.delayMs, at(10, 5, 22));
});

test('the runner uses it in session only, with TWO_SLEEVE_BAR_ALIGN=0 as the way back', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'two-sleeve-runner.js'), 'utf8');
  assert.match(src, /require\(path\.join\(APP, 'lib', 'two-sleeve', 'tick-schedule'\)\)/);
  assert.match(src, /const BAR_ALIGN = process\.env\.TWO_SLEEVE_BAR_ALIGN !== '0';/);
  assert.match(src, /if \(\(mh \|\| protectiveOnly\) && BAR_ALIGN\) \{ const n = nextTickDelay\(nowMs\(\), now, delay\);/);
  assert.match(src, /heartbeat\(\{ marketHours: mh, protectiveOnly, nextInMs: delay, aligned \}\);/);
});
