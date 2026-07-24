// Cross-venue divergence monitor (#2221), read-only. Buckets align by °F range across
// venues; a gap beyond combined fees is flagged as a near-neutral arb candidate.
// Run: node test/cross-venue-monitor.test.js
const assert = require("assert");
const { alignBuckets, findDivergences, crossVenueReport } = require("../lib/cross-venue-monitor");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Same temperature ranges, different venue tickers/labels — must still align.
const kalshi = [
  { lo: null, hi: 95, label: "<=95", yes: 0.20, venueTicker: "KXHIGHNY-A" },
  { lo: 96, hi: 97, label: "96-97", yes: 0.40, venueTicker: "KXHIGHNY-B" },
  { lo: 98, hi: 99, label: "98-99", yes: 0.30, venueTicker: "KXHIGHNY-C" },
  { lo: 100, hi: null, label: ">=100", yes: 0.05, venueTicker: "KXHIGHNY-D" },
];
const forecastex = [
  { lo: null, hi: 95, label: "LE95", yes: 0.205, venueTicker: "FEX-1" },  // ~agree
  { lo: 96, hi: 97, label: "96_97", yes: 0.34, venueTicker: "FEX-2" },    // 6c gap
  { lo: 98, hi: 99, label: "98_99", yes: 0.305, venueTicker: "FEX-3" },   // ~agree
  { lo: 101, hi: null, label: "GE101", yes: 0.04, venueTicker: "FEX-4" }, // range mismatch → unaligned
];

check("aligns buckets by °F range, not label/ticker", () => {
  const a = alignBuckets(kalshi, forecastex);
  assert.strictEqual(a.aligned.length, 3);                 // <=95, 96-97, 98-99
  assert.deepStrictEqual(a.kalshiOnly, ["100..+inf"]);     // >=100 has no FEX match
  assert.deepStrictEqual(a.forecastexOnly, ["101..+inf"]); // GE101 has no Kalshi match
});

check("flags only the divergence that clears combined fees", () => {
  const flags = findDivergences(alignBuckets(kalshi, forecastex));
  assert.strictEqual(flags.length, 1);
  const f = flags[0];
  assert.strictEqual(f.range, "96..97");
  assert.ok(f.gapCents >= 5.9 && f.gapCents <= 6.1, `gap ${f.gapCents}`);
  assert.ok(f.netCents > 0, "net positive after fees");
  assert.strictEqual(f.buy, "forecastex-YES");   // FEX cheaper (0.34 < 0.40)
  assert.strictEqual(f.sell, "kalshi-YES");
});

check("agreeing books produce no flags (efficient case)", () => {
  const rep = crossVenueReport(
    kalshi,
    kalshi.map((b) => ({ ...b, yes: b.yes + 0.005 })), // within a fee of each other
  );
  assert.strictEqual(rep.divergences.length, 0);
  assert.match(rep.note, /books agree/);
});

check("report is read-only and never emits order code", () => {
  const rep = crossVenueReport(kalshi, forecastex);
  assert.strictEqual(rep.mode, "read-only");
  assert.match(rep.note, /read-only/i);
  assert.ok(!("order" in rep) && !("place" in rep));
});

check("empty / missing boards are safe", () => {
  assert.strictEqual(alignBuckets([], []).aligned.length, 0);
  assert.strictEqual(crossVenueReport(undefined, undefined).alignedBuckets, 0);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll cross-venue-monitor tests passed.");
