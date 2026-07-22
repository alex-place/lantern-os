"use strict";

/**
 * test/spiral-fix-rate.test.js
 *
 * The M4 ratchet metric (ADR-0029). Fix Rate = fraction of previously-FAILING tests a
 * candidate now passes, minus a regression penalty for previously-PASSING tests it
 * broke. This is the one number the spiral commits on — "did this step verifiably
 * advance?" — grounded in SWE-Shepherd (2604.10493) / SWE-TRACE (2604.14820). The
 * anti-memorization gate lives here, so it is tested hard.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-fix-rate.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { fixRate, summarize } = require("../lib/spiral-fix-rate");

const R = (spec) => Object.entries(spec).map(([name, passed]) => ({ name, passed }));

// ── turn 0 (before = null → all-fail baseline over the graded tests) ───────────

test("turn 0: a partial pass ADVANCES (some previously-failing test now passes)", () => {
  const v = fixRate(null, R({ t1: true, t2: false, t3: false }));
  assert.equal(v.fixed, 1, "t1 went failing→passing");
  assert.equal(v.failingBefore, 3, "baseline treats all three as failing");
  assert.ok(Math.abs(v.fixRate - 1 / 3) < 1e-9, "1 of 3 fixed");
  assert.equal(v.broke, 0);
  assert.ok(v.advanced, "a strictly-positive penalized fix rate advances");
  assert.equal(v.solved, false, "not all tests pass yet");
});

test("turn 0: all-fail does NOT advance", () => {
  const v = fixRate(null, R({ t1: false, t2: false }));
  assert.equal(v.fixed, 0);
  assert.equal(v.advanced, false, "nothing fixed → no ratchet");
  assert.equal(v.solved, false);
});

test("turn 0: all-pass is SOLVED and advances", () => {
  const v = fixRate(null, R({ t1: true, t2: true }));
  assert.equal(v.solved, true);
  assert.equal(v.advanced, true);
  assert.equal(v.failingAfter, 0);
});

// ── the regression penalty (the load-bearing anti-memorization rule) ───────────

test("the regression penalty strictly reduces the score when tests break", () => {
  // before: t1..t3 passing, t4,t5 failing.  after: t4,t5 fixed but t1,t2,t3 broken.
  const before = R({ t1: true, t2: true, t3: true, t4: false, t5: false });
  const after = R({ t1: false, t2: false, t3: false, t4: true, t5: true });
  const v = fixRate(before, after);
  assert.equal(v.fixed, 2, "t4,t5 fixed");
  assert.equal(v.broke, 3, "t1,t2,t3 regressed");
  // rawFixRate = 2/2 = 1; penalty = 3/5 = 0.6 → penalized 0.4 (still positive here; the
  // DECISIVE net-regressive rejection is the next test). Assert the penalty bites.
  assert.ok(v.penalizedFixRate < v.fixRate, "penalty strictly reduces the score");
  assert.ok(Math.abs(v.penalizedFixRate - 0.4) < 1e-9, "1 - 3/5 = 0.4");
});

test("a net-regressive step is rejected: penalized fix rate ≤ 0 → not advanced", () => {
  // fix 1 of 4 failing (0.25) but break 2 of 6 total (penalty 0.333) → net negative.
  const before = R({ a: true, b: true, c: false, d: false, e: false, f: false });
  const after = R({ a: false, b: false, c: true, d: false, e: false, f: false });
  const v = fixRate(before, after);
  assert.equal(v.fixed, 1, "c fixed");
  assert.equal(v.broke, 2, "a,b broke");
  assert.ok(v.penalizedFixRate <= 0, `penalized ${v.penalizedFixRate} must be ≤ 0`);
  assert.equal(v.advanced, false, "reality refuses to ratchet a net-regressive step");
});

test("solved requires zero failing AND zero regressions", () => {
  const before = R({ a: true, b: false });
  // all pass now, none broke → solved
  assert.equal(fixRate(before, R({ a: true, b: true })).solved, true);
  // all 'pass' but we broke a previously-passing one is impossible to be all-pass;
  // instead confirm a lingering fail blocks solved:
  assert.equal(fixRate(before, R({ a: true, b: false })).solved, false);
});

// ── monotone progress across a sequence (the ratchet) ──────────────────────────

test("progressive fixes advance each step until solved", () => {
  const s0 = R({ a: false, b: false, c: false });
  const s1 = R({ a: true, b: false, c: false });
  const s2 = R({ a: true, b: true, c: false });
  const s3 = R({ a: true, b: true, c: true });
  assert.ok(fixRate(null, s1).advanced, "0→1 fixed a");
  assert.ok(fixRate(s1, s2).advanced, "1→2 fixed b");
  const last = fixRate(s2, s3);
  assert.ok(last.advanced && last.solved, "2→3 fixed c and solves");
});

test("a step that changes nothing does not advance", () => {
  const s = R({ a: true, b: false });
  const v = fixRate(s, R({ a: true, b: false }));
  assert.equal(v.fixed, 0);
  assert.equal(v.broke, 0);
  assert.equal(v.advanced, false, "no movement → no ratchet");
});

// ── counts-only degraded form ──────────────────────────────────────────────────

test("counts-only results still score (identified:false, no regression identity)", () => {
  const v = fixRate({ passed: 0, failed: 3, total: 3 }, { passed: 2, failed: 1, total: 3 });
  assert.equal(v.identified, false, "no per-test names → flagged coarse");
  assert.ok(v.advanced, "2 of 3 now pass vs 0 before → advances");
  assert.equal(v.solved, false);
});

test("summarize: array form is identified; counts form is not", () => {
  assert.equal(summarize(R({ a: true, b: false })).identified, true);
  assert.equal(summarize({ passed: 1, failed: 1 }).identified, false);
  assert.equal(summarize(null).total, 0, "null → empty");
});
