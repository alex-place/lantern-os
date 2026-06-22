// #1012 — mandatory periodic external-grounding tick (boiling-frog defense).
// The cadence must fire on a timer even when collapse-proximity ~0, be configurable,
// and degrade safely (never-grounded → due; cadence 0 → disabled).
//
// Run: node apps/lantern-garage/test/grounding-tick.test.js
const assert = require("assert");
const { isGroundingDue, groundingPolicy, GROUNDING_TICK_MS } = require("../lib/grounding-policy");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const MIN = 60_000;

// never grounded → due immediately
check("never grounded → due", () => assert.strictEqual(isGroundingDue(0, 1_000_000, MIN), true));

// within cadence → not due (this is the proximity~0 case: nothing else triggers grounding)
check("within cadence → not due", () => assert.strictEqual(isGroundingDue(1_000_000, 1_000_000 + MIN - 1, MIN), false));

// cadence elapsed → due, regardless of any proximity signal
check("cadence elapsed → due", () => assert.strictEqual(isGroundingDue(1_000_000, 1_000_000 + MIN, MIN), true));
check("well past cadence → due", () => assert.strictEqual(isGroundingDue(1_000_000, 1_000_000 + 10 * MIN, MIN), true));

// configurable: 0 disables the cadence entirely
check("cadence 0 → disabled (never due)", () => {
  assert.strictEqual(isGroundingDue(0, 5_000_000, 0), false);
  assert.strictEqual(isGroundingDue(1_000_000, 9_999_999, 0), false);
});

// default cadence is a positive, sane value
check("default GROUNDING_TICK_MS is positive", () => assert.ok(GROUNDING_TICK_MS > 0));

// the existing dilation→budget policy is unchanged
check("groundingPolicy still produces a budget", () => {
  const p = groundingPolicy(3.5);
  assert.strictEqual(p.fetchExternal, true);
  assert.strictEqual(p.deepMode, true);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.error("\nall grounding-tick checks passed");
