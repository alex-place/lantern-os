// ForecastEx fee rail + fee-aware EV gate (#2217). The band-robust gate must price the
// SAME edge on either venue by swapping only the fee function; the cheaper rail can never
// certify LESS edge than Kalshi, and the default path stays Kalshi.
// Run: node apps/lantern-garage/test/forecastex-fees.test.js
const assert = require("assert");
const m = require("../lib/kalshi-weather-edge");
const { forecastExFeeCents, makeFlatFee, DEFAULT_FEE_CENTS } = require("../lib/forecastex-fees");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const LADDER = [["A", null, 91], ["B", 92, 93], ["C", 94, 95], ["D", 96, 97], ["E", 98, 99], ["F", 100, null]];

check("flat fee is price-independent and matches the $0.01 default", () => {
  assert.strictEqual(DEFAULT_FEE_CENTS, 1.0);
  assert.strictEqual(forecastExFeeCents(0.05), 1.0);
  assert.strictEqual(forecastExFeeCents(0.50), 1.0); // where Kalshi would charge ~2c
  assert.strictEqual(forecastExFeeCents(0.95), 1.0);
});

check("ForecastEx fee is <= Kalshi fee at every price (the whole thesis)", () => {
  for (let p = 0.01; p < 1; p += 0.01) {
    assert.ok(forecastExFeeCents(p) <= m.kalshiFeeCents(p) + 1e-9, `p=${p}`);
  }
});

check("makeFlatFee is configurable (probe can override the measured fee)", () => {
  const half = makeFlatFee(0.5);
  assert.strictEqual(half(0.4), 0.5);
  const zero = makeFlatFee(0);
  assert.strictEqual(zero(0.4), 0);
});

check("fee-aware gate: ForecastEx never certifies LESS worst-case edge than Kalshi", () => {
  // Sweep a spread of markets quoted below fair; the cheaper rail must dominate bucket-by-bucket.
  for (const fc of [95, 97, 99, 102]) {
    const fair = m.calibratedDistribution(fc, 1, LADDER, 7, 3);
    const ask = {};
    for (const [l] of LADDER) ask[l] = Math.max(0.02, Math.min(0.98, fair[l] - 0.05));
    const kal = m.robustEdgeReport(fc, 1, LADDER, ask, 7, 3, 5);
    const fex = m.robustEdgeReport(fc, 1, LADDER, ask, 7, 3, 5, undefined, forecastExFeeCents);
    for (const kr of kal.rows) {
      const fr = fex.rows.find((x) => x.bucket === kr.bucket);
      assert.ok(fr && fr.worst_c >= kr.worst_c - 1e-9, `fc=${fc} ${kr.bucket}: fex ${fr && fr.worst_c} < kal ${kr.worst_c}`);
    }
    assert.ok(fex.actionable.length >= kal.actionable.length, `fc=${fc}: fewer actionable on cheaper rail`);
  }
});

check("default robustEdgeReport path is still Kalshi (no regression)", () => {
  assert.strictEqual(m.selfTest().ok, true);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll forecastex-fees tests passed.");
