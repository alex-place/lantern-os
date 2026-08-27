'use strict';
/**
 * cadence-reentry.test.js — the entry cadence ended the recycling that was the edge.
 *
 * Live daily history, stable box. Week 1 ran 9.4 entries/day with 3.2 SAME-SESSION
 * re-entries/day and made +$13,764 — its two best days were its two highest-recycle
 * days (08-14 +$6,803 and 08-10 +$3,073, six recycles each). From 08-17 the recycle
 * count is ZERO, every day for ten trading days, and the book is −$1,368. Since 08-24
 * `entry_cadence` is the largest single entry blocker (99, 85, 72 rows/day) and of 26
 * exits across 08-24..08-26 only TWO ever came back.
 *
 * The lockout compounds: exit at 10:20 → the 45-minute cooldown holds until 11:05 →
 * but the cadence only decides at 11:00 → the bar is missed → wait for 12:00.
 *
 * The exemption is narrow by design, and these tests pin the narrowness: it bypasses
 * the CADENCE only, for a symbol exited THIS session, and it never spends the bar.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

const M = (h, m) => h * 60 + m;
// FIXED ET INSTANTS, NOT THE WALL CLOCK (2026-08-27). These tests originally anchored to
// `Date.now() - 40 minutes`, which straddles the ET date boundary when the suite runs
// after midnight: the exit lands on 08-26 at 23:51 and "now" on 08-27 at 00:31, the
// same-session check correctly returns false, and the assertion fails. It passed when
// written at 02:35 and went red at 00:31 — the same class of defect as the LNG fixtures
// (a test whose verdict depends on WHEN it runs). Sessions are the subject here, so the
// clock has to be an input.
const ET_AT = (isoDay, h, m) => new Date(`${isoDay}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).getTime();
const WED_1100 = ET_AT('2026-08-19', 11, 0);      // mid-session
const WED_1020 = ET_AT('2026-08-19', 10, 20);     // 40 minutes earlier, same session
const TUE_1500 = ET_AT('2026-08-18', 15, 0);      // the session before
const withEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
};

// ---------------------------------------------------------------------------
// The cadence gate itself is unchanged — pin that first, so a regression in the
// exemption cannot be mistaken for a change in the rule it exempts from.
// ---------------------------------------------------------------------------
test('the cadence still blocks a FRESH symbol between bar closes', () => {
  const blocked = at._entryCadenceBlocked(M(10, 20), 60, 0, 3, M(10, 0));
  assert.ok(blocked, '10:20 with the 10:00 bar spent must block');
  assert.strictEqual(blocked.why, 'decided');
  assert.strictEqual(blocked.label, '11:00', 'and it names the next decision');
});

test('the cadence still admits the first scan of an unspent bar', () => {
  assert.strictEqual(at._entryCadenceBlocked(M(11, 0), 60, 0, 3, null), null);
  assert.strictEqual(at._entryCadenceBlocked(M(11, 2), 60, 0, 3, null), null, 'inside the window');
});

// ---------------------------------------------------------------------------
// The exemption.
// ---------------------------------------------------------------------------
test('DEFAULT OFF — an exit this session does not exempt anything unless armed', () => {
  withEnv({ TRADER_CADENCE_REENTRY: undefined }, () => {
    assert.strictEqual(at._cadenceReentryExempt('SOXL', WED_1100), false);
  });
  withEnv({ TRADER_CADENCE_REENTRY: '0' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('SOXL', WED_1100), false);
  });
});

test('armed: a symbol exited THIS session is exempt', () => {
  at._exitAtSet('SOXL', WED_1020);                  // exited 40 minutes earlier, same session
  withEnv({ TRADER_CADENCE_REENTRY: '1' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('SOXL', WED_1100), true);
  });
});

test('an exit MINUTES earlier but on the previous ET date is not the same session', () => {
  // the boundary the wall-clock version tripped over: 23:51 and 00:31 are 40 minutes
  // apart and belong to different sessions.
  at._exitAtSet('SPY', ET_AT('2026-08-18', 23, 51));
  withEnv({ TRADER_CADENCE_REENTRY: '1' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('SPY', ET_AT('2026-08-19', 0, 31)), false);
  });
});

test('a symbol never exited is NOT exempt — this is not a general cadence bypass', () => {
  withEnv({ TRADER_CADENCE_REENTRY: '1' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('NEVERHELD', WED_1100), false);
  });
});

test("YESTERDAY's exit does not exempt today — the recycle is a same-session act", () => {
  at._exitAtSet('XLK', TUE_1500);
  withEnv({ TRADER_CADENCE_REENTRY: '1' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('XLK', WED_1100), false);
  });
});

test('the exemption is per SYMBOL, not global', () => {
  at._exitAtSet('SMH', ET_AT('2026-08-19', 10, 50));
  withEnv({ TRADER_CADENCE_REENTRY: '1' }, () => {
    assert.strictEqual(at._cadenceReentryExempt('SMH', WED_1100), true);
    assert.strictEqual(at._cadenceReentryExempt('QQQ', WED_1100), false, 'a different symbol is untouched');
  });
});

test('a re-entry must not spend the bar — the recycle cannot cost a fresh symbol its decision', () => {
  // _markCadenceDecided is what spends a bar. The placement site calls it only when the
  // entry was NOT a cadence-exempt re-entry; if that guard were dropped, the first
  // recycle of the hour would lock out every fresh candidate — the exact failure the
  // exemption removes. Pin the mechanism it depends on.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  assert.match(src, /if \(!_cadenceExemptReentry\) _markCadenceDecided\(\);/,
    'the placement site must guard _markCadenceDecided on the re-entry flag');
  assert.match(src, /let _cadenceExemptReentry = false;/,
    'and the flag must be per-iteration, not shared across candidates');
});

test('the exemption touches the CADENCE only — every other gate is still in the path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
  // the guards that must still run after the cadence block
  for (const guard of [
    'post-stop cooldown',            // stopped out -> no same-day re-buy
    'concurrent cap',                // slot ceiling
    "why: 'cooldown'",               // the 45-minute per-symbol cooldown
    'falling_knife',                 // momentum still cratering
  ]) {
    assert.ok(src.includes(guard), `${guard} must still be present in the entry path`);
  }
  // and the exemption is only consulted at the cadence site
  // count CALL sites, not the definition
  const hits = (src.match(/(?<!function )_cadenceReentryExempt\(/g) || []).length;
  assert.strictEqual(hits, 1, 'the exemption is consulted exactly once — at the cadence gate');
});
