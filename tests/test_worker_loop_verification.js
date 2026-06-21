/**
 * Regression for #896: autowork must gate on REAL verification.
 * Run: node tests/test_worker_loop_verification.js
 *
 * The core fix is classifyTestOutput(): a pytest run with no tests collected is
 * INCONCLUSIVE (not a pass), a run with failures is a failure, and only a run
 * with a positive "<N> passed" signal and no failure marker counts as passed.
 * processOne() then treats inconclusive like a failure (rollback + markFailed),
 * so unverified work is never marked complete.
 *
 * agent-worker-loop pulls in work-dispatcher → AgentSlotManager (which reads
 * ~/.claude/agent-slots.json), so we stub that chain to load the module in isolation.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const SRC = path.resolve(__dirname, "../src");

function stub(mod, exports) {
  const id = require.resolve(mod);
  require.cache[id] = { id, loaded: true, exports };
}
stub(`${SRC}/agent-slot-manager`, class { constructor() {} getEnabledSlots() { return []; } });
stub(`${SRC}/work-dispatcher`, { dispatchOne: async () => null });
stub(`${SRC}/worktree-manager`, { createWorktree() {}, removeWorktree() {}, listWorktrees() { return []; }, WORKTREE_BASE: "" });
stub(`${SRC}/queue-manager`, class { constructor() {} });

delete require.cache[require.resolve(`${SRC}/agent-worker-loop`)];
const wl = require(`${SRC}/agent-worker-loop`);

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

assert.strictEqual(typeof wl.classifyTestOutput, "function", "classifyTestOutput must be exported");
ok("classifyTestOutput is exported");

// (a) A clean pass → passed:true
let r = wl.classifyTestOutput("===== 42 passed in 3.21s =====");
assert.deepStrictEqual(r, { passed: true, inconclusive: false });
ok("'42 passed' → passed, not inconclusive");

// (b) Failures → passed:false, not inconclusive
r = wl.classifyTestOutput("===== 3 failed, 10 passed in 5.0s =====\nFAILED tests/test_x.py::test_y");
assert.strictEqual(r.passed, false);
assert.strictEqual(r.inconclusive, false);
ok("'3 failed' → failed (not a pass, not inconclusive)");

// (c) pytest collected nothing → INCONCLUSIVE, never a pass (the #896 bug)
for (const out of ["no tests ran in 0.01s", "collected 0 items\n\nno tests ran in 0.02s"]) {
  r = wl.classifyTestOutput(out);
  assert.strictEqual(r.passed, false, `'${out}' must not be a pass`);
  assert.strictEqual(r.inconclusive, true, `'${out}' must be inconclusive`);
}
ok("'no tests ran' / 'collected 0 items' → inconclusive (NOT pass)");

// (d) Empty / silent output → inconclusive, never success-by-default
r = wl.classifyTestOutput("");
assert.deepStrictEqual(r, { passed: false, inconclusive: true });
ok("empty output → inconclusive, not pass-by-default");

// (e) ERROR (collection/import error) → failed, not a silent pass
r = wl.classifyTestOutput("ERRORS\nERROR tests/test_z.py - ImportError");
assert.strictEqual(r.passed, false);
assert.strictEqual(r.inconclusive, false);
ok("'ERROR' → failed (not pass, not inconclusive)");

console.log(`\n#896 verification gate: ${passed} checks passed.`);
