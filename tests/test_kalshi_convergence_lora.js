/**
 * Regression test — kalshi-convergence-lora formatMarketForLLM() liquidity_dollars type bug.
 *
 * The Kalshi API returns `liquidity_dollars` as a STRING. formatMarketForLLM did
 * `market.liquidity_dollars?.toFixed(0)` — optional chaining guards null/undefined but NOT a
 * string, so a string value threw "toFixed is not a function" on every market. The loop caught
 * it per-market and produced "Generated 0 training examples / Made 0 convergence predictions",
 * silently disabling ConvergenceLora. Fixed by parseFloat-coercing first (matching
 * kalshi-suggest.js:127's `parseFloat(m.liquidity_dollars)`).
 *
 * Pure unit test — no server, no network. Run: node tests/test_kalshi_convergence_lora.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const { getLora } = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "kalshi-convergence-lora.js"));

const lora = getLora();
const base = {
  title: "Test market",
  ticker: "TEST-1",
  yes_ask: 50,
  no_ask: 50,
  close_time: new Date(Date.now() + 3600000).toISOString(),
};

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  - " + name); passed++; }
  catch (e) { console.log("  FAIL- " + name + ": " + e.message); failed++; }
}

console.log("\nkalshi-convergence-lora formatMarketForLLM — liquidity type safety\n");

check("string liquidity_dollars (the bug) does not throw and is formatted", () => {
  const out = lora.formatMarketForLLM({ ...base, liquidity_dollars: "1234" });
  assert(out.includes("Liquidity: $1234"), "got: " + (out.match(/Liquidity:[^\n]*/) || [])[0]);
});

check("numeric liquidity_dollars still works", () => {
  const out = lora.formatMarketForLLM({ ...base, liquidity_dollars: 9999 });
  assert(out.includes("Liquidity: $9999"));
});

check("missing liquidity_dollars -> 'unknown' (no crash)", () => {
  const out = lora.formatMarketForLLM({ ...base, liquidity_dollars: undefined });
  assert(out.includes("Liquidity: $unknown"));
});

check("non-numeric string liquidity_dollars -> 'unknown'", () => {
  const out = lora.formatMarketForLLM({ ...base, liquidity_dollars: "n/a" });
  assert(out.includes("Liquidity: $unknown"));
});

console.log(`\nkalshi-convergence-lora: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
