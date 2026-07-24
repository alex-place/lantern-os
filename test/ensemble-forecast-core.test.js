// Phase-0 GenCast harness (#2239) — the ensemble→bucket adapter + Gate G1 backtest.
// Measurement only; grades against the SAME RPS math the live verifier uses.
// Run: node test/ensemble-forecast-core.test.js
const assert = require("assert");
const efc = require("../lib/ensemble-forecast-core");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const LADDER = [["A", null, 91], ["B", 92, 93], ["C", 94, 95], ["D", 96, 97], ["E", 98, 99], ["F", 100, null]];

check("adapter: histograms members into ladder buckets, normalized", () => {
  const d = efc.ensembleToBucketDist([96, 97, 96.5, 98, 94], LADDER); // 3 in D(96-97), 1 in E, 1 in C
  assert.ok(Math.abs(Object.values(d).reduce((s, x) => s + x, 0) - 1) < 1e-9, "sums to 1");
  assert.ok(Math.abs(d["D"] - 0.6) < 1e-9, `D should be 0.6, got ${d["D"]}`);
  assert.ok(Math.abs(d["E"] - 0.2) < 1e-9);
  assert.strictEqual(d["A"], 0);
});

check("adapter: empty/degenerate members → flat, no false confidence", () => {
  const d = efc.ensembleToBucketDist([], LADDER);
  assert.ok(Math.abs(d["A"] - 1 / LADDER.length) < 1e-9);
});

// Synthetic day generator: settled highs drawn deterministically; ensemble members are the
// truth ± jitter (sharp), the oracle uses the fitted core, climatology is flat.
function makeDays(n, ensembleJitter) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const settledHigh = 94 + (i % 5);                        // 94..98, spread across buckets
    const members = Array.from({ length: 20 }, (_, k) =>     // tight cloud around the truth
      settledHigh + ((k % 5) - 2) * ensembleJitter);
    days.push({ members, ladder: LADDER, settledHigh, forecastHigh: settledHigh + 1, leadDays: 1, month: 7, day: 3 });
  }
  return days;
}

check("G1: a SHARP well-centered ensemble beats climatology (and reports)", () => {
  const r = efc.backtestG1(makeDays(30, 0.3));  // very tight, truth-centered
  assert.strictEqual(r.n, 30);
  assert.strictEqual(r.active, true);
  assert.ok(r.meanRPS.proxy < r.meanRPS.climatology, `proxy ${r.meanRPS.proxy} !< climo ${r.meanRPS.climatology}`);
  assert.ok(r.beatsClimo, "sharp ensemble must beat flat climatology");
});

check("G1: a WIDE ensemble (no skill) does NOT beat climatology", () => {
  // members spread across the whole ladder → ~flat dist → no better than climatology
  const days = Array.from({ length: 30 }, (_, i) => ({
    members: [88, 91, 94, 97, 100, 103], ladder: LADDER, settledHigh: 94 + (i % 5),
    forecastHigh: 96, leadDays: 1, month: 7, day: 3,
  }));
  const r = efc.backtestG1(days);
  assert.ok(!r.beatsClimo || r.meanRPS.proxy >= r.meanRPS.climatology - 1e-9,
    "a sk-less wide ensemble should not clear climatology");
  assert.notStrictEqual(r.verdict, "ensemble-wins-G1");
});

check("G1: below MIN_SAMPLES → undecided, stand down", () => {
  const r = efc.backtestG1(makeDays(10, 0.3));
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.verdict, "insufficient-data");
});

check("oracleDist reuses the fitted calibratedDistribution (sums to 1)", () => {
  const d = efc.oracleDist({ forecastHigh: 96, leadDays: 1, ladder: LADDER, month: 7, day: 3 });
  assert.ok(Math.abs(Object.values(d).reduce((s, x) => s + x, 0) - 1) < 1e-6);
});

check("timeLaggedEnsemble: each prior-day run's max-over-day = one member", () => {
  const rows = [
    // two runs (D-1) forecasting target day 2025-07-03; max over day per run
    { runtime: "2025-07-02 12:00:00", ftime: "2025-07-03 18:00:00", tmp: "95" },
    { runtime: "2025-07-02 12:00:00", ftime: "2025-07-03 21:00:00", tmp: "97" }, // run A max=97
    { runtime: "2025-07-02 18:00:00", ftime: "2025-07-03 20:00:00", tmp: "96" }, // run B max=96
    { runtime: "2025-07-03 06:00:00", ftime: "2025-07-03 20:00:00", tmp: "99" }, // same-day run → excluded
    { runtime: "2025-07-02 12:00:00", ftime: "2025-07-04 18:00:00", tmp: "88" }, // wrong day → excluded
  ];
  const e = efc.timeLaggedEnsemble(rows, "2025-07-03", { offsetH: -4 });
  assert.strictEqual(e.runCount, 2, "two prior-day runs");
  assert.deepStrictEqual(e.members.sort(), [96, 97]);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll ensemble-forecast-core tests passed.");
