// Σ₀ weather-oracle distribution-level Verify (#1871). RPS/PIT/reliability over the
// ordinal bucket ladder — the diagnostics kalshi-calibration's scalar Brier can't give.
// Run: node apps/lantern-garage/test/kalshi-weather-verify.test.js
const assert = require("assert");
const {
  rps, pit, pitUniformity, reliability, settledBucketFromHigh, distVector,
  gradedRecords, buildReport, selfTest, MIN_SAMPLES,
} = require("../lib/kalshi-weather-verify");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const LAD = [["a", null, 91], ["b", 92, 93], ["c", 94, 95], ["d", 96, 97], ["e", 98, 99], ["f", 100, null]];

check("embedded selfTest passes", () => {
  const r = selfTest();
  assert.ok(r.ok, "selfTest failures: " + JSON.stringify(r.fails));
});

check("rps: point mass on truth scores 0; nearness beats distance", () => {
  assert.strictEqual(rps([0, 0, 1, 0, 0, 0], 2), 0);
  const near = rps([0, 1, 0, 0, 0, 0], 2);
  const far = rps([1, 0, 0, 0, 0, 0], 2);
  assert.ok(near > 0 && near < far, `near=${near} far=${far}`);
  // symmetric one-off should score identically on either side
  assert.ok(approx(rps([0, 1, 0, 0, 0, 0], 2), rps([0, 0, 0, 1, 0, 0], 2)));
});

check("rps: guards degenerate input", () => {
  assert.strictEqual(rps([1], 0), null);        // K<2
  assert.strictEqual(rps([0.5, 0.5], 5), null); // obs out of range
});

check("pit: monotone in observed bucket; mid-bucket convention", () => {
  const d = [0.1, 0.2, 0.4, 0.2, 0.1];
  const p0 = pit(d, 0), p2 = pit(d, 2), p4 = pit(d, 4);
  assert.ok(p0 < p2 && p2 < p4, `pit not monotone: ${p0} ${p2} ${p4}`);
  assert.ok(approx(p0, 0.05));  // 0 below + half of 0.1
  assert.ok(approx(p2, 0.5));   // 0.3 below + half of 0.4
});

check("settledBucketFromHigh: interior + open tails + miss", () => {
  assert.strictEqual(settledBucketFromHigh(LAD, 95), 2);
  assert.strictEqual(settledBucketFromHigh(LAD, 103), 5); // open top
  assert.strictEqual(settledBucketFromHigh(LAD, 80), 0);  // open bottom
  assert.strictEqual(settledBucketFromHigh(LAD, NaN), -1);
});

check("distVector: renormalizes and follows ladder order", () => {
  const v = distVector({ a: 2, c: 2 }, LAD); // unnormalized, missing buckets → 0
  assert.ok(approx(v.reduce((s, x) => s + x, 0), 1));
  assert.ok(approx(v[0], 0.5) && approx(v[2], 0.5));
});

check("pitUniformity: flat sample ≈ 1; piled sample ≫ 1", () => {
  const flat = [];
  for (let i = 0; i < 100; i++) flat.push((i + 0.5) / 100); // evenly spread across [0,1]
  const u = pitUniformity(flat);
  assert.ok(u.chi2_reduced < 1.0, `flat χ²ᵣ too high: ${u.chi2_reduced}`);
  const piled = new Array(100).fill(0.02); // all in bin 0
  assert.ok(pitUniformity(piled).chi2_reduced > 10, "piled sample should be far from uniform");
});

check("reliability: perfectly-calibrated pairs → ~0 ECE", () => {
  // 0.7-confidence bucket that resolves 70% of the time
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push({ p: 0.7, outcome: i < 70 ? 1 : 0 });
  const rel = reliability(pairs);
  assert.ok(rel.ece < 0.02, `ECE should be tiny, got ${rel.ece}`);
});

check("buildReport: sharp-correct forecast beats climatology (positive RPS skill)", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const t = i % LAD.length;
    const dist = {};
    LAD.forEach(([lbl], k) => { dist[lbl] = k === t ? 0.6 : Math.abs(k - t) === 1 ? 0.2 : 0; });
    rows.push({ event: "open", id: `g${i}`, ticker: "KXHIGHNY-x", ladder: LAD, dist, heldBucket: LAD[t][0] });
    rows.push({ event: "close", id: `g${i}`, settledBucket: t });
  }
  const rep = buildReport(gradedRecords(rows));
  assert.ok(rep.active, `should be active at n=${rep.n}`);
  assert.ok(rep.rpsSkill > 0, `skill should be positive: ${rep.rpsSkill}`);
  assert.ok(rep.meanRPS < rep.climatologyRPS, "meanRPS must beat climatology");
});

check("buildReport: over-confident-wrong forecast LOSES to climatology + flags PIT", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const t = 3 + (i % 3);
    rows.push({ event: "open", id: `b${i}`, ticker: "KXHIGHNY-y", ladder: LAD, dist: { a: 1 }, heldBucket: "a" });
    rows.push({ event: "close", id: `b${i}`, settledBucket: t });
  }
  const rep = buildReport(gradedRecords(rows));
  assert.ok(rep.rpsSkill < 0, `over-confident-wrong should have negative skill: ${rep.rpsSkill}`);
  assert.ok(rep.pit.chi2_reduced > 3, `PIT should flag mis-calibration: ${rep.pit.chi2_reduced}`);
});

check("buildReport: honest no-op under MIN_SAMPLES", () => {
  const rep = buildReport(gradedRecords([
    { event: "open", id: "x", ticker: "KXHIGHNY-1", ladder: LAD, dist: { c: 1 }, heldBucket: "c" },
    { event: "close", id: "x", settledBucket: 2 },
  ]));
  assert.strictEqual(rep.active, false);
  assert.ok(rep.n < MIN_SAMPLES);
});

check("gradedRecords: derives observed bucket from settledHigh when settledBucket absent", () => {
  const recs = gradedRecords([
    { event: "open", id: "h", ticker: "KXHIGHNY-1", ladder: LAD, dist: { c: 1 }, heldBucket: "c" },
    { event: "close", id: "h", settledHigh: 95 }, // → bucket c (index 2)
  ]);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].obsIdx, 2);
  assert.strictEqual(recs[0].outcome, 1); // held c, settled c
});

check("gradedRecords: skips non-weather tickers and rows lacking dist/ladder", () => {
  assert.strictEqual(gradedRecords([
    { event: "open", id: "z", ticker: "KXBTC-1", ladder: LAD, dist: { a: 1 } },
    { event: "close", id: "z", settledBucket: 0 },
  ]).length, 0);
  assert.strictEqual(gradedRecords([
    { event: "open", id: "w", ticker: "KXHIGHNY-1" }, // no dist/ladder
    { event: "close", id: "w", settledBucket: 0 },
  ]).length, 0);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-weather-verify tests passed.");
