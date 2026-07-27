"use strict";

/**
 * test/spiral-edit-format.test.js — #2975 (S/R exact-match) + #2976 (bisection).
 *
 * The apply-failure class dies here: a search string that doesn't match EXACTLY
 * (or matches twice) never touches the file — it comes back as an observation the
 * loop can retry on. The unified diff is computed from real before/after, never
 * trusted from the model. Bisection localizes a breaking hunk in log2 runs.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-edit-format.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseEdits, applyEdits, unifiedDiff } = require("../lib/spiral-edit-format");
const { bisect } = require("../lib/hunk-bisect");

const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

test("parseEdits: single + multiple blocks, tolerant fence widths", () => {
  const one = parseEdits(block("old line", "new line"));
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { search: "old line", replace: "new line" });
  const two = parseEdits(`prose\n${block("a", "b")}\nmore prose\n${block("c\nd", "e")}`);
  assert.equal(two.length, 2);
  assert.equal(two[1].search, "c\nd");
  const wide = parseEdits(`<<<<<<<<< SEARCH\nx\n=========\ny\n>>>>>>>>> REPLACE`);
  assert.equal(wide.length, 1, "7-9 char fences tolerated");
});

test("applyEdits: clean exact-match apply, sequential edits see prior results", () => {
  const src = "function f() {\n  return 1;\n}\n";
  const r = applyEdits(src, [
    { search: "return 1;", replace: "return 2;" },
    { search: "return 2;", replace: "return 3;" }, // matches text edit 1 created
  ]);
  assert.equal(r.ok, true);
  assert.match(r.content, /return 3;/);
  assert.deepEqual(r.applied, [0, 1]);
});

test("applyEdits: hallucinated context = no-match → NOTHING applies, observation names the first line", () => {
  const src = "real line A\nreal line B\n";
  const r = applyEdits(src, [
    { search: "real line A", replace: "changed A" },
    { search: "imagined context line", replace: "whatever" },
  ]);
  assert.equal(r.ok, false, "any failure aborts the whole application");
  assert.equal(r.content, src, "file content untouched on failure");
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].reason, "no-match");
  assert.match(r.failed[0].observation, /imagined context line/);
});

test("applyEdits: ambiguous (2+ matches) refuses to guess; empty search refused", () => {
  const src = "x = 1\nx = 1\n";
  const amb = applyEdits(src, [{ search: "x = 1", replace: "x = 2" }]);
  assert.equal(amb.ok, false);
  assert.equal(amb.failed[0].reason, "ambiguous");
  const empty = applyEdits(src, [{ search: "", replace: "y" }]);
  assert.equal(empty.ok, false);
  assert.equal(empty.failed[0].reason, "empty-search");
});

test("unifiedDiff: computed from real before/after with standard headers; empty on no change", () => {
  const before = "a\nb\nc\nd\ne";
  const after = "a\nb\nX\nd\ne";
  const d = unifiedDiff(before, after, { fromFile: "a/m.py", toFile: "b/m.py" });
  assert.match(d, /^--- a\/m\.py\n\+\+\+ b\/m\.py\n@@ -3,3 \+3,3 @@\n/);
  assert.match(d, /\n-c\n\+X\n/);
  assert.equal(unifiedDiff("same", "same"), "");
});

test("unifiedDiff: distant changes produce separate hunks", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const after = before.replace("line2", "LINE2").replace("line27", "LINE27");
  const d = unifiedDiff(before, after);
  const hunks = d.split("\n").filter((l) => l.startsWith("@@"));
  assert.equal(hunks.length, 2, "changes 25 lines apart must not merge into one hunk");
});

// ── #2976 bisection ─────────────────────────────────────────────────────────

const oracle = (culprit) => {
  let calls = 0;
  return {
    calls: () => calls,
    testPrefix: async (k) => {
      calls += 1;
      return k <= culprit; // prefix passes until it includes hunks[culprit]
    },
  };
};

test("bisect finds the culprit at every position within the log2 run budget", async () => {
  const H = 16;
  for (const culprit of [0, 1, 7, 14, 15]) {
    const o = oracle(culprit);
    const r = await bisect({ count: H, testPrefix: o.testPrefix });
    assert.equal(r.status, "culprit");
    assert.equal(r.culpritIndex, culprit, `culprit ${culprit} localized`);
    assert.equal(r.verifiedPrefixLen, culprit, "everything before the culprit is ratcheted");
    assert.ok(r.runs <= Math.ceil(Math.log2(H)) + 2, `${r.runs} runs within budget`);
  }
});

test("bisect: all-pass keeps the whole patch; baseline-broken refuses to localize", async () => {
  const all = await bisect({ count: 8, testPrefix: async () => true });
  assert.equal(all.status, "all-pass");
  assert.equal(all.verifiedPrefixLen, 8);
  const broken = await bisect({ count: 8, testPrefix: async () => false });
  assert.equal(broken.status, "baseline-broken");
  assert.equal(broken.culpritIndex, null, "no fiction on a broken environment");
});

test("bisect memoizes probes and handles count=0", async () => {
  const o = oracle(3);
  await bisect({ count: 8, testPrefix: o.testPrefix });
  const firstCalls = o.calls();
  assert.ok(firstCalls <= 5);
  const empty = await bisect({ count: 0, testPrefix: async () => true });
  assert.equal(empty.status, "all-pass");
});
