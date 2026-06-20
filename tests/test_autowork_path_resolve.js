/**
 * Autowork patch path-resolution (self-edit-engine applyPatch).
 *
 * Regression for the #777 failure: the LLM emitted a diff against `a/ouro_serve.py`
 * but the real file is `scripts/ouro_serve.py`, so git apply found nothing and the
 * run aborted with "no usable code changes". applyPatch now repairs a dropped-prefix
 * path to its unique real location before applying.
 *
 * Hermetic — builds throwaway git repos in a temp dir. Run: node tests/test_autowork_path_resolve.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { applyPatch, resolveRepoPath } = require("../apps/lantern-garage/lib/self-edit-engine");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack || e.message}`); failed++; }
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
}

// A temp git repo with the given {relpath: content} files committed.
function makeRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aw-pathfix-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

const OURO = "import os\nimport sys\nimport json\nfrom fastapi import FastAPI\n";

// Diff that DROPS the scripts/ prefix (the real bug shape).
const DROPPED_PREFIX_DIFF =
  "--- a/ouro_serve.py\n" +
  "+++ b/ouro_serve.py\n" +
  "@@ -1,4 +1,5 @@\n" +
  " import os\n" +
  " import sys\n" +
  " import json\n" +
  "+import datetime\n" +
  " from fastapi import FastAPI\n";

console.log("applyPatch() path resolution");

test("dropped-prefix path resolves to the unique real file and applies", () => {
  const repo = makeRepo({ "scripts/ouro_serve.py": OURO });
  const res = applyPatch(repo, DROPPED_PREFIX_DIFF);
  assert.deepStrictEqual(res.errors, [], "no apply errors");
  assert.ok(res.pathRewrites && res.pathRewrites.length === 1, "one rewrite recorded");
  assert.deepStrictEqual(res.pathRewrites[0], { from: "ouro_serve.py", to: "scripts/ouro_serve.py" });
  assert.ok(res.changed.includes("scripts/ouro_serve.py"), "real file reported changed");
  const after = fs.readFileSync(path.join(repo, "scripts/ouro_serve.py"), "utf8");
  assert.ok(after.includes("import datetime"), "the change actually landed on the real file");
  assert.ok(!fs.existsSync(path.join(repo, "ouro_serve.py")), "no bogus root file created");
});

test("already-correct path is left untouched (no rewrite) and still applies", () => {
  const repo = makeRepo({ "scripts/ouro_serve.py": OURO });
  const diff = DROPPED_PREFIX_DIFF.replace(/a\/ouro_serve\.py/g, "a/scripts/ouro_serve.py")
                                  .replace(/b\/ouro_serve\.py/g, "b/scripts/ouro_serve.py");
  const res = applyPatch(repo, diff);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.pathRewrites, [], "no rewrite when the path is already right");
  assert.ok(res.changed.includes("scripts/ouro_serve.py"));
});

test("ambiguous basename (two matches) is NOT rewritten — conservative", () => {
  const repo = makeRepo({ "a/ouro_serve.py": OURO, "b/ouro_serve.py": OURO });
  const res = applyPatch(repo, DROPPED_PREFIX_DIFF);
  // Two candidates → no unique resolution → no rewrite (the run still aborts upstream,
  // which is correct: better to abort than guess the wrong file).
  assert.deepStrictEqual(res.pathRewrites, [], "ambiguous basename must not be guessed");
});

test("new-file diff (/dev/null) is never path-resolved", () => {
  const repo = makeRepo({ "scripts/keep.py": "x\n" });
  const diff =
    "--- /dev/null\n" +
    "+++ b/newthing.py\n" +
    "@@ -0,0 +1,1 @@\n" +
    "+print('hi')\n";
  const res = applyPatch(repo, diff);
  assert.deepStrictEqual(res.pathRewrites, [], "created files keep their authored path");
});

console.log("resolveRepoPath() — plan path repair");

test("bare basename resolves to the unique real repo path", () => {
  const repo = makeRepo({ "scripts/ouro_serve.py": OURO });
  assert.strictEqual(resolveRepoPath(repo, "ouro_serve.py"), "scripts/ouro_serve.py");
});

test("already-correct path is returned unchanged", () => {
  const repo = makeRepo({ "scripts/ouro_serve.py": OURO });
  assert.strictEqual(resolveRepoPath(repo, "scripts/ouro_serve.py"), "scripts/ouro_serve.py");
});

test("genuinely-new path (no match) is returned as-is (a real new file)", () => {
  const repo = makeRepo({ "scripts/keep.py": "x\n" });
  assert.strictEqual(resolveRepoPath(repo, "scripts/brand_new.py"), "scripts/brand_new.py");
});

test("ambiguous basename is left as-is (never guessed)", () => {
  const repo = makeRepo({ "a/dup.py": "x\n", "b/dup.py": "y\n" });
  assert.strictEqual(resolveRepoPath(repo, "dup.py"), "dup.py");
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
