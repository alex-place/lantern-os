"use strict";
// #2074 — the "local research library" claim must never prime fabrication when the archive is
// empty. The persona prompt no longer asserts a research library, and the retrieval paths are
// gated: queryResearchLibrary() returns [] on an empty/absent manifest, and
// formatCSFContextForPrompt() only emits a "Research library:" block when docs are actually
// retrieved (csf-memory.js: `if (researchDocs.length > 0)`). This locks that behavior in so a
// regression can't reintroduce the empty-archive fabrication prime — and proves the gate also
// fires correctly when the archive DOES have a matching doc.
//
// Run: node apps/lantern-garage/test/research-library-gate.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// TESSERACT_MANIFEST is resolved from dataRoot() at module load, so point UNISONA_STATE_DIR at a
// controlled dir and re-require csf-memory fresh (also resets its 60s tesseract cache).
function freshCsf(stateDir) {
  process.env.UNISONA_STATE_DIR = stateDir;
  delete require.cache[require.resolve("../lib/csf-memory")];
  delete require.cache[require.resolve("../lib/app-paths")];
  return require("../lib/csf-memory");
}

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

const savedEnv = process.env.UNISONA_STATE_DIR;

// ── empty archive: the #2074 fabrication-prime case ──────────────────────────
const emptyDir = mkdir(fs.mkdtempSync(path.join(os.tmpdir(), "reslib-empty-")));
// no tesseract/manifest.json at all → the true "empty archive" condition
const csfEmpty = freshCsf(emptyDir);

check("empty archive → queryResearchLibrary returns nothing", () => {
  assert.deepStrictEqual(csfEmpty.queryResearchLibrary("quantum entanglement teleportation", 3), []);
});

check("empty archive → prompt context has NO 'Research library:' block", () => {
  const ctx = csfEmpty.formatCSFContextForPrompt("quantum entanglement teleportation experiments") || "";
  assert.ok(!/Research library:/i.test(ctx),
    "empty archive must not emit a research-library block that primes fabricated citations");
});

// ── manifest present with docs:[] (28-byte-CSF equivalent) → still nothing ───
const zeroDir = mkdir(fs.mkdtempSync(path.join(os.tmpdir(), "reslib-zero-")));
mkdir(path.join(zeroDir, "data", "tesseract"));   // dataRoot() === <UNISONA_STATE_DIR>/data
fs.writeFileSync(path.join(zeroDir, "data", "tesseract", "manifest.json"), JSON.stringify({ docs: [] }));
const csfZero = freshCsf(zeroDir);

check("manifest with docs:[] → queryResearchLibrary still returns nothing", () => {
  assert.deepStrictEqual(csfZero.queryResearchLibrary("quantum entanglement", 3), []);
});

check("manifest with docs:[] → no 'Research library:' block", () => {
  const ctx = csfZero.formatCSFContextForPrompt("quantum entanglement experiments") || "";
  assert.ok(!/Research library:/i.test(ctx));
});

// ── populated archive: the gate must ALSO fire (not a trivial always-empty) ───
const fullDir = mkdir(fs.mkdtempSync(path.join(os.tmpdir(), "reslib-full-")));
mkdir(path.join(fullDir, "data", "tesseract"));
fs.writeFileSync(path.join(fullDir, "data", "tesseract", "manifest.json"), JSON.stringify({
  docs: [{
    pdfTitle: "Quantum entanglement teleportation experiments",
    textSnippet: "We demonstrate quantum entanglement teleportation across experiments with high fidelity.",
    filename: "qet.pdf", publishedAt: "2024",
  }],
}));
const csfFull = freshCsf(fullDir);

check("populated archive → queryResearchLibrary returns the matching doc", () => {
  const hits = csfFull.queryResearchLibrary("quantum entanglement teleportation experiments", 3);
  assert.ok(hits.length >= 1, "a title-matching doc should be retrieved");
});

check("populated archive → context DOES emit the 'Research library:' block (gate works both ways)", () => {
  const ctx = csfFull.formatCSFContextForPrompt("quantum entanglement teleportation experiments") || "";
  assert.ok(/Research library:/i.test(ctx), "a real retrieved doc should surface a research-library block");
});

// restore env
if (savedEnv === undefined) delete process.env.UNISONA_STATE_DIR;
else process.env.UNISONA_STATE_DIR = savedEnv;

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
