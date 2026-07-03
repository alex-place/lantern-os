// NBS MOS forecast source for the weather-edge deck (#1871). Pure parsing + latest-run
// collapse; the forecast-high definition here IS the one the oracle constants were fit against.
// Run: node apps/lantern-garage/test/kalshi-mos.test.js
const assert = require("assert");
const { parseCsv, mosForecastHighs, latestForecastHighs } = require("../lib/kalshi-mos");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("mosForecastHighs takes the max hourly tmp over the local day", () => {
  const csv = [
    "runtime,ftime,model,tmp,station",
    "2025-07-01 07:00:00,2025-07-01 18:00:00,NBS,88,KNYC",
    "2025-07-01 07:00:00,2025-07-01 21:00:00,NBS,91,KNYC",  // 17:00 EDT — daily high
    "2025-07-01 07:00:00,2025-07-02 00:00:00,NBS,90,KNYC",  // 20:00 EDT 7-1
  ].join("\n");
  const run = [...mosForecastHighs(parseCsv(csv)).values()][0];
  const jul1 = [...run.days.values()].find((d) => d.tgt.m === 7 && d.tgt.day === 1);
  assert.strictEqual(jul1.high, 91);
});

check("latestForecastHighs picks the most recent run per target day, deck-shaped", () => {
  const csv = [
    "runtime,ftime,model,tmp,station",
    "2025-06-30 07:00:00,2025-07-02 18:00:00,NBS,95,KNYC",  // older run, target 7-2
    "2025-07-01 07:00:00,2025-07-02 18:00:00,NBS,99,KNYC",  // newer run, same target
  ].join("\n");
  const out = latestForecastHighs(mosForecastHighs(parseCsv(csv)));
  assert.ok(out["7-2"], "should have a 7-2 entry");
  assert.strictEqual(out["7-2"].high, 99, "must use the newer run");
  assert.strictEqual(out["7-2"].ymd, "2025-07-02");
  assert.strictEqual(out["7-2"].month, 7);
  assert.strictEqual(out["7-2"].day, 2);
});

check("empty / unparseable input yields no forecasts (deck stands down)", () => {
  assert.deepStrictEqual(latestForecastHighs(mosForecastHighs(parseCsv(""))), {});
  assert.deepStrictEqual(latestForecastHighs(mosForecastHighs(parseCsv("runtime,ftime,tmp\n"))), {});
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kalshi-mos tests passed.");
