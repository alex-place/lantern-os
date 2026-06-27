// Σ₀ canary harness (lib/canary.js): ONE call runs BOTH axes and returns two
// sub-scores + a signature patch that preserves the prior per-block behavior.
//
// Run: node apps/lantern-garage/test/canary.test.js
const assert = require("assert");
const { runCanaries, recordCanaryEvent, CANARY_EVENTS } = require("../lib/canary");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// A healthy, varied, reflective reply trips NEITHER axis.
const HEALTHY =
  "The convergence loop observes the world, then reasons about what to do next and acts. " +
  "Each stage strengthens the one before it, and nothing is accepted without checking it " +
  "against something real first.";
check("healthy reply: neither axis trips, no behavior change", () => {
  const r = runCanaries(HEALTHY, { emit: false });
  assert.deepStrictEqual(r.tripped, []);
  assert.strictEqual(r.collapse.collapsed, false);
  assert.strictEqual(r.grounded.ungrounded, false);
  // signature patch always carries both sub-scores
  assert.ok(typeof r.signaturePatch.sigma0_proximity === "number");
  assert.ok(typeof r.signaturePatch.sigma0_grounding.risk === "number");
  assert.strictEqual(r.signaturePatch.canary, undefined);
  assert.strictEqual(r.signaturePatch.ungrounded, undefined);
});

// Degeneration axis: a literal loop trips collapse but NOT groundedness.
const LOOP = ("I can help with that. ").repeat(12);
check("loop reply: collapse axis only", () => {
  const r = runCanaries(LOOP, { emit: false });
  assert.ok(r.tripped.includes("collapse"), `tripped=${r.tripped}`);
  assert.ok(!r.tripped.includes("grounded"));
  assert.ok(r.signaturePatch.canary, "collapse signal stamped");
});

// 42-state axis: confident + unanchored trips groundedness but NOT collapse —
// proving the two axes are distinct (a single blended score would hide this).
const CONFIDENT_UNANCHORED =
  "The Treaty of Westphalia was signed in 1648 and ended the Thirty Years War. " +
  "It established the modern principle of state sovereignty across Europe. " +
  "Cardinal Mazarin negotiated the French terms, and the population of Münster was 12000 at the time.";
check("42-state reply: groundedness axis only (collapse reads healthy)", () => {
  const r = runCanaries(CONFIDENT_UNANCHORED, { emit: false });
  assert.ok(r.tripped.includes("grounded"), `tripped=${r.tripped}`);
  assert.strictEqual(r.collapse.collapsed, false, "42-state must look healthy to collapse axis");
  assert.strictEqual(r.signaturePatch.ungrounded, true);
});

// External grounding lowers the groundedness risk via the harness (anchor passthrough).
check("grounding context flows through the harness", () => {
  const bare = runCanaries(CONFIDENT_UNANCHORED, { emit: false });
  const grounded = runCanaries(CONFIDENT_UNANCHORED, {
    emit: false, groundingContext: "Web search: Peace of Westphalia, 1648 ...",
  });
  assert.ok(grounded.grounded.risk < bare.grounded.risk, "grounding must lower risk");
  assert.strictEqual(grounded.grounded.anchored, true);
});

// The event stream is the canonical convergence path, and emit is a no-throw promise.
check("recordCanaryEvent returns a promise, never throws", () => {
  assert.ok(/data[\\/]convergence[\\/]canary-events\.jsonl$/.test(CANARY_EVENTS), CANARY_EVENTS);
  const p = recordCanaryEvent({ tripped: ["collapse"], text_length: 1 });
  assert.ok(p && typeof p.then === "function");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall canary harness checks passed");
