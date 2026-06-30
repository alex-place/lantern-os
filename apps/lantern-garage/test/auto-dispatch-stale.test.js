// Σ₀ sustained-work wedge recovery (lib/auto-dispatch.js §R3).
//
// inFlight is an in-memory serialize lock. The 20-min dispatch budget is a SOCKET-
// INACTIVITY timeout, not a wall clock: a slow-but-active autonomous-work stream can
// outlast it without ever settling, pinning inFlight=true and blocking every future
// tick for the rest of the process lifetime. A hard wall-clock ceiling (staleMs) lets
// the next tick force-release the lock. These checks pin the predicate + the ceiling.
//
// Run: node apps/lantern-garage/test/auto-dispatch-stale.test.js
const assert = require("assert");
const ad = require("../lib/auto-dispatch");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("inFlightStale: false when nothing is in flight", () => {
  ad._setInFlight(false);
  assert.strictEqual(ad._inFlight(), false);
  assert.strictEqual(ad.inFlightStale(), false);
});

check("inFlightStale: false for a fresh in-flight run", () => {
  ad._setInFlight(true, 0); // lock taken just now
  assert.strictEqual(ad._inFlight(), true);
  assert.strictEqual(ad.inFlightStale(), false);
});

check("inFlightStale: true once the lock is held past the wall-clock ceiling", () => {
  ad._setInFlight(true, ad.staleMs() + 60000); // one minute past the ceiling
  assert.strictEqual(ad.inFlightStale(), true);
  ad._setInFlight(false); // reset for cleanliness
});

check("staleMs: default 40 min, env-tunable, floored at 60s", () => {
  const prev = process.env.AUTO_DISPATCH_STALE_MS;
  try {
    delete process.env.AUTO_DISPATCH_STALE_MS;
    assert.strictEqual(ad.staleMs(), 40 * 60 * 1000);
    process.env.AUTO_DISPATCH_STALE_MS = "90000";
    assert.strictEqual(ad.staleMs(), 90000);
    process.env.AUTO_DISPATCH_STALE_MS = "1000"; // below the 60s floor → falls back to default
    assert.strictEqual(ad.staleMs(), 40 * 60 * 1000);
  } finally {
    if (prev === undefined) delete process.env.AUTO_DISPATCH_STALE_MS;
    else process.env.AUTO_DISPATCH_STALE_MS = prev;
  }
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall auto-dispatch wedge-recovery checks passed");
