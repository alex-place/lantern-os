"use strict";

// Regression for issue #854: the autowork fallback applier must land
// LLM-authored unified diffs whose @@ headers have wrong line counts, whose
// line numbers have drifted, and whose context has whitespace fuzz — the exact
// failure modes that previously aborted autowork with "patch_did_not_apply".
//
// Run: node tests/test_self_edit_fuzzy_apply.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseUnifiedDiff, applyPatchStrict } = require("../apps/lantern-garage/lib/self-edit-engine");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok -", name);
}

// Write `fixture` to a temp file, apply `diff` through the fuzzy fallback
// applier, and return { stats, content }.
function applyTo(fixture, fileRel, diff) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-apply-"));
  try {
    const full = path.join(dir, fileRel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fixture !== null) fs.writeFileSync(full, fixture, "utf8");
    const files = parseUnifiedDiff(diff);
    const stats = applyPatchStrict(dir, files);
    const content = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    return { stats, content };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", ""].join("\n");

// 1) Wrong @@ header counts — the #836 failure. Header claims 9 old lines; there
//    are really 3. An exact applier throws hunk_old_count_mismatch; fuzzy lands it.
test("wrong @@ header counts still apply", () => {
  const diff = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -2,9 +2,9 @@",
    " bravo",
    "-charlie",
    "+CHARLIE",
    " delta",
    "",
  ].join("\n");
  const { stats, content } = applyTo(BASE, "f.txt", diff);
  assert.deepStrictEqual(stats.errors, [], "no apply errors");
  assert.ok(content.includes("CHARLIE"), "replacement landed");
  assert.ok(!/^charlie$/m.test(content), "old line removed");
});

// 2) Line-number drift — oldStart points at the wrong line; content search relocates.
test("line-number drift is relocated by content", () => {
  const diff = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " delta",
    "-echo",
    "+ECHO",
    " foxtrot",
    "",
  ].join("\n");
  const { stats, content } = applyTo(BASE, "f.txt", diff);
  assert.deepStrictEqual(stats.errors, [], "no apply errors");
  assert.ok(content.includes("ECHO") && !/^echo$/m.test(content), "edit landed at real location");
  assert.ok(content.includes("alpha") && content.includes("bravo"), "untouched lines preserved");
});

// 3) Whitespace drift in context — file is indented, diff context isn't; the
//    normalized pass still matches.
test("whitespace-fuzzed context still matches", () => {
  const indented = ["    one", "    two", "    three", ""].join("\n");
  const diff = [
    "--- a/g.txt",
    "+++ b/g.txt",
    "@@ -1,3 +1,3 @@",
    " one",            // diff context lacks the file's 4-space indent
    "-two",
    "+TWO",
    " three",
    "",
  ].join("\n");
  const { stats, content } = applyTo(indented, "g.txt", diff);
  assert.deepStrictEqual(stats.errors, [], "no apply errors");
  assert.ok(content.includes("TWO"), "replacement landed despite indent drift");
});

// 4) Insertion with surrounding context (the laneOf-helper shape from #836).
test("insertion with context lands at the right place", () => {
  const diff = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,2 +1,3 @@",
    " alpha",
    "+INSERTED",
    " bravo",
    "",
  ].join("\n");
  const { stats, content } = applyTo(BASE, "f.txt", diff);
  assert.deepStrictEqual(stats.errors, [], "no apply errors");
  assert.strictEqual(content.split("\n")[1], "INSERTED", "inserted between alpha and bravo");
});

// 5) CRLF files keep their line endings after a fuzzy apply.
test("CRLF line endings are preserved", () => {
  const crlf = "alpha\r\nbravo\r\ncharlie\r\n";
  const diff = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-bravo",
    "+BRAVO",
    " charlie",
    "",
  ].join("\n");
  const { stats, content } = applyTo(crlf, "f.txt", diff);
  assert.deepStrictEqual(stats.errors, [], "no apply errors");
  assert.ok(content.includes("BRAVO"), "edit landed");
  assert.ok(content.includes("\r\n") && !/[^\r]\n/.test(content), "CRLF preserved");
});

// 6) Negative: when the context genuinely isn't in the file, the applier reports
//    an error and does NOT silently corrupt the file.
test("absent context reports an error, no corruption", () => {
  const diff = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " not-in-file-1",
    "-not-in-file-2",
    "+changed",
    " not-in-file-3",
    "",
  ].join("\n");
  const { stats, content } = applyTo(BASE, "f.txt", diff);
  assert.strictEqual(stats.errors.length, 1, "one error reported");
  assert.match(stats.errors[0].error, /hunk_not_located/, "not-located error");
  assert.strictEqual(content, BASE, "file left unchanged");
});

console.log(`\n${passed} fuzzy-apply tests passed.`);
