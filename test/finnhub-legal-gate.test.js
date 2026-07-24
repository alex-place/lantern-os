// finnhub-legal-gate.test.js — #1945: Finnhub's free tier prohibits commercial use
// and unisona.ai is monetized, so a bare FINNHUB_API_KEY must NEVER feed a paid
// surface. Finnhub is permitted ONLY when a paid/commercial license (or the
// local-dev flag) is explicitly asserted — presence of a key is not consent.
// Run: node test/finnhub-legal-gate.test.js
"use strict";

const assert = require("assert");
const NewsCollector = require("../lib/news-collector");
const { finnhubAllowed } = NewsCollector;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("DEFAULT (no flags): Finnhub is NOT allowed — a bare key is not commercial consent", () => {
  assert.strictEqual(finnhubAllowed({}), false);
  assert.strictEqual(finnhubAllowed({ FINNHUB_API_KEY: "free-tier-key" }), false, "a key alone must not open the gate");
});

check("FINNHUB_COMMERCIAL_LICENSED=1 opens the gate (operator asserts a PAID plan)", () => {
  assert.strictEqual(finnhubAllowed({ FINNHUB_COMMERCIAL_LICENSED: "1" }), true);
});

check("FINNHUB_DEV_ONLY=1 opens the gate (local dev escape hatch)", () => {
  assert.strictEqual(finnhubAllowed({ FINNHUB_DEV_ONLY: "1" }), true);
});

check("only the exact value '1' opens the gate (no truthy-string bypass)", () => {
  assert.strictEqual(finnhubAllowed({ FINNHUB_COMMERCIAL_LICENSED: "true" }), false);
  assert.strictEqual(finnhubAllowed({ FINNHUB_COMMERCIAL_LICENSED: "0" }), false);
  assert.strictEqual(finnhubAllowed({ FINNHUB_DEV_ONLY: "yes" }), false);
});

check("_collectFromFinnhub is a no-op when no Finnhub client is present (today's default)", async () => {
  // market-data-client.js is absent in the repo → hasFinnhub() is false → 0 records,
  // so no Finnhub data can reach the paid surface regardless of flags.
  const nc = new NewsCollector();
  const n = await nc._collectFromFinnhub();
  assert.strictEqual(n, 0);
});

if (failures) {
  console.error(`\nfinnhub-legal-gate: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nfinnhub-legal-gate: all checks passed");
