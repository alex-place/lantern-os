"use strict";
// #2787 / #2853 — the EOQ re-grounding cadence: ρ estimation (de-bursted censored-exposure MLE,
// mirroring scan_m2), the EOQ square-root law T*=√(2·(p_v/p_e)/ρ), and the honest fallback to the
// constant tick when the ledger can't fit ρ.
//
// Run: node test/regrounding-scheduler.test.js
const assert = require("assert");
const {
  estimateDecayRate, eoqIntervalMs, groundingCadenceForKey, isRegroundingDue,
  MIN_CADENCE_MS, MAX_CADENCE_MS, DEFAULT_PV_PE,
} = require("../lib/regrounding-scheduler");
const { GROUNDING_TICK_MS } = require("../lib/grounding-policy");

const HOUR = 3600 * 1000;
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

check("ρ from a clean success→failure flip = flips/exposure (censored-exposure MLE)", () => {
  // success at t=0, failure 100h later → 1 flip over 100h exposure → half-life = ln2·100h
  const est = estimateDecayRate([{ ts: 0, outcome: 1 }, { ts: 100 * HOUR, outcome: 0 }]);
  assert.strictEqual(est.nFlips, 1);
  assert.ok(near(est.exposureSec, 100 * 3600, 1), "exposure = 100h");
  assert.ok(near(est.rhoPerSec, 1 / (100 * 3600), 1e-12), "ρ = 1/exposure");
  assert.ok(near(est.halfLifeHours, Math.LN2 * 100, 0.1), `half-life ≈ ${Math.LN2 * 100}h`);
});

check("de-burst: probes < 60 s apart are one observation (no spurious flip)", () => {
  // a success→failure only 30 s apart must NOT count as a flip
  const est = estimateDecayRate([{ ts: 0, outcome: 1 }, { ts: 30 * 1000, outcome: 0 }]);
  assert.strictEqual(est.nFlips, 0);
  assert.strictEqual(est.nBurstDropped, 1);
  assert.strictEqual(est.rhoPerSec, null);
});

check("no flips / only successes → ρ null (cannot fit)", () => {
  const est = estimateDecayRate([{ ts: 0, outcome: 1 }, { ts: 100 * HOUR, outcome: 1 }]);
  assert.strictEqual(est.rhoPerSec, null);
  assert.strictEqual(est.nFlips, 0);
});

check("EOQ law: T* = √(2·(p_v/p_e)/ρ), in seconds→ms, within guard rails", () => {
  const rho = 1 / (100 * 3600); // 2.78e-6 /s
  const expectMs = Math.sqrt((2 * DEFAULT_PV_PE) / rho) * 1000;
  const got = eoqIntervalMs(rho, {});
  assert.ok(near(got, expectMs, 1), `T* ≈ ${expectMs}ms`);
  assert.ok(got > MIN_CADENCE_MS && got < MAX_CADENCE_MS, "within [1min, 24h]");
});

check("EOQ is monotonic: faster decay (bigger ρ) → shorter cadence", () => {
  assert.ok(eoqIntervalMs(1e-5, {}) < eoqIntervalMs(1e-6, {}));
});

check("EOQ honors the p_v/p_e ratio and clamps extremes", () => {
  assert.strictEqual(eoqIntervalMs(null, {}), null);         // no ρ → no derived cadence
  assert.strictEqual(eoqIntervalMs(-1, {}), null);           // non-positive ρ → null
  assert.strictEqual(eoqIntervalMs(1e-12, {}), MAX_CADENCE_MS); // tiny ρ → capped, not absurd
  assert.strictEqual(eoqIntervalMs(1e6, {}), MIN_CADENCE_MS);   // huge ρ → floored
  // bigger error cost (smaller p_v/p_e) → shorter interval
  assert.ok(eoqIntervalMs(1e-6, { pVerify: 1, pError: 100 }) < eoqIntervalMs(1e-6, { pVerify: 1, pError: 1 }));
});

check("groundingCadenceForKey filters by key and derives per-key cadence", () => {
  const rows = [
    { key: "A", ts: 0, outcome: 1 }, { key: "A", ts: 100 * HOUR, outcome: 0 },
    { key: "B", ts: 0, outcome: 1 }, { key: "B", ts: 200 * HOUR, outcome: 1 }, // B never flips
  ];
  const a = groundingCadenceForKey("A", rows);
  const b = groundingCadenceForKey("B", rows);
  assert.ok(a.cadenceMs > 0 && a.nFlips === 1, "A gets a derived cadence");
  assert.strictEqual(b.cadenceMs, null, "B cannot fit ρ → null (fall back to constant)");
});

check("isRegroundingDue: derived cadence when the ledger supports it, constant fallback otherwise", () => {
  const rows = [{ key: "A", ts: 0, outcome: 1 }, { key: "A", ts: 100 * HOUR, outcome: 0 }];
  const now = 1000 * HOUR;

  const derived = isRegroundingDue("A", now - 10 * HOUR, { nowMs: now, calRows: rows });
  assert.strictEqual(derived.derived, true);
  assert.ok(derived.cadenceMs !== GROUNDING_TICK_MS, "A uses its own EOQ cadence, not the constant");
  assert.strictEqual(derived.due, (now - (now - 10 * HOUR)) >= derived.cadenceMs);

  const fallback = isRegroundingDue("NOKEY", now - 10 * HOUR, { nowMs: now, calRows: rows });
  assert.strictEqual(fallback.derived, false);
  assert.strictEqual(fallback.cadenceMs, GROUNDING_TICK_MS, "unknown key → constant tick");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
