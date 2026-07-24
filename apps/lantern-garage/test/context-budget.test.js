"use strict";
// #2852 — the context-budget folding policy: keep recent + pinned, evict the rest to stay under
// a token budget, so the loop stays bounded regardless of run duration.
//
// Run: node apps/lantern-garage/test/context-budget.test.js
const assert = require("assert");
const { foldContext, estimateTokens } = require("../lib/context-budget");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// each item's text is 40 chars → 10 tokens, so budgets are easy to reason about
const T40 = "x".repeat(40);
function items(n, mut = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ id: i, text: T40, ...mut(i) }));
}

check("estimateTokens ≈ chars/4", () => {
  assert.strictEqual(estimateTokens(T40), 10);
  assert.strictEqual(estimateTokens(""), 0);
});

check("under budget → everything kept, nothing folded", () => {
  const r = foldContext(items(3), { budgetTokens: 100 });
  assert.strictEqual(r.folded, false);
  assert.strictEqual(r.kept.length, 3);
  assert.deepStrictEqual(r.externalized, []);
});

check("over budget → newest kept under budget, oldest externalized", () => {
  const r = foldContext(items(5), { budgetTokens: 25 }); // 5×10=50 > 25 → keep 2 newest (20)
  assert.strictEqual(r.folded, true);
  assert.ok(r.keptTokens <= 25, `keptTokens ${r.keptTokens} ≤ 25`);
  assert.deepStrictEqual(r.kept.map((x) => x.id), [3, 4], "the two newest survive");
  assert.deepStrictEqual(r.externalized.map((x) => x.id), [0, 1, 2], "the oldest are evicted");
});

check("kept ∪ externalized partitions the input, order preserved", () => {
  const r = foldContext(items(5), { budgetTokens: 25 });
  assert.strictEqual(r.kept.length + r.externalized.length, 5);
  assert.deepStrictEqual(r.kept.map((x) => x.id), [...r.kept.map((x) => x.id)].sort((a, b) => a - b));
});

check("recency floor keeps the last N even when it exceeds budget", () => {
  const r = foldContext(items(5), { budgetTokens: 15, keepRecent: 3 }); // floor 3×10=30 > 15
  assert.deepStrictEqual(r.kept.map((x) => x.id), [2, 3, 4]);
  assert.strictEqual(r.keptTokens, 30, "hard-kept floor can exceed budget");
});

check("pinned items are always kept, even when old", () => {
  const r = foldContext(items(5, (i) => (i === 0 ? { pinned: true } : {})), { budgetTokens: 25 });
  assert.ok(r.kept.some((x) => x.id === 0), "the pinned oldest item survives");
});

check("budget 0 with no pinned/recent → everything externalized", () => {
  const r = foldContext(items(3), { budgetTokens: 0 });
  assert.strictEqual(r.kept.length, 0);
  assert.strictEqual(r.externalized.length, 3);
});

check("empty input → empty result, not folded", () => {
  const r = foldContext([], { budgetTokens: 10 });
  assert.deepStrictEqual(r.kept, []);
  assert.strictEqual(r.folded, false);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
