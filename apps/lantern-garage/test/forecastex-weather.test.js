// ForecastEx weather-venue registry (#2217): certification gate + honest params loading.
// The load-bearing property: the KNYC ceiling table can NEVER leak onto the LGA station —
// a fabricated ≥100 fade is exactly the Σ₀ violation this module exists to prevent.
// Run: node apps/lantern-garage/test/forecastex-weather.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fx = require("../lib/forecastex-weather");
const oracle = require("../lib/kalshi-weather-edge");
const m = require("../lib/kalshi-weather-edge");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("venue entry pins the measured anchors and is NOT certified", () => {
  assert.strictEqual(fx.NYC_LGA.certified, false);
  assert.strictEqual(fx.NYC_LGA.product, "UHLGA");
  assert.strictEqual(fx.NYC_LGA.station, "KLGA");
  assert.strictEqual(fx.NYC_LGA.venue, "FORECASTEX");
  assert.ok(fx.NYC_LGA.conid > 0);
});

check("missing params file -> defaults σ/bias, NO_CEILING (KNYC table must not leak)", () => {
  const { params, hasFittedCeiling } = fx.loadVenueParams(path.join(os.tmpdir(), "nope-" + Date.now() + ".json"));
  assert.strictEqual(hasFittedCeiling, false);
  assert.deepStrictEqual(params.ceilingTable, fx.NO_CEILING);
  assert.strictEqual(params.defaultNormal, fx.NYC_LGA.defaultNormal);
  assert.deepStrictEqual(params.normals, {}); // never the KNYC daily table
});

check("fit file WITHOUT ceilingTable -> σ/bias flow through, ceiling stays non-binding", () => {
  const f = path.join(os.tmpdir(), "klga-params-" + Date.now() + ".json");
  fs.writeFileSync(f, JSON.stringify({ coolBiasF: -0.9, sigmaNowcastF: 2.2, n: 1825, fittedAt: "2026-07-10" }));
  try {
    const { params, hasFittedCeiling } = fx.loadVenueParams(f);
    assert.strictEqual(params.coolBiasF, -0.9);
    assert.strictEqual(params.sigmaNowcastF, 2.2);
    assert.strictEqual(hasFittedCeiling, false);
    assert.deepStrictEqual(params.ceilingTable, fx.NO_CEILING);
  } finally { fs.unlinkSync(f); }
});

check("fit file WITH its own ceilingTable is trusted", () => {
  const f = path.join(os.tmpdir(), "klga-params-c-" + Date.now() + ".json");
  const table = [[99, 0.2], [102, 0.5]];
  fs.writeFileSync(f, JSON.stringify({ coolBiasF: -0.9, ceilingTable: table }));
  try {
    const { params, hasFittedCeiling } = fx.loadVenueParams(f);
    assert.strictEqual(hasFittedCeiling, true);
    assert.deepStrictEqual(params.ceilingTable, table);
  } finally { fs.unlinkSync(f); }
});

check("NO_CEILING truly never binds: P(>=100) equals the raw Gaussian tail", () => {
  const LADDER = [["<=99", null, 99], ["100-101", 100, 101], [">=102", 102, null]];
  const { params } = fx.loadVenueParams(path.join(os.tmpdir(), "nope2-" + Date.now() + ".json"));
  // With a very hot mean the uncapped distribution keeps mass >=100; KNYC default would cap at ~0.19.
  const d = m.distribution(103, 2, LADDER, 103, params);
  const p100 = d["100-101"] + d[">=102"];
  assert.ok(p100 > 0.5, `expected uncapped tail, got P(>=100)=${p100.toFixed(3)}`);
});

check("committed KLGA params file (if present) parses and carries no unfitted ceiling", () => {
  const repoFile = fx.KLGA_PARAMS_PATH;
  if (!fs.existsSync(repoFile)) { console.log("        (no committed file — skipped)"); return; }
  const raw = JSON.parse(fs.readFileSync(repoFile, "utf8"));
  assert.strictEqual(raw.station, "KLGA");
  assert.ok(raw.n >= 100, "fit must rest on >=100 pairs");
  const { params, hasFittedCeiling, source } = fx.loadVenueParams();
  assert.strictEqual(params.coolBiasF, raw.coolBiasF);
  if (!raw.ceilingTable) {
    assert.strictEqual(hasFittedCeiling, false);
    assert.deepStrictEqual(params.ceilingTable, fx.NO_CEILING);
  }
  assert.ok(/fitted/.test(source), source);
});

check("fee rail re-export stays <= Kalshi at every price", () => {
  for (let p = 0.01; p < 1; p += 0.01) {
    assert.ok(fx.feeCents(p) <= oracle.kalshiFeeCents(p) + 1e-9, `p=${p}`);
  }
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll forecastex-weather tests passed.");
