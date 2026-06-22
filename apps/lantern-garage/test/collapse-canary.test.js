// #1010 — Σ₀ collapse canary on the chat serving path.
// A forced repeating / collapsed reply must raise proximity and emit a signal;
// healthy varied replies must be unaffected (proximity below threshold).
//
// Run: node apps/lantern-garage/test/collapse-canary.test.js
const assert = require("assert");
const { scoreReplyCollapse, antiCollapseSignal } = require("../lib/collapse-canary");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const HEALTHY = `The convergence loop observes the world, remembers what it saw, reasons about
what to do next, acts on that plan, and verifies the outcome against external evidence.
Each stage strengthens the one before it, and nothing is accepted without a source.`;

const LOOP_COLLAPSE = ("I am not sure what you mean. " .repeat(10)).trim();
const PHRASE_ECHO = ("the system is fine the system is fine " .repeat(8)).trim();
const DEGENERATE = ("yes " .repeat(40)).trim();

// --- healthy reply stays well below threshold
const healthy = scoreReplyCollapse(HEALTHY);
check("healthy reply: not collapsed", () => {
  assert.strictEqual(healthy.collapsed, false, `proximity=${healthy.proximity}`);
  assert.ok(healthy.proximity < 0.5, `expected low proximity, got ${healthy.proximity}`);
});

// --- forced repetition crosses threshold
const loop = scoreReplyCollapse(LOOP_COLLAPSE);
check("literal sentence loop: collapsed + high proximity", () => {
  assert.strictEqual(loop.collapsed, true, `proximity=${loop.proximity}`);
  assert.ok(loop.proximity >= 0.5);
});

const echo = scoreReplyCollapse(PHRASE_ECHO);
check("phrase echo: collapsed", () => assert.strictEqual(echo.collapsed, true, `proximity=${echo.proximity}`));

const degen = scoreReplyCollapse(DEGENERATE);
check("single-token degeneration: collapsed", () => assert.strictEqual(degen.collapsed, true, `proximity=${degen.proximity}`));

// --- short replies don't false-positive
const short = scoreReplyCollapse("Sure, done.");
check("short reply: no signal (too_short)", () => {
  assert.strictEqual(short.collapsed, false);
  assert.strictEqual(short.reason, "too_short");
});

// --- collapse raises a usable signal payload
check("antiCollapseSignal emits a canary event + action", () => {
  const sig = antiCollapseSignal(loop);
  assert.strictEqual(sig.event, "canary_collapse");
  assert.ok(["inject_novelty", "truncate_context", "switch_agent"].includes(sig.action));
  assert.ok(sig.proximity >= 0.5);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall collapse-canary checks passed");
