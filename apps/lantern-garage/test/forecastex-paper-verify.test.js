// Nightly forward paper-verification (#2217) — injected legs, no network, temp ledger.
// The invariants under test: predictions open ONLY for strictly-future dates, opens/closes
// are idempotent, grading uses the venue's own settlement flips, and the certification
// gate stays false without n>=20 evidence. Run:
//   node apps/lantern-garage/test/forecastex-paper-verify.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pv = require("../lib/forecastex-paper-verify");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const run = (name, fn) => fn().then(() => console.log("  ok  -", name))
  .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fx-paper-"));
const FILES = {
  ledger: path.join(tmp, "paper.jsonl"),
  state: path.join(tmp, "state.json"),
  summary: path.join(tmp, "summary.json"),
};
const readLedger = () => fs.readFileSync(FILES.ledger, "utf8").trim().split("\n").map(JSON.parse);

// ── fixture legs ──────────────────────────────────────────────────────────────
// "now" = 2026-07-10 21:30 ET = 2026-07-11T01:30Z (job runs after the 21:00 ET gate).
const NOW = new Date("2026-07-11T01:30:00Z");

// Venue CSV rows, already parsed (fetchDailyCsv shape): file for 2026-07-10 carries
// tomorrow's (07-11) board + the settlement flips for 07-09.
const csvRow = (id, end, settle) => ({ event_contract: id, subtype: "YES", end_price: end, settlement_price: settle });
const FILE_0710 = [
  // 07-11 day-ahead board (EOD closes on 07-10)
  csvRow("UHLGA_071126_82", "0.95", ""),
  csvRow("UHLGA_071126_83", "0.80", ""),
  csvRow("UHLGA_071126_84", "0.55", ""),
  csvRow("UHLGA_071126_85", "0.25", ""),
  csvRow("UHLGA_071126_86", "0.08", ""),
  // 07-09 settled clean at 85 (YES to 84, NO from 85)
  csvRow("UHLGA_070926_84", "0.99", "1.00"),
  csvRow("UHLGA_070926_85", "0.01", "0.00"),
];
const fetchCsv = async (type, ymd) => (ymd === "20260710" ? FILE_0710 : null);

// MOS leg: tomorrow's forecast from tonight's run (lead 1), kalshi-mos byDate shape.
const getMos = async () => ({
  "7-11": { high: 86, month: 7, day: 11, ymd: "2026-07-11", shortForecast: "NBS MOS", runtime: "2026-7-10" },
});

(async () => {
  // Seed one already-open prediction for 07-09 so the settlement in FILE_0710 can close it.
  // (Stamped shape = exactly what a real open writes.)
  const seedLadder = [["<=83", null, 83], ["84", 84, 84], ["85", 85, 85], [">=86", 86, null]];
  fs.mkdirSync(tmp, { recursive: true });
  fs.appendFileSync(FILES.ledger, JSON.stringify({
    event: "open", id: "UHLGA-2026-07-09", ticker: "UHLGA-2026-07-09", date: "2026-07-09",
    boardDate: "2026-07-08", forecastHigh: 85, lead: 1,
    ladder: seedLadder,
    dist: { "<=83": 0.2, "84": 0.3, "85": 0.3, ">=86": 0.2 },
    ask: { "<=83": 0.15, "84": 0.30, "85": 0.35, ">=86": 0.20 },
    actionable: [{ bucket: "85", side: "yes", ask_c: 35, worst_c: 6, fair: 0.55 }],
    heldBucket: "85", feeCentsFlat: 1, minEdgeCents: 5,
  }) + "\n");

  let res;
  await run("runOnce opens tomorrow only, closes the settled day, writes the summary", async () => {
    res = await pv.runOnce({ now: NOW, fetchCsv, getMos, files: FILES });
    assert.deepStrictEqual(res.opened, ["2026-07-11"]);   // strictly future only
    assert.deepStrictEqual(res.closed, ["2026-07-09"]);
    const rows = readLedger();
    const open = rows.find((r) => r.event === "open" && r.date === "2026-07-11");
    assert.ok(open, "open row for 2026-07-11 missing");
    assert.strictEqual(open.forecastHigh, 86);
    assert.strictEqual(open.lead, 1);                      // runtime 07-10 -> target 07-11
    assert.strictEqual(open.hasFittedCeiling, false);      // NO_CEILING venue contract
    assert.ok(open.ladder.length >= 5 && open.dist && open.ask);
    const close = rows.find((r) => r.event === "close" && r.date === "2026-07-09");
    assert.ok(close, "close row for 2026-07-09 missing");
    assert.strictEqual(close.settledHigh, 85);
    assert.strictEqual(close.clean, true);
    assert.strictEqual(close.settledBucket, 2);
    // the seeded YES-85 card at .35 settles in-bucket: 100·(1−.35) − 1 = 64¢
    assert.strictEqual(close.cards[0].pnl_c, 64);
    assert.ok(fs.existsSync(FILES.summary));
  });

  await run("runOnce is idempotent — a second pass appends nothing", async () => {
    const before = readLedger().length;
    const res2 = await pv.runOnce({ now: NOW, fetchCsv, getMos, files: FILES });
    assert.deepStrictEqual(res2.opened, []);
    assert.deepStrictEqual(res2.closed, []);
    assert.strictEqual(readLedger().length, before);
  });

  await run("no MOS forecast -> no open (skip is recorded, never fabricated)", async () => {
    const files2 = { ...FILES, ledger: path.join(tmp, "l2.jsonl"), summary: path.join(tmp, "s2.json") };
    const r = await pv.runOnce({ now: NOW, fetchCsv, getMos: async () => ({}), files: files2 });
    assert.deepStrictEqual(r.opened, []);
    assert.ok(r.skipped.some((s) => /no MOS forecast/.test(s)));
  });

  check("certification gate: n<20 stays uncertified even when P&L is positive", () => {
    const s = res.summary;
    assert.strictEqual(s.settledDays >= 1, true);
    assert.ok(s.edges.netPnlCents > 0);                    // the seeded card won 64¢…
    assert.strictEqual(s.certifiedEdge, false);            // …but n=1 << 20: stays false
    assert.strictEqual(s.distribution.active, false);      // verdict withheld under MIN_SAMPLES
  });

  check("certification gate ignores degenerate 0/1 closes (liquidity-artifact proof)", () => {
    // 40 settled days of a card faded at a degenerate 1.00 close that settles 0: +99¢ each,
    // net hugely positive, n>=20 days AND n>=20 cards — yet NONE are fillable, so no cert.
    const files3 = { ledger: path.join(tmp, "l3.jsonl"), state: path.join(tmp, "st3.json"), summary: path.join(tmp, "s3.json") };
    const lad = [["<=83", null, 83], ["84", 84, 84], [">=85", 85, null]];
    for (let i = 0; i < 40; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      fs.appendFileSync(files3.ledger, JSON.stringify({ event: "open", id: `UHLGA-${day}`, ticker: `UHLGA-${day}`, date: day,
        ladder: lad, dist: { "<=83": 0.34, "84": 0.33, ">=85": 0.33 }, ask: { "<=83": 1.0, "84": 0.5, ">=85": 0.0 }, heldBucket: "<=83" }) + "\n");
      fs.appendFileSync(files3.ledger, JSON.stringify({ event: "close", id: `UHLGA-${day}`, date: day, settledHigh: 88, clean: true, maxYes: 87, minNo: 88, settledBucket: 2,
        cards: [{ bucket: "<=83", side: "no", ask: 1.0, tradeable: false, outcome: 0, pnl_c: 99 }] }) + "\n");
    }
    const rows3 = fs.readFileSync(files3.ledger, "utf8").trim().split("\n").map(JSON.parse);
    const s = pv.buildSummary(rows3);
    assert.strictEqual(s.settledDays, 40);
    assert.ok(s.edges.netPnlCents > 3000);          // raw P&L looks great…
    assert.strictEqual(s.edges.tradeableCards, 0);  // …but every card is non-fillable
    assert.strictEqual(s.certifiedEdge, false);     // so certification stays FALSE
  });

  await run("scheduler tick is a no-op before the evening run hour", async () => {
    const early = new Date("2026-07-10T12:00:00Z"); // 08:00 ET < 21:00 ET gate
    const r = await pv._tick({ now: early, files: FILES });
    assert.strictEqual(r, null);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
