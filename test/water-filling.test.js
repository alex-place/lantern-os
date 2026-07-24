"use strict";
// #2790 / #2855 — KKT log water-filling: bᵢ* = max(0, (1/γᵢ)·ln(γᵢuᵢ/ν)), ν set so Σbᵢ = B.
// Pins the analytic properties: budget binds, hard threshold below the water level, monotone in
// utility, frozen node (γ→0) gets nothing, equal nodes split equally.
//
// Run: node test/water-filling.test.js
const assert = require("assert");
const { waterFill } = require("../lib/water-filling");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

check("the budget binds: Σ allocations = B", () => {
  const r = waterFill([1, 1, 1], [1, 1, 1], 3);
  assert.ok(near(r.total, 3), `total ${r.total} ≈ 3`);
});

check("equal nodes split the budget equally", () => {
  const r = waterFill([1, 1], [1, 1], 2);
  assert.ok(near(r.allocations[0], 1) && near(r.allocations[1], 1), JSON.stringify(r.allocations));
});

check("a single node receives the whole budget", () => {
  const r = waterFill([1], [1], 5);
  assert.ok(near(r.allocations[0], 5), JSON.stringify(r.allocations));
});

check("monotone in utility: the higher-utility node gets more", () => {
  const r = waterFill([3, 1], [1, 1], 2);
  assert.ok(r.allocations[0] > r.allocations[1], JSON.stringify(r.allocations));
  assert.ok(near(r.total, 2));
});

check("HARD THRESHOLD: a node below the water level gets nothing", () => {
  const r = waterFill([10, 0.001], [1, 1], 1);
  assert.ok(r.allocations[0] > 0, "the high-value node is funded");
  assert.strictEqual(r.allocations[1], 0, "the far-below-water node gets zero");
  assert.deepStrictEqual(r.active, [0]);
});

check("a FROZEN node (γ→0: no marginal value) drops to zero allocation", () => {
  const r = waterFill([1, 1], [1, 1e-9], 1);
  assert.ok(r.allocations[0] > 0);
  assert.strictEqual(r.allocations[1], 0, "γ→0 ⇒ no allocation (matches the G12 collapse deflation)");
});

check("zero budget / empty input → all zero", () => {
  assert.deepStrictEqual(waterFill([1, 1], [1, 1], 0).allocations, [0, 0]);
  assert.deepStrictEqual(waterFill([], [], 5).allocations, []);
});

check("more budget → every funded node's allocation is non-decreasing", () => {
  const a = waterFill([2, 1], [1, 1], 2);
  const b = waterFill([2, 1], [1, 1], 6);
  assert.ok(b.allocations[0] >= a.allocations[0] && b.allocations[1] >= a.allocations[1]);
  assert.ok(near(b.total, 6));
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
