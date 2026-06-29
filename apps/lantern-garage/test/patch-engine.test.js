"use strict";

/**
 * test/patch-engine.test.js
 *
 * The SEARCH/REPLACE edit engine added to lib/patch-engine.js (#1389): a
 * content-matched, line-drift-proof edit format. Covers parsing, exact +
 * whitespace-fuzzy application, multi-block/multi-file, new-file creation,
 * not-found failure, CRLF + trailing-newline preservation, sandbox safety, and
 * applyPatch() auto-dispatch.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/patch-engine.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const eng = require("../lib/patch-engine");

let _n = 0;
function tmpRepo() {
  // Deterministic-per-process unique dir (no Date.now/Math.random needed).
  const dir = path.join(os.tmpdir(), `patch-engine-test-${process.pid}-${_n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}
function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf-8");
}

const SR = (file, search, replace) =>
  `${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

test("looksLikeSearchReplace distinguishes SR blocks from unified diffs", () => {
  assert.equal(eng.looksLikeSearchReplace(SR("a.js", "x", "y")), true);
  assert.equal(eng.looksLikeSearchReplace("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y"), false);
  assert.equal(eng.looksLikeSearchReplace(""), false);
  assert.equal(eng.looksLikeSearchReplace(null), false);
});

test("parseSearchReplace extracts file/search/replace, incl. path-before-block", () => {
  const blocks = eng.parseSearchReplace(SR("src/foo.js", "const a = 1;", "const a = 2;"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].file, "src/foo.js");
  assert.equal(blocks[0].search, "const a = 1;");
  assert.equal(blocks[0].replace, "const a = 2;");
});

test("exact single-block replace", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "line1\nconst a = 1;\nline3\n");
  const res = await eng.applySearchReplace(SR("a.js", "const a = 1;", "const a = 2;"), dir);
  assert.equal(res.success, true);
  assert.equal(res.method, "search-replace");
  assert.equal(read(dir, "a.js"), "line1\nconst a = 2;\nline3\n");
});

test("whitespace-fuzzy match applies despite indentation drift", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "function f() {\n      return 1;\n}\n"); // 6-space indent in file
  // SEARCH uses 2-space indent — exact match fails, trimmed match wins.
  const res = await eng.applySearchReplace(SR("a.js", "  return 1;", "  return 2;"), dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(read(dir, "a.js"), "function f() {\n  return 2;\n}\n");
});

test("multiple blocks on the same file apply in order", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "a\nb\nc\n");
  const patch = SR("a.js", "a", "A") + SR("a.js", "c", "C");
  const res = await eng.applySearchReplace(patch, dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(read(dir, "a.js"), "A\nb\nC\n");
});

test("multi-file patch touches each file", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "x\n");
  write(dir, "sub/b.js", "y\n");
  const patch = SR("a.js", "x", "X") + SR("sub/b.js", "y", "Y");
  const res = await eng.applySearchReplace(patch, dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(res.filesChanged, 2);
  assert.equal(read(dir, "a.js"), "X\n");
  assert.equal(read(dir, "sub/b.js"), "Y\n");
});

test("new file is created from REPLACE when file is absent", async () => {
  const dir = tmpRepo();
  const res = await eng.applySearchReplace(SR("new/created.js", "", "module.exports = 42;"), dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(res.changed[0].status, "A");
  assert.equal(read(dir, "new/created.js"), "module.exports = 42;\n");
});

test("SEARCH not found → failure, file untouched", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "hello\n");
  const res = await eng.applySearchReplace(SR("a.js", "not here", "x"), dir);
  assert.equal(res.success, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].error, "search-block-not-found");
  assert.equal(read(dir, "a.js"), "hello\n", "file must be unchanged on failure");
});

test("CRLF line endings and trailing newline are preserved", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "one\r\ntwo\r\nthree\r\n");
  const res = await eng.applySearchReplace(SR("a.js", "two", "TWO"), dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(read(dir, "a.js"), "one\r\nTWO\r\nthree\r\n");
});

test("no trailing newline stays no trailing newline", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "a\nb"); // no final newline
  const res = await eng.applySearchReplace(SR("a.js", "b", "B"), dir);
  assert.equal(res.success, true);
  assert.equal(read(dir, "a.js"), "a\nB");
});

test("path traversal is rejected (sandbox)", async () => {
  const dir = tmpRepo();
  const res = await eng.applySearchReplace(SR("../escape.js", "", "pwned"), dir);
  assert.equal(res.success, false);
  assert.equal(res.errors[0].error, "path escapes repo sandbox");
  assert.equal(fs.existsSync(path.join(dir, "..", "escape.js")), false);
});

test("validatePatch recognises SEARCH/REPLACE as a valid payload", () => {
  const v = eng.validatePatch(SR("a.js", "x", "y"));
  assert.equal(v.valid, true);
  assert.equal(v.type, "search-replace");
  // unified diffs still validate via the original path
  assert.equal(eng.validatePatch("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-x\n+y").valid, true);
});

test("applyPatch() auto-dispatches the SEARCH/REPLACE format", async () => {
  const dir = tmpRepo();
  write(dir, "a.js", "const v = 0;\n");
  const res = await eng.applyPatch(SR("a.js", "const v = 0;", "const v = 1;"), dir);
  assert.equal(res.success, true, JSON.stringify(res.errors));
  assert.equal(res.method, "search-replace");
  assert.equal(read(dir, "a.js"), "const v = 1;\n");
});
