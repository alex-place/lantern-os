"use strict";

/**
 * test/hunk-bisect.test.js — PASS_TO_PASS prefix bisection (#2976).
 *
 * The live primitive is lib/hunk-bisect.js. Its `bisect` was previously exercised ONLY
 * from test/spiral-edit-format.test.js, which belongs to the ORPHAN duplicate module
 * lib/spiral-edit-format.js (a dead copy of the live lib/spiral-edit.js, kept alive only
 * by its own test — flagged for removal in #3025/#2975). Co-locating the live primitive's
 * only coverage with dead code means a cleanup of that duplicate would silently delete
 * this primitive's tests too. This file is that coverage, decoupled — it depends on
 * nothing but lib/hunk-bisect.js.
 *
 * The claim under test is exactness: given a prefix oracle that flips from pass→fail when
 * hunk[culprit] lands, `bisect` must name that exact culprit, ratchet the safe prefix, and
 * do it in ≤ ceil(log2 H)+2 test runs — because the whole point (#2976) is to move
 * localization off model capability and onto cheap, exact test execution.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/hunk-bisect.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { bisect } = require("../lib/hunk-bisect");

// A prefix oracle: the regression subset passes with the first k hunks applied iff the
// breaking hunk (index `culprit`) is not yet in the prefix, i.e. k <= culprit. Counts its
// own invocations so we can assert the run budget from the caller's side too.
const oracle = (culprit) => {
  let calls = 0;
  return {
    calls: () => calls,
    testPrefix: async (k) => {
      calls += 1;
      return k <= culprit; // prefix stays green until it includes hunks[culprit]
    },
  };
};

// ── the exactness claim ───────────────────────────────────────────────────────

test("bisect names the exact culprit at every position, within the log2 run budget", async () => {
  const H = 16;
  const budget = Math.ceil(Math.log2(H)) + 2;
  // every position, not just a sample: an off-by-one in the invariant only shows at an edge
  for (let culprit = 0; culprit < H; culprit++) {
    const o = oracle(culprit);
    const r = await bisect({ count: H, testPrefix: o.testPrefix });
    assert.equal(r.status, "culprit", `culprit ${culprit}: status`);
    assert.equal(r.culpritIndex, culprit, `culprit ${culprit}: localized`);
    assert.equal(r.verifiedPrefixLen, culprit, `culprit ${culprit}: safe prefix ratcheted`);
    assert.ok(r.runs <= budget, `culprit ${culprit}: ${r.runs} runs <= budget ${budget}`);
    assert.equal(o.calls(), r.runs, "reported runs must equal actual oracle invocations");
  }
});

test("bisect localizes across a wide range of patch sizes", async () => {
  for (const H of [2, 3, 5, 7, 31, 64]) {
    const culprit = Math.floor(H / 2);
    const r = await bisect({ count: H, testPrefix: oracle(culprit).testPrefix });
    assert.equal(r.culpritIndex, culprit, `H=${H}: culprit`);
    assert.ok(r.runs <= Math.ceil(Math.log2(H)) + 2, `H=${H}: within budget`);
  }
});

// ── the two honest non-localizing outcomes ────────────────────────────────────

test("all-pass keeps the whole patch — nothing broke, nothing to localize", async () => {
  const r = await bisect({ count: 8, testPrefix: async () => true });
  assert.equal(r.status, "all-pass");
  assert.equal(r.culpritIndex, null);
  assert.equal(r.verifiedPrefixLen, 8, "the entire patch is the verified prefix");
});

test("baseline-broken refuses to localize — no fiction on a broken subset/env", async () => {
  // probe(0) already fails: the chosen regression subset is wrong or the environment is
  // broken. Reporting a culprit on top of that would be invented, not measured.
  const r = await bisect({ count: 8, testPrefix: async () => false });
  assert.equal(r.status, "baseline-broken");
  assert.equal(r.culpritIndex, null);
  assert.equal(r.verifiedPrefixLen, 0);
});

test("the H=1 single-hunk case: culprit is index 0, not spurious localization", async () => {
  // Nothing to bisect — if the one hunk breaks it, the culprit is trivially hunk 0.
  const r = await bisect({ count: 1, testPrefix: oracle(0).testPrefix });
  assert.equal(r.status, "culprit");
  assert.equal(r.culpritIndex, 0);
  assert.equal(r.verifiedPrefixLen, 0);
});

test("count=0 is all-pass, not a crash", async () => {
  const r = await bisect({ count: 0, testPrefix: async () => true });
  assert.equal(r.status, "all-pass");
  assert.equal(r.verifiedPrefixLen, 0);
});

// ── receipts: memoization + truthiness coercion ───────────────────────────────

test("bisect memoizes: each prefix k is probed at most once", async () => {
  const o = oracle(3);
  const r = await bisect({ count: 8, testPrefix: o.testPrefix });
  // ceil(log2 8)=3 midpoint probes + probe(0) + probe(count) endpoints = at most 5 distinct
  assert.ok(o.calls() <= 5, `${o.calls()} distinct probes for H=8`);
  assert.equal(o.calls(), r.runs);
});

test("bisect coerces a truthy/falsy testPrefix result to a boolean verdict", async () => {
  // A real testPrefix returns "does pytest pass" — a caller might hand back 1/0 or a
  // non-empty string rather than a strict boolean. The verdict must not depend on the type.
  let flipped = false;
  const r = await bisect({
    count: 4,
    // returns 1 (truthy) while safe, then "" (falsy) once the culprit at index 2 lands
    testPrefix: async (k) => (k <= 2 ? 1 : ""),
  });
  void flipped;
  assert.equal(r.status, "culprit");
  assert.equal(r.culpritIndex, 2);
});

// ── input guards ──────────────────────────────────────────────────────────────

test("bisect rejects a malformed count or missing testPrefix rather than guessing", async () => {
  await assert.rejects(() => bisect({ count: -1, testPrefix: async () => true }), /non-negative integer/);
  await assert.rejects(() => bisect({ count: 2.5, testPrefix: async () => true }), /non-negative integer/);
  await assert.rejects(() => bisect({ count: 4 }), /testPrefix is required/);
});
