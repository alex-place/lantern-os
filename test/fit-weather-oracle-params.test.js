// Fit the Σ₀ weather-oracle constants from IEM pairs (#1871, part 1). Verifies the pure
// fit functions recover planted parameters, the IEM CSV parsers work on real sample rows,
// and the oracle loads fitted params with per-field fallback.
// Run: node test/fit-weather-oracle-params.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseCsv, localDayOf, mosForecastHighs, asosDailyHighs, pairData,
  fitBiasRegression, fitSigmaByLead, fitCeiling, fitParams,
} = require("../scripts/fit-weather-oracle-params");
const oracle = require("../lib/kalshi-weather-edge");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// Deterministic Gaussian noise (seeded LCG + Box–Muller) — stable across runs, no RNG.
function seededNoise(seed) {
  let s = seed >>> 0;
  const u = () => { s = (1664525 * s + 1013904223) >>> 0; return (s & 0xffffff) / 0x1000000; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

check("fitBiasRegression recovers planted coolBias + regressionK", () => {
  const COOL = 1.5, K = 0.10, noise = seededNoise(42);
  const pairs = [];
  for (let i = 0; i < 2000; i++) {
    const forecast = 78 + (i % 28);            // 78..105
    const normal = 84, anomaly = forecast - normal, posAnom = Math.max(0, anomaly);
    const settled = forecast - COOL - K * posAnom + noise() * 2.0;
    pairs.push({ forecast, settled, lead: 1, mmdd: "7-1", anomaly, posAnom });
  }
  const fit = fitBiasRegression(pairs);
  assert.ok(near(fit.coolBiasF, COOL, 0.25), `coolBias ${fit.coolBiasF} !≈ ${COOL}`);
  assert.ok(near(fit.regressionK, K, 0.03), `regressionK ${fit.regressionK} !≈ ${K}`);
});

check("fitSigmaByLead recovers planted sigma and its lead slope", () => {
  const noise = seededNoise(7);
  const pairs = [];
  for (let lead = 0; lead <= 3; lead++) {
    const sigma = lead === 0 ? 1.5 : 2.0 + 0.5 * (lead - 1); // nowcast 1.5; base 2.0; +0.5/lead
    for (let i = 0; i < 400; i++) {
      const forecast = 82 + (i % 20), posAnom = Math.max(0, forecast - 84);
      const settled = forecast - 1.5 - 0.1 * posAnom + noise() * sigma;
      pairs.push({ forecast, settled, lead, posAnom });
    }
  }
  const s = fitSigmaByLead(pairs, { coolBiasF: 1.5, regressionK: 0.1 });
  assert.ok(near(s.sigmaNowcastF, 1.5, 0.3), `nowcast ${s.sigmaNowcastF}`);
  assert.ok(near(s.sigmaBaseF, 2.0, 0.3), `base ${s.sigmaBaseF}`);
  assert.ok(near(s.sigmaPerLeadF, 0.5, 0.3), `perLead ${s.sigmaPerLeadF}`);
});

check("fitCeiling measures empirical P(>=100) only on supported bins", () => {
  const pairs = [];
  // forecast 102 bin: 20% of settled reach 100; forecast 96 bin: never.
  for (let i = 0; i < 50; i++) pairs.push({ forecast: 102, settled: i < 10 ? 100 : 98, posAnom: 18 });
  for (let i = 0; i < 50; i++) pairs.push({ forecast: 96, settled: 95, posAnom: 12 });
  for (let i = 0; i < 3; i++) pairs.push({ forecast: 104, settled: 101, posAnom: 20 }); // under-supported
  const table = fitCeiling(pairs, { minSupport: 12 });
  const b102 = table.find((r) => r[0] === 102);
  assert.ok(b102 && near(b102[1], 0.20, 0.001), `102 bin P=${b102 && b102[1]}`);
  assert.ok(!table.find((r) => r[0] === 104), "under-supported 104 bin must be omitted");
});

check("parseCsv + mosForecastHighs extract daily forecast high from real NBS rows", () => {
  // Verbatim-shaped rows from the live IEM endpoint (headers trimmed to those used).
  const csv = [
    "runtime,ftime,model,tmp,station",
    "2025-07-01 01:00:00,2025-07-01 18:00:00,NBS,88,KNYC",
    "2025-07-01 01:00:00,2025-07-01 21:00:00,NBS,91,KNYC",
    "2025-07-01 01:00:00,2025-07-02 00:00:00,NBS,90,KNYC",
  ].join("\n");
  const byRun = mosForecastHighs(parseCsv(csv));
  // 18:00Z & 21:00Z on 7-1 are 14:00/17:00 EDT (still 7-1 local); 00:00Z 7-2 is 20:00 EDT 7-1.
  const run = [...byRun.values()][0];
  const days = [...run.days.values()];
  const jul1 = days.find((d) => d.tgt.m === 7 && d.tgt.day === 1);
  assert.ok(jul1 && jul1.high === 91, `expected local 7-1 high 91, got ${jul1 && jul1.high}`);
});

check("asosDailyHighs takes the local daily max of tmpf", () => {
  const csv = [
    "station,valid,tmpf",
    "NYC,2025-07-01 17:00:00,86.0",
    "NYC,2025-07-01 19:00:00,90.0",
    "NYC,2025-07-01 22:00:00,88.0",
  ].join("\n");
  const byDay = asosDailyHighs(parseCsv(csv));
  const rec = [...byDay.values()].find((r) => r.day.m === 7 && r.day.day === 1);
  assert.ok(rec && rec.high === 90, `expected settled high 90, got ${rec && rec.high}`);
});

check("pairData joins on target day with correct lead + anomaly, filters by month/lead", () => {
  const byRun = mosForecastHighs(parseCsv([
    "runtime,ftime,model,tmp,station",
    "2025-06-29 07:00:00,2025-07-01 18:00:00,NBS,96,KNYC", // run 6-29, target 7-1 → lead 2
  ].join("\n")));
  const settled = asosDailyHighs(parseCsv([
    "station,valid,tmpf", "NYC,2025-07-01 19:00:00,94.0",
  ].join("\n")));
  const pairs = pairData(byRun, settled, { months: [7] });
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].lead, 2);
  assert.strictEqual(pairs[0].forecast, 96);
  assert.strictEqual(pairs[0].settled, 94);
  assert.ok(near(pairs[0].posAnom, 96 - 83.8, 0.01)); // normal 7-1 = 83.8
});

check("fitParams emits only supported fields (n small → no sigma/ceiling override)", () => {
  const pairs = [];
  for (let i = 0; i < 40; i++) pairs.push({ forecast: 90, settled: 88, lead: 1, posAnom: 6 });
  const out = fitParams(pairs);
  assert.ok(typeof out.coolBiasF === "number" && typeof out.regressionK === "number");
  assert.strictEqual(out.ceilingTable, undefined, "no tail support → keep default ceiling");
  assert.ok(out.n === 40);
});

check("oracle.loadParams overrides valid fields and falls back on invalid ones", () => {
  const tmp = path.join(os.tmpdir(), `weather-params-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    coolBiasF: 2.1, regressionK: "bad", sigmaBaseF: 3.0,
    ceilingTable: [[100, 0.5], [102, 0.9]], fittedAt: "2026-07-02", n: 900,
  }));
  const p = oracle.loadParams(tmp);
  fs.unlinkSync(tmp);
  assert.strictEqual(p.coolBiasF, 2.1, "valid field overrides");
  assert.strictEqual(p.regressionK, oracle.DEFAULT_PARAMS.regressionK, "invalid field falls back to default");
  assert.strictEqual(p.sigmaBaseF, 3.0);
  assert.deepStrictEqual(p.ceilingTable, [[100, 0.5], [102, 0.9]]);
  assert.ok(String(p._source).startsWith("fitted 2026-07-02"));
});

check("oracle.loadParams returns all defaults when file is absent", () => {
  const p = oracle.loadParams(path.join(os.tmpdir(), "does-not-exist-xyz.json"));
  assert.strictEqual(p.coolBiasF, oracle.DEFAULT_PARAMS.coolBiasF);
  assert.strictEqual(p._source, "defaults");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll fit-weather-oracle-params tests passed.");
