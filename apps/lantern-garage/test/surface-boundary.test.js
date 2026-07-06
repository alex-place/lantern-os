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

check("every CORE surface's declared loop-stage tag matches its registry stage", () => {
  // Same declaration forms scripts/sprawl-tripwire.mjs accepts (meta tag or comment),
  // so a page can't tell the tripwire one stage and the registry another.
  const drift = [];
  for (const [surface, stage] of Object.entries(reg.CORE)) {
    const file = path.join(PUBLIC, surface);
    if (!fs.existsSync(file)) continue; // stale-entry check above owns missing files
    const html = fs.readFileSync(file, "utf8");
    const m = html.match(/<meta\s+name=["']loop-stage["']\s+content=["']([a-z]+)["']/i)
           || html.match(/<!--\s*loop-stage:\s*([a-z]+)\s*-->/i);
    if (!m) {
      drift.push(`${surface} → no <meta name="loop-stage"> tag (registry: ${stage})`);
    } else if (m[1].toLowerCase() !== stage.toLowerCase()) {
      drift.push(`${surface} → page declares "${m[1]}" but registry says "${stage}"`);
    }
  }
  assert.strictEqual(
    drift.length, 0,
    `loop-stage drift between page meta tags and lib/surface-registry.js:\n      ${drift.join("\n      ")}`
  );
});

// ── Non-HTML subsystems (#1948: bots + background services) ──────────────────────
const REPO_ROOT = path.resolve(__dirname, "../../..");

check("SUBSYSTEMS: every entry is classified core|extension with the right shape", () => {
  for (const [name, meta] of Object.entries(reg.SUBSYSTEMS)) {
    assert.ok(meta && (meta.tier === "core" || meta.tier === "extension"), `${name} → bad tier "${meta && meta.tier}"`);
    if (meta.tier === "core") {
      assert.ok(reg.LOOP_STAGES.includes(meta.stage), `${name} → core subsystem needs a valid loop stage (got "${meta.stage}")`);
    } else {
      assert.ok(meta.module && typeof meta.module === "string", `${name} → extension subsystem needs a module`);
    }
  }
});

check("SUBSYSTEMS: classifySubsystem round-trips and rejects unknowns", () => {
  for (const name of Object.keys(reg.SUBSYSTEMS)) {
    assert.ok(reg.classifySubsystem(name), `classifySubsystem(${name}) should classify`);
  }
  assert.strictEqual(reg.classifySubsystem("does-not-exist"), null);
});

check("SUBSYSTEMS: every declared entry artifact exists on disk (no fabricated/stale entries)", () => {
  for (const [name, meta] of Object.entries(reg.SUBSYSTEMS)) {
    assert.ok(meta.entry && typeof meta.entry === "string", `${name} → missing entry citation`);
    const abs = path.resolve(REPO_ROOT, meta.entry);
    assert.ok(fs.existsSync(abs), `${name} → entry not found on disk: ${meta.entry}`);
  }
});

check("SPRAWL BUDGET — extension:core ratio within the declared cap", () => {
  const s = reg.summary();
  assert.ok(
    s.ratio <= reg.MAX_EXTENSION_RATIO,
    `extension:core ratio ${s.ratio} exceeds cap ${reg.MAX_EXTENSION_RATIO} (${s.extension} ext : ${s.core} core) — ` +
    `add core value, or raise MAX_EXTENSION_RATIO in lib/surface-registry.js as a deliberate, reviewable decision`
  );
});

check("every EXTENSION is gateable — names a flag, or is an always-on shell module", () => {
  const offenders = Object.entries(reg.EXTENSION)
    .filter(([, [module, flag]]) => !flag && !reg.ALWAYS_ON_MODULES.has(module))
    .map(([surface, [module]]) => `${surface} (${module})`)
    .sort();
  assert.strictEqual(
    offenders.length, 0,
    `ungateable extension(s) — add an env flag, or move to an always-on shell module ` +
    `(${[...reg.ALWAYS_ON_MODULES].join(", ")}):\n      ${offenders.join("\n      ")}`
  );
});

const s = reg.summary();
console.log(`\nSurface boundary: ${s.core} core · ${s.extension} extension (ratio ${s.ratio}:1)`);
console.log(`Extensions by module: ${JSON.stringify(s.byModule)}`);
console.log(`Subsystems: ${s.subsystems.core} core · ${s.subsystems.extension} extension (${s.subsystems.total} total)`);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll surface-boundary tests passed.");
