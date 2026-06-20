"use strict";
/**
 * test_kalshi_suggest_emit.js — verifies kalshi-suggest emits a ConvergenceRecord
 * per tradeable entry suggestion (Reason → Act). Stubs all I/O dependencies via
 * the require cache so nothing hits the network or the real records.jsonl.
 *
 * Run: node tests/test_kalshi_suggest_emit.js
 */

const path = require("path");
const assert = require("assert");

const LIB = path.resolve(__dirname, "..", "apps", "lantern-garage", "lib");
const R = (name) => require.resolve(path.join(LIB, name));

// ── capture emitted records ──────────────────────────────────────────────────
const emitted = [];

function stub(name, exports) {
  require.cache[R(name)] = { id: R(name), filename: R(name), loaded: true, exports };
}

// Stub convergence-records: record the args instead of writing JSONL.
stub("convergence-records.js", {
  async emitConvergenceRecord(rec) { emitted.push(rec); return rec; },
  RECORDS_PATH: "(stub)",
  RECORDS_REL: "(stub)",
});

// Stub kalshi-api: no positions, no network market fetch needed (collector path).
stub("kalshi-api.js", {
  async getPositions() { return { data: { market_positions: [] } }; },
  async getMarkets() { return { data: { markets: [] } }; },
});

// Stub winrate tracker: category passes the >45% filter.
stub("kalshi-winrate-tracker.js", {
  getWinRate: () => 90,
  getCategory: () => "crypto",
  getCategoryStats: () => ({}),
});

// Stub adaptive exits: never exit (so we exercise the entry/emit path).
stub("kalshi-adaptive-exits.js", {
  evaluateExit: () => ({ shouldExit: false }),
  getMarketState: () => ({}),
  scoreHold: () => 0,
});

// ── fixture market crafted to pass isEntryTradeable ──────────────────────────
// Tight 0¢ spread, single-outcome binary, strong upward tick → high conviction,
// fair-value bounded (yes_ask ≈ no_ask), closes soon (urgency).
const closeSoon = new Date(Date.now() + 30 * 60000).toISOString();
const market = {
  ticker: "KXBTCTEST",
  title: "BTC above 100k at noon",
  strike_type: "greater",
  yes_ask: 50, yes_bid: 50,
  no_ask: 50, no_bid: 50,
  previous_yes_ask_dollars: "0.47",   // prev 47¢ → tick = +3¢ momentum
  liquidity_dollars: "100000",
  close_time: closeSoon,
  yes_sub_title: "YES", no_sub_title: "NO",
};

const collector = { getLatestMarkets: () => [market] };

(async () => {
  const { getSuggestions } = require(path.join(LIB, "kalshi-suggest.js"));
  const out = await getSuggestions({ collector, exitsOnly: false });

  assert.strictEqual(out.entryCount, 1, `expected 1 entry, got ${out.entryCount}`);
  assert.strictEqual(emitted.length, 1, `expected 1 ConvergenceRecord emitted, got ${emitted.length}`);

  const rec = emitted[0];
  assert.strictEqual(rec.reasoner, "kalshi-suggest", "reasoner should be kalshi-suggest");
  assert.ok(rec.hypothesis.includes("KXBTCTEST"), "hypothesis should name the contract");
  assert.deepStrictEqual(rec.evidence_ids, ["KXBTCTEST"], "evidence_ids should carry the ticker");
  assert.ok(typeof rec.result === "string" && rec.result.length > 0, "result should summarize the entry");
  assert.ok(rec.confidence > 0 && rec.confidence <= 1, `confidence should be normalized 0..1, got ${rec.confidence}`);

  console.log("PASS — kalshi-suggest emits ConvergenceRecord:", JSON.stringify(rec));
})().catch((err) => {
  console.error("FAIL —", err && err.stack || err);
  process.exit(1);
});
