// Multi-city weather-oracle parameterization (#2220). The oracle must read a city's
// normals/ceiling as DATA, keep NYC byte-identical, and only certify NYC for trading.
// Run: node apps/lantern-garage/test/kalshi-weather-cities.test.js
const assert = require("assert");
const m = require("../lib/kalshi-weather-edge");
const cities = require("../lib/kalshi-weather-cities");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const LADDER = [["A", null, 91], ["B", 92, 93], ["C", 94, 95], ["D", 96, 97], ["E", 98, 99], ["F", 100, null]];

check("registry: NYC is the only certified city; others present but gated", () => {
  assert.deepStrictEqual(cities.certifiedCities().map((c) => c.series), ["KXHIGHNY"]);
  assert.strictEqual(cities.isCertified("KXHIGHNY"), true);
  assert.strictEqual(cities.isCertified("KXHIGHDEN"), false);
  assert.ok(cities.CITIES.length >= 5, "several cities registered as fit targets");
});

check("lookup works by series and by station", () => {
  assert.strictEqual(cities.getCity("KXHIGHNY").station, "KNYC");
  assert.strictEqual(cities.getCity("KNYC").series, "KXHIGHNY");
  assert.strictEqual(cities.getCity("nope"), null);
});

check("NYC via paramsForCity is byte-identical to the default (no regression)", () => {
  const Pnyc = m.paramsForCity(cities.getCity("KXHIGHNY"));
  const dDefault = m.calibratedDistribution(96, 1, LADDER, 7, 1);
  const dNyc = m.calibratedDistribution(96, 1, LADDER, 7, 1, Pnyc);
  assert.strictEqual(JSON.stringify(dDefault), JSON.stringify(dNyc));
  assert.strictEqual(m.normalHigh(7, 1, Pnyc), 83.8); // NCEI daily normal
});

check("a city with no normals falls back to its OWN defaultNormal, not NYC's table", () => {
  const Pden = m.paramsForCity(cities.getCity("KXHIGHDEN")); // normals: null, defaultNormal: 88
  assert.strictEqual(m.normalHigh(7, 1, Pden), 88, "must use Denver's fallback, not NYC 83.8");
  const Pnyc = m.paramsForCity(cities.getCity("KXHIGHNY"));
  assert.strictEqual(m.normalHigh(8, 15, Pnyc), 84, "NYC off-table day → NYC defaultNormal 84");
});

check("paramsForCity(null) is a pass-through (default oracle behavior)", () => {
  const d = m.calibratedDistribution(96, 1, LADDER, 7, 1, m.paramsForCity(null));
  const dDefault = m.calibratedDistribution(96, 1, LADDER, 7, 1);
  assert.strictEqual(JSON.stringify(d), JSON.stringify(dDefault));
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll kalshi-weather-cities tests passed.");
