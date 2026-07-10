// Day-ahead evaluation core (#2217) — pure logic, no network. The conventions under test
// mirror the measured ForecastEx facts: strict-exceed cumulative board, clean-flip
// settlement, flat 1¢ fee. Run: node apps/lantern-garage/test/forecastex-dayahead.test.js
const assert = require("assert");
const d = require("../lib/forecastex-dayahead");
const verify = require("../lib/kalshi-weather-verify");
const { loadVenueParams } = require("../lib/forecastex-weather");
const { makeFlatFee } = require("../lib/forecastex-fees");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// A day-ahead cumulative board: P(high > thr) at EOD closes, one listing gap (84 missing).
const BOARD = [
  { thr: 80, yes: 0.97 }, { thr: 81, yes: 0.90 }, { thr: 82, yes: 0.72 },
  { thr: 83, yes: 0.48 }, { thr: 85, yes: 0.12 }, { thr: 86, yes: 0.04 },
];

check("ladderFromBoard covers ℝ with no holes (gap widens a bucket, tails open)", () => {
  const lad = d.ladderFromBoard(BOARD);
  assert.deepStrictEqual(lad[0], ["<=80", null, 80]);
  assert.deepStrictEqual(lad[1], ["81", 81, 81]);
  assert.deepStrictEqual(lad[4], ["84-85", 84, 85]); // the 84 gap folds into 84-85
  assert.deepStrictEqual(lad[lad.length - 1], [">=87", 87, null]);
  // contiguous cover: each bucket starts where the previous ended
  for (let i = 1; i < lad.length; i++) assert.strictEqual(lad[i][1], (lad[i - 1][2]) + 1);
});

check("ladderFromBoard refuses a board too thin to be a ladder", () => {
  assert.strictEqual(d.ladderFromBoard([{ thr: 80, yes: 0.5 }]), null);
  assert.strictEqual(d.ladderFromBoard([]), null);
});

check("askMapFromBoard prices every bucket from cumulative diffs, mass ≈ 1", () => {
  const lad = d.ladderFromBoard(BOARD);
  const ask = d.askMapFromBoard(BOARD, lad);
  assert.strictEqual(Object.keys(ask).length, lad.length);
  assert.ok(Math.abs(ask["<=80"] - 0.03) < 1e-9);
  assert.ok(Math.abs(ask["83"] - 0.24) < 1e-9);       // 0.72 - 0.48
  assert.ok(Math.abs(ask["84-85"] - 0.36) < 1e-9);    // 0.48 - 0.12
  assert.ok(Math.abs(ask[">=87"] - 0.04) < 1e-9);
  const total = Object.values(ask).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

check("settleInterval + bucketOutcome: clean flip decides every bucket", () => {
  const iv = d.settleInterval({ maxYes: 84, minNo: 85, clean: true, high: 85 });
  assert.deepStrictEqual(iv, { lo: 85, hi: 85 });
  assert.strictEqual(d.bucketOutcome(iv, 84, 85), 1);
  assert.strictEqual(d.bucketOutcome(iv, 86, null), 0);
  assert.strictEqual(d.bucketOutcome(iv, null, 80), 0);
});

check("bucketOutcome: unclean bounds decide what they can, never guess the rest", () => {
  // flips pin high ∈ [86, 87] (maxYes=85, minNo=87)
  const iv = d.settleInterval({ maxYes: 85, minNo: 87, clean: false });
  assert.strictEqual(d.bucketOutcome(iv, null, 84), 0);   // fully below
  assert.strictEqual(d.bucketOutcome(iv, 86, 88), 1);     // interval inside bucket
  assert.strictEqual(d.bucketOutcome(iv, 87, 88), null);  // straddles — undeterminable
  assert.strictEqual(d.bucketOutcome(iv, 88, null), 0);   // fully above
  // unbounded side stays honest
  const open = d.settleInterval({ maxYes: 85, minNo: null, clean: false });
  assert.strictEqual(d.bucketOutcome(open, null, 84), 0); // high >= 86 > 84
  assert.strictEqual(d.bucketOutcome(open, 90, null), null);
});

check("settledBucketIdx pins only single-bucket intervals", () => {
  const lad = d.ladderFromBoard(BOARD);
  assert.strictEqual(d.settledBucketIdx(lad, { lo: 83, hi: 83 }), 3);
  assert.strictEqual(d.settledBucketIdx(lad, { lo: 84, hi: 85 }), 4);  // both ends in 84-85
  assert.strictEqual(d.settledBucketIdx(lad, { lo: 83, hi: 85 }), -1); // spans buckets
  assert.strictEqual(d.settledBucketIdx(lad, { lo: 85, hi: null }), -1);
});

check("cardPnlCents: both sides, net of the flat fee, null without an outcome", () => {
  assert.strictEqual(d.cardPnlCents("yes", 0.12, 1, 1), 87);   // 100·(1−.12) − 1
  assert.strictEqual(d.cardPnlCents("yes", 0.12, 0, 1), -13);
  assert.strictEqual(d.cardPnlCents("no", 0.36, 0, 1), 35);    // 100·(.36−0) − 1
  assert.strictEqual(d.cardPnlCents("no", 0.36, 1, 1), -65);
  assert.strictEqual(d.cardPnlCents("yes", 0.5, null, 1), null);
});

check("predictDay + gradeDay end-to-end with the real KLGA params (NO_CEILING intact)", () => {
  const { params, hasFittedCeiling } = loadVenueParams();
  assert.strictEqual(hasFittedCeiling, false);
  assert.deepStrictEqual(params.ceilingTable, [[99, 1], [104, 1]]); // non-binding stays non-binding
  const pred = d.predictDay({
    board: BOARD, forecastHigh: 84, lead: 1, month: 7, day: 9,
    params, minEdgeCents: 5, feeCents: makeFlatFee(1),
  });
  assert.ok(pred && pred.ladder.length === 7); // 6 thresholds -> 5 interior buckets + 2 open tails
  assert.ok(pred.dist && Math.abs(Object.values(pred.dist).reduce((s, v) => s + v, 0) - 1) < 1e-6);
  assert.ok(typeof pred.verdict === "string");
  const g = d.gradeDay(pred, { high: 83, clean: true, maxYes: 82, minNo: 83 }, { flatFeeC: 1 });
  assert.strictEqual(g.obsIdx, 3);
  assert.ok(Number.isFinite(g.scores.oracleRPS) && g.scores.oracleRPS >= 0 && g.scores.oracleRPS <= 1);
  assert.ok(Number.isFinite(g.scores.marketRPS));
  assert.ok(Number.isFinite(g.scores.climRPS));
  // every actionable card got an outcome under a clean settle
  for (const c of g.cards) assert.ok(c.outcome === 0 || c.outcome === 1);
});

check("gradeDay refuses proper scores when settlement bounds span buckets", () => {
  const { params } = loadVenueParams();
  const pred = d.predictDay({
    board: BOARD, forecastHigh: 84, lead: 1, month: 7, day: 9,
    params, feeCents: makeFlatFee(1),
  });
  const g = d.gradeDay(pred, { high: null, clean: false, maxYes: 82, minNo: 85 }, { flatFeeC: 1 });
  assert.strictEqual(g.obsIdx, -1);
  assert.strictEqual(g.scores, null);
});

check("verify prefix scoping: UHLGA rows grade under prefix, stay out of the Kalshi default", () => {
  const lad = d.ladderFromBoard(BOARD);
  const dist = {}; lad.forEach(([lbl], i) => { dist[lbl] = i === 3 ? 0.7 : 0.3 / (lad.length - 1); });
  const rows = [
    { event: "open", id: "UHLGA-2026-07-09", ticker: "UHLGA-2026-07-09", ladder: lad, dist, heldBucket: "83" },
    { event: "close", id: "UHLGA-2026-07-09", settledBucket: 3 },
  ];
  assert.strictEqual(verify.gradedRecords(rows).length, 0);                       // default: Kalshi-only
  const graded = verify.gradedRecords(rows, { prefix: "UHLGA" });
  assert.strictEqual(graded.length, 1);
  assert.ok(graded[0].rps < 0.05);
  // the built-in self-test (Kalshi-shaped ledgers) still passes untouched
  assert.strictEqual(verify.selfTest().ok, true);
});

process.exit(failures ? 1 : 0);
