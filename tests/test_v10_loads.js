/**
 * Smoke test — v10 video-scoring modules load + expose a usable API.
 *
 * These modules (feature-extractor-v10, sigma0-v10-scoring, analyzer-v10) were
 * cherry-picked from PR #875 (an external fork dump): the rest of that PR — brand/design
 * reversions to dream-chat.js/render-pipeline-v2.js plus ~5,500 lines of data/report dumps —
 * was excluded. They are currently DORMANT (not wired into the live highlight pipeline);
 * this test just proves they import cleanly and export callable functions, so they don't rot.
 *
 * Pure unit test — no server, no network, no model. Run: node tests/test_v10_loads.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  - " + name); passed++; }
  catch (e) { console.log("  FAIL- " + name + ": " + e.message); failed++; }
}

console.log("\nv10 scoring modules load (cherry-picked from #875)\n");

check("feature-extractor-v10 imports + exports a function", () => {
  const m = require(path.join(root, "lib", "feature-extractor-v10.js"));
  assert(m && typeof m === "object", "module did not export an object");
  assert(Object.values(m).some((v) => typeof v === "function"), "no exported function");
});

check("sigma0-v10-scoring imports + exports a function", () => {
  const m = require(path.join(root, "lib", "sigma0-v10-scoring.js"));
  assert(m && Object.values(m).some((v) => typeof v === "function"), "no exported function");
});

check("analyzer-v10 imports (transitively loads the other two) + exports", () => {
  const m = require(path.join(root, "lib", "analyzer-v10.js"));
  assert(m && Object.values(m).some((v) => typeof v === "function" || typeof v === "object"), "no usable export");
});

console.log(`\nv10 modules: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
