"use strict";
// P2-5: unit tests for the Avellaneda-Stoikov inventory-aware quoter. Tests the model's
// KNOWN PROPERTIES (skew direction, monotonicity), not magic numbers. Fully offline.
// Run: node apps/lantern-garage/test/kalshi-as-quoter.test.js
const assert = require("assert");
const q = require("../lib/kalshi-as-quoter");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

const base = { midCents: 50, gamma: 0.1, sigmaCents: 6, tau: 1, k: 1.5 };

// ── reservation price: inventory skew ─────────────────────────────────────────
check("flat inventory → reservation == mid (no skew)", () => {
  assert.strictEqual(q.reservationPrice(50, 0, base), 50);
});
check("long inventory → reservation BELOW mid (leans to sell)", () => {
  assert.ok(q.reservationPrice(50, +5, base) < 50);
});
check("short inventory → reservation ABOVE mid (leans to buy)", () => {
  assert.ok(q.reservationPrice(50, -5, base) > 50);
});
check("skew grows with the size of the position", () => {
  const small = 50 - q.reservationPrice(50, +2, base);
  const big = 50 - q.reservationPrice(50, +8, base);
  assert.ok(big > small, "bigger long → bigger downward skew");
});
check("skew shrinks toward zero as time-to-close → 0", () => {
  const far = 50 - q.reservationPrice(50, +5, { ...base, tau: 1 });
  const near = 50 - q.reservationPrice(50, +5, { ...base, tau: 0.05 });
  assert.ok(near < far, "less time at risk → less inventory skew");
});

// ── optimal half-spread: monotonicity ─────────────────────────────────────────
check("half-spread is non-negative", () => {
  assert.ok(q.optimalHalfSpread(base) >= 0);
});
check("half-spread widens with volatility", () => {
  assert.ok(q.optimalHalfSpread({ ...base, sigmaCents: 10 }) > q.optimalHalfSpread({ ...base, sigmaCents: 3 }));
});
check("half-spread widens with risk aversion", () => {
  assert.ok(q.optimalHalfSpread({ ...base, gamma: 0.3 }) > q.optimalHalfSpread({ ...base, gamma: 0.05 }));
});
check("half-spread widens with time remaining", () => {
  assert.ok(q.optimalHalfSpread({ ...base, tau: 1 }) > q.optimalHalfSpread({ ...base, tau: 0.1 }));
});
check("deeper book (higher k) → tighter spread", () => {
  assert.ok(q.optimalHalfSpread({ ...base, k: 5 }) < q.optimalHalfSpread({ ...base, k: 0.5 }));
});

// ── full quote: structure + invariants ────────────────────────────────────────
check("flat quote is symmetric around the mid", () => {
  const r = q.quote(base);
  assert.strictEqual(r.skewCents, 0);
  assert.strictEqual(50 - r.bidCents, r.askCents - 50);
});
check("long inventory skews BOTH quotes down (offload bias)", () => {
  const flat = q.quote(base);
  const long = q.quote({ ...base, inventory: +6 });
  assert.ok(long.reservationCents < flat.reservationCents);
  assert.ok(long.bidCents <= flat.bidCents && long.askCents <= flat.askCents);
  assert.ok(long.skewCents < 0);
});
check("bid < ask always (quotes never cross), clamped to 1..99", () => {
  for (const inv of [-40, -5, 0, 5, 40]) {
    const r = q.quote({ ...base, inventory: inv, sigmaCents: 20, gamma: 0.5 });
    assert.ok(r.bidCents < r.askCents, `crossed at inv=${inv}: ${r.bidCents}/${r.askCents}`);
    assert.ok(r.bidCents >= 1 && r.askCents <= 99, `out of band at inv=${inv}`);
  }
});
check("half-spread respects the minimum-tick floor", () => {
  const r = q.quote({ ...base, sigmaCents: 0, tau: 0, minTickCents: 2 });
  assert.ok(r.halfSpreadCents >= 2);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-as-quoter tests passed.");
