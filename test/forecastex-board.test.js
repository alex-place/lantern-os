// ForecastEx public-CSV board reader (#2217). Pure parsing only — no network in tests.
// Conventions under test are MEASURED facts (docs/research/2026-07-10-forecastex-uhlga-*):
// exceed = strictly greater; settled high = clean-flip minNo; range prob = cumulative diff.
// Run: node test/forecastex-board.test.js
const assert = require("assert");
const b = require("../lib/forecastex-board");
const { alignBuckets, findDivergences } = require("../lib/cross-venue-monitor");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Mini prices-CSV fixture in the venue's real column shape (one settled day + one open day).
const CSV_HEAD = "event_contract,subtype,expiration_date,date,start_price,high_price,low_price,end_price,settlement_price,pair_quantity,open_interest,vwap";
const row = (id, sub, end, settle) => `${id},${sub},2026-06-17T00:00:00-05:00,2026-06-16,0.10,0.20,0.05,${end},${settle},100,0,0.12`;
const FIXTURE = [
  CSV_HEAD,
  // settled contract date 2026-06-16: highs settled YES up to 77, NO from 78 (clean flip -> 78)
  row("UHLGA_061626_76", "YES", "0.98", "1.00"),
  row("UHLGA_061626_76", "NO", "0.02", "0.00"),
  row("UHLGA_061626_77", "YES", "0.55", "1.00"),
  row("UHLGA_061626_78", "YES", "0.30", "0.00"),
  row("UHLGA_061626_79", "YES", "0.05", "0.00"),
  // open contract date 2026-06-17: EOD closes only, no settlement yet
  row("UHLGA_061726_79", "YES", "0.90", ""),
  row("UHLGA_061726_80", "YES", "0.60", ""),
  row("UHLGA_061726_81", "YES", "0.25", ""),
  row("UHLGA_061726_82", "YES", "0.10", ""),
  // unclean settlement (gap in the ladder): YES 1.00 at 70, NO at 74 — cannot pin the high
  row("UHLGA_061526_70", "YES", "0.99", "1.00"),
  row("UHLGA_061526_74", "YES", "0.01", "0.00"),
  // another product must be ignored
  row("UHMDW_061626_85", "YES", "0.40", "1.00"),
].join("\n");

const { parseCsv } = require("../lib/kalshi-mos");
const ROWS = parseCsv(FIXTURE);

check("parseContractId decodes product/date/threshold and rejects junk", () => {
  assert.deepStrictEqual(b.parseContractId("UHLGA_061626_78"), { product: "UHLGA", date: "2026-06-16", thr: 78 });
  assert.strictEqual(b.parseContractId("FFDEC_20260616"), null);
  assert.strictEqual(b.parseContractId(""), null);
});

check("settledHighs: clean flip pins the settled high at minNo (exceed-strict)", () => {
  const m = b.settledHighs(ROWS, "UHLGA");
  const d = m.get("2026-06-16");
  assert.ok(d && d.clean, "clean flip expected");
  assert.strictEqual(d.high, 78);
  assert.strictEqual(d.maxYes, 77);
});

check("settledHighs: ladder gap -> clean=false, high=null, bounds reported (never guess)", () => {
  const d = b.settledHighs(ROWS, "UHLGA").get("2026-06-15");
  assert.ok(d && !d.clean);
  assert.strictEqual(d.high, null);
  assert.strictEqual(d.maxYes, 70);
  assert.strictEqual(d.minNo, 74);
});

check("thresholdBoard returns the sorted EOD cumulative curve for one contract date", () => {
  const board = b.thresholdBoard(ROWS, "UHLGA", "2026-06-17");
  assert.deepStrictEqual(board.map((x) => x.thr), [79, 80, 81, 82]);
  assert.strictEqual(board[1].yes, 0.6);
});

check("rangeYes: P(lo<=H<=hi) = P(>lo-1) - P(>hi); open tails; null when unpriceable", () => {
  const board = b.thresholdBoard(ROWS, "UHLGA", "2026-06-17");
  assert.ok(Math.abs(b.rangeYes(board, 81, 82) - (0.60 - 0.10)) < 1e-9);   // P(>80) - P(>82)
  assert.ok(Math.abs(b.rangeYes(board, 81, null) - 0.60) < 1e-9);          // >=81 -> P(>80)
});

check("rangeYes open-low tail uses P(>hi) correctly", () => {
  const board = b.thresholdBoard(ROWS, "UHLGA", "2026-06-17");
  assert.ok(Math.abs(b.rangeYes(board, null, 80) - (1 - 0.60)) < 1e-9);
  assert.strictEqual(b.rangeYes(board, 60, 61), null); // thresholds absent -> no fabricated price
});

check("contractDates lists product dates ascending", () => {
  assert.deepStrictEqual(b.contractDates(ROWS, "UHLGA"), ["2026-06-15", "2026-06-16", "2026-06-17"]);
});

check("toRangeBuckets feeds cross-venue-monitor.alignBuckets end-to-end", () => {
  const board = b.thresholdBoard(ROWS, "UHLGA", "2026-06-17");
  const ladder = [["79-80", 79, 80], ["81-82", 81, 82], [">=83", 83, null]];
  const fexBuckets = b.toRangeBuckets(board, ladder, "UHLGA_061726");
  // Kalshi board priced 5c higher on 81-82 than ForecastEx implies
  const kalshi = [{ lo: 81, hi: 82, label: "81-82", yes: 0.25, venueTicker: "KXHIGHNY-B81.5" }];
  const aligned = alignBuckets(kalshi, fexBuckets);
  assert.strictEqual(aligned.aligned.length, 1);
  const flags = findDivergences(aligned, { minNetCents: 1 });
  assert.ok(Array.isArray(flags)); // fee-covered or not, the pipe composes without throwing
});

check("fetchDailyCsv is fail-soft on a dead host (never throws)", async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error("boom"); };
  try {
    const r = await b.fetchDailyCsv("prices", "20260616", { timeoutMs: 10 });
    assert.strictEqual(r, null);
  } finally { global.fetch = orig; }
});

setTimeout(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log("\nAll forecastex-board tests passed.");
}, 50);
