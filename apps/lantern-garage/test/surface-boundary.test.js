// Σ₀ surface boundary contract — the anti-sprawl gate.
//
// The North Star: "name the loop stage you improve, or don't add it." This test makes
// that enforceable for UI surfaces — every top-level public/*.html must be declared in
// lib/surface-registry.js as either CORE (naming a valid loop stage) or EXTENSION (naming
// a module). A new surface added without classification fails this test, so sprawl can't
// land silently. Grounded in the modular-monolith pattern: boundaries enforced by a
// contract test before merge (https://modularmonoliths.com/).
//
// Run: node apps/lantern-garage/test/surface-boundary.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const reg = require("../lib/surface-registry");
const PUBLIC = path.resolve(__dirname, "../public");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Top-level public *.html (the navigable surfaces). Subdir assets are out of scope.
const htmlFiles = fs.readdirSync(PUBLIC)
  .filter((f) => f.toLowerCase().endsWith(".html"))
  .sort();

check("there are surfaces to classify", () => assert.ok(htmlFiles.length > 0));

check("NO SILENT SPRAWL — every public surface is classified core|extension", () => {
  const missing = reg.unclassified(htmlFiles);
  assert.strictEqual(
    missing.length, 0,
    `${missing.length} unclassified surface(s) — add to lib/surface-registry.js (core stage or extension module):\n      ${missing.join("\n      ")}`
  );
});

check("every CORE surface names a valid loop stage", () => {
  for (const [surface, stage] of Object.entries(reg.CORE)) {
    assert.ok(reg.LOOP_STAGES.includes(stage), `${surface} → invalid stage "${stage}"`);
  }
});

check("every EXTENSION surface names a module", () => {
  for (const [surface, [module]] of Object.entries(reg.EXTENSION)) {
    assert.ok(module && typeof module === "string", `${surface} → missing module`);
  }
});

check("registry contains no stale entries (every declared surface exists on disk)", () => {
  const onDisk = new Set(htmlFiles);
  const declared = [...Object.keys(reg.CORE), ...Object.keys(reg.EXTENSION)];
  const stale = declared.filter((s) => !onDisk.has(s)).sort();
  assert.strictEqual(stale.length, 0, `stale registry entries (file deleted?):\n      ${stale.join("\n      ")}`);
});

check("every loop stage is served by at least one core surface", () => {
  const served = new Set(Object.values(reg.CORE));
  const uncovered = reg.LOOP_STAGES.filter((s) => !served.has(s));
  assert.strictEqual(uncovered.length, 0, `loop stages with no core surface: ${uncovered.join(", ")}`);
});

const s = reg.summary();
console.log(`\nSurface boundary: ${s.core} core · ${s.extension} extension (ratio ${s.ratio}:1)`);
console.log(`Extensions by module: ${JSON.stringify(s.byModule)}`);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll surface-boundary tests passed.");
