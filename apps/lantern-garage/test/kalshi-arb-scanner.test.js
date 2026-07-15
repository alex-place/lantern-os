"use strict";
// P2-3: unit tests for the fee-aware cross-contract arbitrage scanner. Fully offline.
// Run: node apps/lantern-garage/test/kalshi-arb-scanner.test.js
const assert = require("assert");
const arb = require("../lib/kalshi-arb-scanner");
const { takerFeeCents } = require("../lib/kalshi-fees");

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

const mk = (ticker, yesAsk, noAsk) => ({ ticker, yes_ask: yesAsk, no_ask: noAsk });

// ── exhaustive-partition arb ──────────────────────────────────────────────────
check("partition: refuses to assume a partition unless asserted exhaustive", () => {
  const r = arb.partitionArb([mk("A", 30), mk("B", 30)], { exhaustive: false });
  assert.strictEqual(r.arb, false);
  assert.match(r.reason, /exhaustive/);
});

check("partition: YES asks summing to 90¢ over 3 buckets IS an arb after fees", () => {
  // Three MECE buckets at 30/30/30 = 90¢. One pays 100¢. Fees ~1¢ each.
  const buckets = [mk("A", 30), mk("B", 30), mk("C", 30)];
  const r = arb.partitionArb(buckets, { exhaustive: true });
  const expectedFee = takerFeeCents(30) * 3;
  assert.strictEqual(r.grossCostCents, 90);
  assert.strictEqual(r.feeCents, expectedFee);
  assert.strictEqual(r.netProfitCents, 100 - 90 - expectedFee);
  assert.strictEqual(r.arb, true);
  assert.ok(r.roi > 0);
});

check("partition: a book summing to 99¢ is NOT an arb once fees are charged", () => {
  // 33+33+33 = 99¢ gross (1¢ gross edge) but fees > 1¢ → net negative.
  const r = arb.partitionArb([mk("A", 33), mk("B", 33), mk("C", 33)], { exhaustive: true });
  assert.strictEqual(r.grossCostCents, 99);
  assert.ok(r.feeCents >= 1);
  assert.strictEqual(r.arb, false, "fees must erase the 1¢ gross edge");
  assert.ok(r.netProfitCents < 0);
});

check("partition: fully-priced book (sums to 100¢) is never an arb", () => {
  const r = arb.partitionArb([mk("A", 50), mk("B", 50)], { exhaustive: true });
  assert.strictEqual(r.arb, false);
});

check("partition: an empty-book leg makes the group un-actionable (no fabricated fill)", () => {
  const r = arb.partitionArb([mk("A", 30), { ticker: "B" }], { exhaustive: true });
  assert.strictEqual(r.arb, false);
  assert.match(r.reason, /no yes ask/);
});

check("partition: scales with contract count (2× legs, 2× profit)", () => {
  const buckets = [mk("A", 30), mk("B", 30), mk("C", 30)];
  const one = arb.partitionArb(buckets, { exhaustive: true, contracts: 1 });
  const two = arb.partitionArb(buckets, { exhaustive: true, contracts: 2 });
  assert.strictEqual(two.payoutCents, one.payoutCents * 2);
  assert.strictEqual(two.grossCostCents, one.grossCostCents * 2);
});

// ── complementary-pair arb ────────────────────────────────────────────────────
check("complementary: YES(A) 40 + NO(B) 45 = 85¢ IS an arb after fees", () => {
  const a = mk("A", 40, 62);
  const b = mk("B", 58, 45);
  const r = arb.complementaryArb(a, b);
  assert.strictEqual(r.grossCostCents, 85);
  assert.strictEqual(r.arb, true);
  assert.strictEqual(r.netProfitCents, 100 - 85 - (takerFeeCents(40) + takerFeeCents(45)));
});

check("complementary: 50 + 50 is not an arb (fully priced)", () => {
  const r = arb.complementaryArb(mk("A", 50, 50), mk("B", 50, 50));
  assert.strictEqual(r.arb, false);
});

check("complementary: dollar-denominated asks are honored", () => {
  const a = { ticker: "A", yes_ask_dollars: 0.40 };
  const b = { ticker: "B", no_ask_dollars: 0.45 };
  const r = arb.complementaryArb(a, b);
  assert.strictEqual(r.grossCostCents, 85);
  assert.strictEqual(r.arb, true);
});

// ── scan aggregation ──────────────────────────────────────────────────────────
check("scan: returns only real arbs, best ROI first", () => {
  const cheap = [mk("A", 20), mk("B", 20), mk("C", 20)];      // 60¢ → fat arb
  const thin  = [mk("D", 31), mk("E", 31), mk("F", 31)];      // 93¢ → thin/none after fees
  const priced = [mk("G", 50), mk("H", 50)];                   // no arb
  const res = arb.scan({ partitions: [
    { markets: cheap }, { markets: thin }, { markets: priced },
  ] });
  assert.ok(res.count >= 1);
  // Sorted by roi descending — the 60¢ book must lead.
  assert.deepStrictEqual(res.opportunities[0].tickers, ["A", "B", "C"]);
  for (let i = 1; i < res.opportunities.length; i++) {
    assert.ok(res.opportunities[i - 1].roi >= res.opportunities[i].roi);
  }
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-arb-scanner tests passed.");
