'use strict';
/**
 * session-ibs-rth.test.js — sessionIbs measures against the REGULAR session.
 * market-data-yahoo fetches intraday bars with includePrePost=true, so the
 * bars carry 04:00-09:30 and 16:00-20:00 prints; the old reading took every
 * bar of the date (experiments/session_range_lab.js: halves the 2y analog).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { sessionIbs } = require('../lib/signal-engine/scan');

// 2026-08-21 (EDT, UTC-4): 08:00 ET = 12:00Z, 09:30 ET = 13:30Z, 16:00 ET = 20:00Z, 17:00 ET = 21:00Z
const bar = (hhmmZ, high, low, close) => ({ timestamp: `2026-08-21T${hhmmZ}:00.000Z`, open: close, high, low, close, volume: 1 });
const PRE = bar('12:00', 110, 109, 109.5);          // pre-market phantom high at 110
const RTH = [bar('13:30', 104, 100, 102), bar('14:30', 103, 100.5, 101)];
const POST = bar('21:00', 107, 101, 106.5);         // after-hours print above the day's high

test('pre-market prints no longer stretch the range: IBS is measured 09:30-now', () => {
  delete process.env.TRADER_IBS_RTH_ONLY;
  const clean = sessionIbs([...RTH]);
  const withPre = sessionIbs([PRE, ...RTH]);
  assert.strictEqual(+clean.toFixed(4), 0.25, 'last 101 inside 100-104 = 0.25');
  assert.strictEqual(withPre, clean, 'the 110 pre-market high is ignored');
});

test('the kill switch restores the old contaminated reading', () => {
  process.env.TRADER_IBS_RTH_ONLY = '0';
  try {
    const withPre = sessionIbs([PRE, ...RTH]);
    assert.strictEqual(+withPre.toFixed(4), 0.1, '(101-100)/(110-100) — the phantom high inside the range');
  } finally { delete process.env.TRADER_IBS_RTH_ONLY; }
});

test('after-hours prints do not extend the range; the latest price is still read against the regular range', () => {
  const v = sessionIbs([...RTH, POST]);
  assert.strictEqual(+v.toFixed(4), +((106.5 - 100) / (104 - 100)).toFixed(4), 'above the regular range reads > 1, not "inside" a stretched one');
});

test('pre-market only (no regular-hours bar yet) -> no signal', () => {
  assert.strictEqual(sessionIbs([PRE]), null);
});

test('a prior date is excluded from today\'s session', () => {
  const yesterday = { timestamp: '2026-08-20T14:30:00.000Z', open: 90, high: 120, low: 80, close: 90, volume: 1 };
  assert.strictEqual(+sessionIbs([yesterday, ...RTH]).toFixed(4), 0.25);
});
