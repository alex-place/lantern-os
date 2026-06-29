// Σ₀ execution verifier (lib/exec-verify.js): runs code+test in a bounded subprocess and
// returns the execVerdict councilReview folds as ground truth. This test ACTUALLY executes
// (node subprocess) — it's the run-and-test milestone of the execution-grounded loop.
//
// Run: node apps/lantern-garage/test/exec-verify.test.js
const assert = require("assert");
const { verifyExec } = require("../lib/exec-verify");
const { councilReview } = require("../lib/council-review");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const TEST = "if (add(2,3) !== 5) throw new Error('add is wrong');";

// Correct implementation → ran + passed.
check("correct js → ran, passed", () => {
  const r = verifyExec({ language: "js", code: "function add(a,b){return a+b;}", test: TEST });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.passed, true);
});

// Wrong implementation → ran, NOT passed, failure text carried back for self-correction.
check("wrong js → ran, failed, output carries the error", () => {
  const r = verifyExec({ language: "js", code: "function add(a,b){return a-b;}", test: TEST });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.passed, false);
  assert.ok(/add is wrong/.test(r.output), `output=${r.output}`);
});

// Infinite loop → bounded by the timeout, treated as failed (not a stall).
check("timeout → ran, failed (not a stall)", () => {
  const r = verifyExec({ language: "js", code: "while(true){}", test: "", timeoutMs: 1500 });
  assert.strictEqual(r.passed, false);
});

// Unsupported language → ran:false (could not execute — NOT a refutation).
check("unsupported language → ran:false", () => {
  const r = verifyExec({ language: "cobol", code: "", test: "" });
  assert.strictEqual(r.ran, false);
});

// END-TO-END: producer → consumer. A failing test drives councilReview to `refuted` (retry),
// a passing test to `grounded` (answer). This is the execution-grounded self-correction loop.
check("e2e: wrong code → council refuted/retry", () => {
  const v = verifyExec({ language: "js", code: "function add(a,b){return a-b;}", test: TEST });
  const r = councilReview("```js\nfunction add(a,b){return a-b;}\n```", { emit: false, execVerdict: v });
  assert.strictEqual(r.verdict, "refuted");
  assert.strictEqual(r.recommend, "retry");
  assert.strictEqual(r.groundedBy, "execution");
});

check("e2e: correct code → council grounded/answer", () => {
  const v = verifyExec({ language: "js", code: "function add(a,b){return a+b;}", test: TEST });
  const r = councilReview("```js\nfunction add(a,b){return a+b;}\n```", { emit: false, execVerdict: v });
  assert.strictEqual(r.verdict, "grounded");
  assert.strictEqual(r.recommend, "answer");
  assert.strictEqual(r.groundedBy, "execution");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall exec-verify checks passed");
