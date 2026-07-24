"use strict";

/**
 * Fix Rate — the M4 verifier metric for the Spiral harness (ADR-0029).
 *
 * The spiral commits a refinement step to verified memory ONLY if it *verifiably
 * advanced* the problem. For code, "advanced" is not a vibe — it is a computable
 * quantity: the fraction of previously-FAILING tests the new candidate now passes,
 * minus a penalty for any previously-PASSING test it broke. This is the step-level
 * signal used by code process-reward models — SWE-Shepherd (arXiv 2604.10493) and
 * SWE-TRACE (arXiv 2604.14820) — reduced to the one number the ratchet needs.
 *
 *     fixRate          = fixed / failingBefore              (∈ [0,1])
 *     penalizedFixRate = fixRate − brokeNow / totalTests    (regression-penalized)
 *     advanced         = solved OR penalizedFixRate > 0
 *
 * This module is PURE: it computes the metric from before/after test results. It
 * never runs code — the caller supplies the two result sets (prod = the real
 * exec-verify sandbox; tests = stubs). That keeps the Verify stage honest and this
 * primitive trivially unit-testable. It is the load-bearing piece of the design:
 * generalization comes from THIS verifier, not from the model's parameters
 * (ARC-Prize showed a learned-confidence halt just memorizes).
 */

/**
 * Normalize a test-result set into pass/fail name sets.
 *
 * Accepts either:
 *   - an array of `{ name, passed }` (preferred — enables regression tracking), or
 *   - a counts object `{ passed, failed, total }` (coarse — no per-test identity).
 *
 * Array form is strongly preferred: without per-test names we cannot tell a fixed
 * test from a newly-broken one, so counts-only degrades regression detection.
 *
 * @param {Array|Object|null} results
 * @returns {{passSet:Set<string>, failSet:Set<string>, names:Set<string>, total:number, passed:number, failed:number, identified:boolean}}
 */
function summarize(results) {
  const passSet = new Set();
  const failSet = new Set();
  if (Array.isArray(results)) {
    results.forEach((r, i) => {
      const name = String(r && r.name != null ? r.name : i);
      if (r && r.passed) passSet.add(name);
      else failSet.add(name);
    });
    const names = new Set([...passSet, ...failSet]);
    return { passSet, failSet, names, total: names.size, passed: passSet.size, failed: failSet.size, identified: true };
  }
  // counts-only: synthesize anonymous names so the maths still run, but flag it.
  const passed = Math.max(0, Number(results && results.passed) || 0);
  const failed = Math.max(0, Number(results && results.failed) || 0);
  const total = Number(results && results.total) || passed + failed;
  for (let i = 0; i < passed; i++) passSet.add(`p${i}`);
  for (let i = 0; i < failed; i++) failSet.add(`f${i}`);
  return { passSet, failSet, names: new Set([...passSet, ...failSet]), total, passed, failed, identified: false };
}

/**
 * Baseline for the comparison. When `before` is null (turn 0 — nothing committed
 * yet) the baseline is "everything the candidate is graded on was failing", so the
 * first candidate advances iff it passes at least one test. Otherwise it is the
 * best-so-far committed result the ratchet is measured against.
 */
function _before(before, after) {
  if (before != null) return summarize(before);
  return { passSet: new Set(), failSet: new Set(after.names), names: new Set(after.names), total: after.total, passed: 0, failed: after.total, identified: after.identified };
}

/**
 * Compute the Fix-Rate ratchet signal for a candidate step.
 *
 * @param {Array|Object|null} before  best-so-far committed test results (null on turn 0)
 * @param {Array|Object}      after   the new candidate's test results
 * @returns {{
 *   fixRate:number, penalizedFixRate:number,
 *   fixed:number, broke:number, failingBefore:number, failingAfter:number,
 *   solved:boolean, advanced:boolean, total:number, identified:boolean,
 *   fixedTests:string[], brokeTests:string[]
 * }}
 */
function fixRate(before, after) {
  const A = summarize(after);
  const B = _before(before, A);
  const identified = A.identified && B.identified;
  const failingBefore = B.failSet.size;
  const total = A.total || A.names.size || 1;

  let fixed, broke, fixedTests, brokeTests, raw, penalized;
  if (identified) {
    // Per-test identity available → exact fixes and regressions.
    // Fixed: failing before, passing now. Broke: passing before, failing now.
    fixedTests = [...B.failSet].filter((n) => A.passSet.has(n));
    brokeTests = [...B.passSet].filter((n) => A.failSet.has(n) || (A.names.has(n) && !A.passSet.has(n)));
    fixed = fixedTests.length;
    broke = brokeTests.length;
    raw = failingBefore > 0 ? fixed / failingBefore : A.failed === 0 ? 1 : 0;
    penalized = raw - broke / Math.max(1, total);
  } else {
    // Counts-only (no per-test names) → we can only see NET movement in the failing
    // count, so fixes and breaks fold into one signed quantity. Coarser, but honest:
    // `identified:false` is surfaced so callers know regressions aren't separable.
    fixedTests = [];
    brokeTests = [];
    const net = failingBefore - A.failed; // >0 net fixed, <0 net broken
    fixed = Math.max(0, net);
    broke = Math.max(0, -net);
    raw = failingBefore > 0 ? Math.max(0, net) / failingBefore : A.failed === 0 ? 1 : 0;
    penalized = failingBefore > 0 ? net / failingBefore : A.failed === 0 ? 1 : Math.min(0, net);
  }

  const solved = A.total > 0 && A.failed === 0 && broke === 0;
  return {
    fixRate: raw,
    penalizedFixRate: penalized,
    fixed,
    broke,
    failingBefore,
    failingAfter: A.failed,
    solved,
    // A step "advances" the ratchet iff it is solved OR it strictly improved the
    // regression-penalized fix rate. A step that fixes 1 test but breaks 2 does NOT
    // advance — reality refuses to ratchet it. This is the anti-memorization gate.
    advanced: solved || penalized > 0,
    total,
    identified,
    fixedTests,
    brokeTests,
  };
}

module.exports = { summarize, fixRate };
