"use strict";
// #2926 (M8) — unit checks for the freshness index (Whittle index for re-verification).
// Run: node apps/lantern-garage/test/grounding-whittle-index.test.js
const assert = require("assert");
const { whittleFreshnessIndex } = require("../lib/grounding-policy");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("W(1) = c_e*rho - c_v exactly (audit-every-step boundary)", () => {
  const w = whittleFreshnessIndex(1, 0.02, { verifyCost: 0.5, errorCost: 1.0 });
  assert.ok(Math.abs(w - (0.02 - 0.5)) < 1e-12);
});

check("strictly increasing in paid age (indexability's engine)", () => {
  let prev = -Infinity;
  for (let tau = 1; tau <= 200; tau++) {
    const w = whittleFreshnessIndex(tau, 0.05, { verifyCost: 0.3, errorCost: 2.0 });
    assert.ok(w > prev, `not increasing at tau=${tau}`);
    prev = w;
  }
});

check("bounded above by c_e/rho - c_v (feasibility ceiling for the budget shadow price)", () => {
  const cap = 1.0 / 0.05 - 0.3;
  const w = whittleFreshnessIndex(5000, 0.05, { verifyCost: 0.3, errorCost: 1.0 });
  assert.ok(w < cap && w > cap - 1e-6);
});

check("zero-crossing reproduces the EOQ cadence for small rho (M2 unification)", () => {
  const rho = 0.001, r = 0.1; // c_v/c_e
  let tau = 1;
  while (whittleFreshnessIndex(tau, rho, { verifyCost: r, errorCost: 1.0 }) < 0) tau++;
  const eoq = Math.sqrt((2 * r) / rho); // = 14.14
  assert.ok(Math.abs(tau - eoq) <= 1, `crossing ${tau} vs EOQ ${eoq}`);
});

check("coerces degenerate inputs instead of throwing (pure, never throws)", () => {
  const w = whittleFreshnessIndex(0, 0, {});
  assert.ok(Number.isFinite(w));
  const w2 = whittleFreshnessIndex("nope", "nope");
  assert.ok(Number.isFinite(w2));
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
