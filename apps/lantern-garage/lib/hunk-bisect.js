"use strict";

/**
 * PASS_TO_PASS prefix bisection (#2976) — localize the breaking hunk by test runs.
 *
 * Every SWE-bench Verified instance ships ~42 PASS_TO_PASS regression tests. Used
 * only as a final gate they say "something broke"; used as a PREFIX ORACLE they say
 * WHERE: apply hunks in order, the first prefix that breaks a previously-passing
 * subset contains the culprit at its last hunk. Binary search finds it in
 * ceil(log2 H) test runs — localization moves from model capability (expensive,
 * unreliable at small scale) to test execution (cheap, exact). The verified prefix
 * is kept; regeneration restarts from the culprit with the prefix ratcheted.
 *
 * Pure algorithm: the test runner is injected (`testPrefix(k)` → does the
 * regression subset pass with hunks[0..k) applied?). Memoized, receipted. The
 * #2973 environment tier owns applying hunks and invoking real pytest subsets;
 * experiments/swebench_test_bisection_repair.py is the simulation this mirrors.
 */

/**
 * @param {object} args
 *   count       {number}   total hunks, in application order
 *   testPrefix  {function} async (k) => boolean — regression subset passes with
 *                          the first k hunks applied. k=0 is the untouched repo.
 * @returns {Promise<{
 *   status: "culprit"|"all-pass"|"baseline-broken",
 *   culpritIndex: number|null,   // hunk index that first breaks the subset
 *   verifiedPrefixLen: number,   // hunks proven safe (keep them — the ratchet)
 *   runs: number                 // test executions spent (<= ceil(log2 count)+2)
 * }>}
 */
async function bisect({ count, testPrefix }) {
  if (!Number.isInteger(count) || count < 0) throw new Error("bisect: count must be a non-negative integer");
  if (typeof testPrefix !== "function") throw new Error("bisect: testPrefix is required");

  const memo = new Map();
  let runs = 0;
  const probe = async (k) => {
    if (memo.has(k)) return memo.get(k);
    runs += 1;
    const ok = Boolean(await testPrefix(k));
    memo.set(k, ok);
    return ok;
  };

  if (!(await probe(0))) {
    // The untouched repo already fails the chosen subset — the subset is wrong or
    // the environment is broken. Localizing on top of that would be fiction.
    return { status: "baseline-broken", culpritIndex: null, verifiedPrefixLen: 0, runs };
  }
  if (count === 0 || (await probe(count))) {
    return { status: "all-pass", culpritIndex: null, verifiedPrefixLen: count, runs };
  }

  // Invariant: probe(lo) === true, probe(hi) === false. Shrink to adjacent.
  let lo = 0;
  let hi = count;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await probe(mid)) lo = mid;
    else hi = mid;
  }
  return { status: "culprit", culpritIndex: lo, verifiedPrefixLen: lo, runs };
}

module.exports = { bisect };
