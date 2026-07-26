"use strict";
// Probe safety contract (#2954/#2956): the filter only admits the studied band, and the
// kalshi-api defense clause blocks every off-contract order that carries the probe label —
// even with all env gates hypothetically open. Zero network.
const assert = require("assert");
const path = require("path");
const { probeFilter, BAND } = require(path.join(__dirname, "..", "..", "..", "experiments", "kalshi_longshot_probe.js"));

const NOW = Date.parse("2026-07-25T12:00:00Z");
const base = { ticker: "KXTEST-26JUL30-T5", eventTicker: "KXTEST-26JUL30", yesAskCents: 5,
               yesBidCents: 3, volume: 100, closeTime: "2026-07-27T12:00:00Z" };

function run(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { console.error("FAIL -", name, e.message); process.exitCode = 1; } }

run("admits an in-band, liquid, mid-horizon market", () => {
  assert.strictEqual(probeFilter({ ...base }, NOW).ok, true);
});
run("rejects outside the 1-15c band (both sides)", () => {
  assert.strictEqual(probeFilter({ ...base, yesAskCents: 0 }, NOW).ok, false);
  assert.strictEqual(probeFilter({ ...base, yesAskCents: 16 }, NOW).ok, false);
  assert.strictEqual(probeFilter({ ...base, yesAskCents: 50 }, NOW).ok, false);
});
run("rejects crypto-family tickers (fee multiplier)", () => {
  assert.strictEqual(probeFilter({ ...base, ticker: "KXBTCD-26JUL26-T5" }, NOW).ok, false);
});
run("rejects parlays (KXMVE*) — the 2026-07-25 dry-run finding", () => {
  // Dry run: 100% of in-band open markets were KXMVE* parlays (wrong population vs CEPR
  // DP20631 single-event contracts; correlated legs, venue-priced margin). Must never probe.
  assert.strictEqual(probeFilter({ ...base, ticker: "KXMVESPORTSMULTIGAMEEXTENDED-S1-A" }, NOW).ok, false);
  assert.strictEqual(probeFilter({ ...base, ticker: "KXMVECROSSCATEGORY-S1-B" }, NOW).ok, false);
  assert.strictEqual(probeFilter({ ...base, eventTicker: "KXMVECROSSCATEGORY-S1" }, NOW).ok, false);
});
run("rejects <2h and >7d horizons", () => {
  assert.strictEqual(probeFilter({ ...base, closeTime: "2026-07-25T13:00:00Z" }, NOW).ok, false);
  assert.strictEqual(probeFilter({ ...base, closeTime: "2026-08-15T12:00:00Z" }, NOW).ok, false);
});
run("one probe per event", () => {
  const seen = new Set(["KXTEST-26JUL30"]);
  assert.strictEqual(probeFilter({ ...base }, NOW, seen).ok, false);
});
run("rejects zero-volume books", () => {
  assert.strictEqual(probeFilter({ ...base, volume: 0 }, NOW).ok, false);
});

// The money-side contract: every off-spec order with the probe label must be BLOCKED by
// kalshi-api even before env gates are consulted (blockers accumulate; probe violation present).
const apiSrc = require("fs").readFileSync(path.join(__dirname, "..", "lib", "kalshi-api.js"), "utf8");
run("kalshi-api carries the probe defense clause", () => {
  assert.ok(apiSrc.includes("kalshi-longshot-probe"), "probe source clause missing");
  assert.ok(apiSrc.includes("probe_contract_violation"), "violation blocker missing");
  assert.ok(/lc < 85 \|\| lc > 99/.test(apiSrc), "85-99c NO-limit bound missing");
});

console.log("done");
