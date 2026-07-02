// #1409 — repo-map wired into the live coding path. Pure logic only (buildRepoMapEvidence
// does real I/O via repo-map.js's buildGraph, exercised indirectly by the integration test
// in keystone-runtime-groundmap.test.js instead).
const assert = require("assert");
const { mergeGroundingResults, computeContextPrecision } = require("../lib/repo-map-grounding");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// ── mergeGroundingResults ────────────────────────────────────────────────────────
check("keeps every existing result unchanged, in order", () => {
  const existing = [{ path: "a.js", score: 10 }, { path: "b.js", score: 5 }];
  const packet = { files: [] };
  const merged = mergeGroundingResults(existing, packet, 10);
  assert.deepStrictEqual(merged, existing);
});

check("appends repo-map files not already present, tagged fromRepoMap", () => {
  const existing = [{ path: "a.js", score: 10 }];
  const packet = { files: [{ path: "b.js", score: 3, reason: "central" }] };
  const merged = mergeGroundingResults(existing, packet, 10);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].path, "b.js");
  assert.strictEqual(merged[1].fromRepoMap, true);
  assert.strictEqual(merged[1].reason, "central");
});

check("does not duplicate a file searchRepoFiles already found", () => {
  const existing = [{ path: "a.js", score: 10 }];
  const packet = { files: [{ path: "a.js", score: 99, reason: "central" }] };
  const merged = mergeGroundingResults(existing, packet, 10);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].score, 10); // existing entry untouched, not overwritten
});

check("respects maxFiles cap even when repo-map has more to offer", () => {
  const existing = [{ path: "a.js", score: 10 }, { path: "b.js", score: 9 }];
  const packet = { files: [{ path: "c.js", score: 5 }, { path: "d.js", score: 4 }] };
  const merged = mergeGroundingResults(existing, packet, 3);
  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(merged.map((m) => m.path), ["a.js", "b.js", "c.js"]);
});

check("empty evidence packet is a no-op", () => {
  const existing = [{ path: "a.js", score: 10 }];
  const merged = mergeGroundingResults(existing, null, 10);
  assert.deepStrictEqual(merged, existing);
});

// ── computeContextPrecision ───────────────────────────────────────────────────────
check("all selected files were used -> precision 1.0", () => {
  const r = computeContextPrecision(["a.js", "b.js"], ["a.js", "b.js"]);
  assert.strictEqual(r.selected, 2);
  assert.strictEqual(r.selectedAndUsed, 2);
  assert.strictEqual(r.selectedAndUnused, 0);
  assert.strictEqual(r.precision, 1.0);
});

check("half the selected files were used -> precision 0.5", () => {
  const r = computeContextPrecision(["a.js", "b.js"], ["a.js"]);
  assert.strictEqual(r.selectedAndUsed, 1);
  assert.strictEqual(r.selectedAndUnused, 1);
  assert.strictEqual(r.precision, 0.5);
});

check("used files outside the selected set don't inflate precision", () => {
  // The model read a.js (selected) but the actual fix landed in z.js (never selected) —
  // that's a real miss, not something that should make selection look better than it was.
  const r = computeContextPrecision(["a.js"], ["z.js"]);
  assert.strictEqual(r.selectedAndUsed, 0);
  assert.strictEqual(r.precision, 0);
});

check("nothing selected -> precision is null, not a fabricated 0 or 1", () => {
  const r = computeContextPrecision([], ["a.js"]);
  assert.strictEqual(r.selected, 0);
  assert.strictEqual(r.precision, null);
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall repo-map-grounding checks passed\n");
