// Promotion-validation helpers for the weather-oracle fit (#1871). Pure parts only:
// CLI settlement parsing + the forward predictive model + proper-score ranking.
// Run: node test/validate-weather-oracle-fit.test.js
const assert = require("assert");
const { cliSettledHighs } = require("../scripts/fit-weather-oracle-params");
const { forwardProbs, scoreParams } = require("../scripts/validate-weather-oracle-fit");
const oracle = require("../lib/kalshi-weather-edge");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

check("cliSettledHighs parses NWS CLI results and skips missing highs", () => {
  const m = cliSettledHighs([
    { valid: "2024-07-01", high: 81 },
    { valid: "2024-07-02", high: "M" },  // missing -> skipped
    { valid: "2024-07-03", high: 95 },
    { valid: "bad-date", high: 90 },      // malformed -> skipped
  ]);
  assert.strictEqual(m.size, 2);
  assert.strictEqual(m.get("2024-7-1").high, 81);
  assert.strictEqual(m.get("2024-7-3").high, 95);
  assert.strictEqual(m.get("2024-7-1").day.mmdd, "7-1");
});

check("forwardProbs is a normalized distribution honoring the ceiling", () => {
  const { probs, lo } = forwardProbs(102, 1, "7-3", oracle.DEFAULT_PARAMS);
  assert.ok(near(probs.reduce((s, v) => s + v, 0), 1, 1e-9), "must sum to 1");
  assert.strictEqual(lo, 70);
  // P(>=100) must not exceed the ceiling interp for a 102°F forecast (~0.19 default).
  let p100 = 0;
  for (let i = 0; i < probs.length; i++) if (70 + i >= 100) p100 += probs[i];
  assert.ok(p100 <= 0.20 + 1e-6, `ceiling not enforced: P(>=100)=${p100}`);
});

check("forwardProbs shifts mean with coolBias sign", () => {
  // negative coolBias => warmer mean => more mass at/above the forecast bucket
  const warm = forwardProbs(90, 1, "7-1", { ...oracle.DEFAULT_PARAMS, coolBiasF: -1.5 });
  const cool = forwardProbs(90, 1, "7-1", { ...oracle.DEFAULT_PARAMS, coolBiasF: 1.5 });
  const massGE = (d) => d.probs.slice(90 - d.lo).reduce((s, v) => s + v, 0);
  assert.ok(massGE(warm) > massGE(cool), "negative coolBias should push mass warmer");
});

check("scoreParams ranks the data-generating params below a biased set (lower RPS)", () => {
  // Synthetic truth: settled ≈ forecast + 1.5 (i.e. coolBias -1.5), tight.
  const pairs = [];
  for (let i = 0; i < 300; i++) {
    const forecast = 84 + (i % 12);
    pairs.push({ forecast, lead: 1, mmdd: "7-1", settled: Math.round(forecast + 1.5) });
  }
  const good = { ...oracle.DEFAULT_PARAMS, coolBiasF: -1.5, regressionK: 0, sigmaBaseF: 1.5 };
  const bad = { ...oracle.DEFAULT_PARAMS, coolBiasF: 1.2 };  // default sign — wrong here
  const sGood = scoreParams(pairs, good);
  const sBad = scoreParams(pairs, bad);
  // RPS is the ranking that matters: the params matching the data-generating bias score lower.
  // (PIT uniformity is NOT a valid check on a deterministic set — a perfectly-centered forecast
  //  piles PIT at 0.5, which is intentionally non-uniform; that's covered in the OOS run.)
  assert.ok(sGood.meanRPS < sBad.meanRPS, `good ${sGood.meanRPS} !< bad ${sBad.meanRPS}`);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll validate-weather-oracle-fit tests passed.");
