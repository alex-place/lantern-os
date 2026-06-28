/**
 * Self-Edit Engine Unit Tests
 * Tests the engine helpers directly without a live server.
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  isPathSafe,
  sanitizeBranchName,
  parseUnifiedDiff,
  validateDiff,
  applyPatch,
  isAllowedTest,
  requireSafePaths,
  extractJson,
  resolveExistingIssue,
  looksLikePlaceholderPatch,
  patchSyntaxErrors,
} = require("../apps/lantern-garage/lib/self-edit-engine");

const repoRoot = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function run() {
  console.log("\nSelf-Edit Engine Unit Tests\n");

  // ── Path safety ───────────────────────────────────────────────────────
  console.log("Path safety");

  test("allows paths inside repo", () => {
    assert.strictEqual(isPathSafe(repoRoot, "apps/lantern-garage/server.js"), true);
    assert.strictEqual(isPathSafe(repoRoot, "data/test.json"), true);
  });

  test("rejects paths outside repo", () => {
    assert.strictEqual(isPathSafe(repoRoot, "../../outside.js"), false);
    assert.strictEqual(isPathSafe(repoRoot, "/etc/passwd"), false);
  });

  test("rejects traversal attempts", () => {
    assert.strictEqual(isPathSafe(repoRoot, "foo/../../../etc/passwd"), false);
  });

  test("requireSafePaths throws on unsafe paths", () => {
    assert.throws(() => requireSafePaths(repoRoot, ["safe.js", "../../bad.js"]), /unsafe_path/);
  });

  // ── Branch safety ─────────────────────────────────────────────────────
  console.log("Branch safety");

  test("sanitizes branch names", () => {
    assert.strictEqual(sanitizeBranchName("fix the bug"), "auto/fix-the-bug");
    assert.strictEqual(sanitizeBranchName("Feature!!!123"), "auto/feature123");
    assert.strictEqual(sanitizeBranchName(""), "auto/auto-change");
  });

  test("prefixes with auto/", () => {
    const branch = sanitizeBranchName("my-feature");
    assert.ok(branch.startsWith("auto/"), "branch should start with auto/");
  });

  // ── Diff parsing ──────────────────────────────────────────────────────
  console.log("Diff parsing");

  test("parses a valid unified diff", () => {
    const diff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 line one
+new line
 line two
 line three
`;
    const files = parseUnifiedDiff(diff);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].oldFile, "a/test.js");
    assert.strictEqual(files[0].newFile, "b/test.js");
    assert.strictEqual(files[0].hunks.length, 1);
    assert.strictEqual(files[0].hunks[0].oldStart, 1);
    assert.strictEqual(files[0].hunks[0].oldCount, 3);
    assert.strictEqual(files[0].hunks[0].newCount, 4);
  });

  test("returns empty for invalid diff", () => {
    const files = parseUnifiedDiff("not a diff");
    assert.strictEqual(files.length, 0);
  });

  // ── Diff validation ───────────────────────────────────────────────────
  console.log("Diff validation");

  test("accepts safe diff", () => {
    const diff = `--- a/apps/lantern-garage/server.js
+++ b/apps/lantern-garage/server.js
@@ -1,1 +1,2 @@
 // existing
+// new
`;
    assert.doesNotThrow(() => validateDiff(diff, repoRoot));
  });

  test("rejects diff with unsafe paths", () => {
    const diff = `--- a/../../outside.js
+++ b/../../outside.js
@@ -1,1 +1,2 @@
 // existing
+// new
`;
    assert.throws(() => validateDiff(diff, repoRoot), /unsafe_path/);
  });

  test("rejects diff that is too large", () => {
    const hugeDiff = "--- a/file.js\n+++ b/file.js\n" + "@@ -1,1 +1,2 @@\n".repeat(100000);
    assert.throws(() => validateDiff(hugeDiff, repoRoot), /diff_too_large/);
  });

  // ── Patch application ─────────────────────────────────────────────────
  console.log("Patch application");

  test("applies a simple patch", () => {
    const testFile = path.join(repoRoot, "tests", "_self_edit_test_target.js");
    fs.writeFileSync(testFile, "line one\nline two\nline three\n", "utf8");
    const diff = `--- a/tests/_self_edit_test_target.js
+++ b/tests/_self_edit_test_target.js
@@ -1,3 +1,4 @@
 line one
+new line
 line two
 line three
`;
    const stats = applyPatch(repoRoot, diff);
    assert.ok(stats.changed.includes("tests/_self_edit_test_target.js"), "should list changed file");
    const content = fs.readFileSync(testFile, "utf8");
    assert.ok(content.includes("new line"), "patch should add new line");
    fs.unlinkSync(testFile);
  });

  test("reports errors for bad hunks", () => {
    const testFile = path.join(repoRoot, "tests", "_self_edit_test_target2.js");
    fs.writeFileSync(testFile, "line one\nline two\n", "utf8");
    const diff = `--- a/tests/_self_edit_test_target2.js
+++ b/tests/_self_edit_test_target2.js
@@ -1,2 +1,2 @@
- wrong line
+ replaced
 line two
`;
    const stats = applyPatch(repoRoot, diff);
    assert.strictEqual(stats.errors.length, 1, "should record a hunk mismatch error");
    fs.unlinkSync(testFile);
  });

  // ── Test allowlist ──────────────────────────────────────────────────
  console.log("Test allowlist");

  test("allows known test commands", () => {
    assert.strictEqual(isAllowedTest("node tests/test_dream_journal_api.js"), true);
    assert.strictEqual(isAllowedTest("npm test"), true);
    assert.strictEqual(isAllowedTest("python -m pytest tests/test_dashboard_ux.py"), true);
  });

  test("rejects unknown test commands", () => {
    assert.strictEqual(isAllowedTest("rm -rf /"), false);
    assert.strictEqual(isAllowedTest("node evil.js"), false);
    assert.strictEqual(isAllowedTest("curl http://bad.com"), false);
  });

  // ── Plan JSON extraction (autowork plan_parse_failed hardening) ────────
  console.log("Plan JSON extraction");

  test("parses a bare JSON object", () => {
    assert.deepStrictEqual(extractJson('{"summary":"x","steps":[]}'), { summary: "x", steps: [] });
  });

  test("parses ```json fenced JSON", () => {
    const raw = '```json\n{"summary":"fenced","affectedFiles":["a.js"]}\n```';
    assert.deepStrictEqual(extractJson(raw).affectedFiles, ["a.js"]);
  });

  test("parses a lone opening fence with no closing fence", () => {
    const raw = '```json\n{"summary":"no-close","riskLevel":"low"}';
    assert.strictEqual(extractJson(raw).riskLevel, "low");
  });

  test("parses JSON with preamble/commentary around it", () => {
    const raw = 'Here is the plan you asked for:\n{"summary":"pre"}\nHope that helps!';
    assert.strictEqual(extractJson(raw).summary, "pre");
  });

  test("tolerates trailing commas", () => {
    assert.strictEqual(extractJson('{"summary":"tc","steps":[1,2,],}').summary, "tc");
  });

  test("tolerates // and /* */ comments", () => {
    const raw = '{\n  // the plan\n  "summary":"cm" /* inline */\n}';
    assert.strictEqual(extractJson(raw).summary, "cm");
  });

  test("repairs a TRUNCATED fenced object (the #873 failure)", () => {
    // Model got cut off mid-array: no closing ], no closing }, no closing fence.
    const raw = '```json\n{\n  "summary": "fix injection",\n  "affectedFiles": [\n    "apps/lantern-garage/lib/self-edit-engine.js",\n    "apps/lantern-garage/routes/keystone.js"';
    const plan = extractJson(raw);
    assert.strictEqual(plan.summary, "fix injection");
    assert.deepStrictEqual(plan.affectedFiles, [
      "apps/lantern-garage/lib/self-edit-engine.js",
      "apps/lantern-garage/routes/keystone.js",
    ]);
  });

  test("parses a top-level JSON array", () => {
    assert.deepStrictEqual(extractJson('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  });

  test("throws on genuinely empty / non-JSON input", () => {
    assert.throws(() => extractJson(""), /empty response/);
    assert.throws(() => extractJson("the model refused to answer"), /no valid JSON/);
  });

  // ── resolveExistingIssue (#1347): meta-commands must not be filed as junk ──
  // Hermetic cases only: genuine coding tasks have no #N / "oldest|newest issue"
  // reference, so they short-circuit to null WITHOUT touching `gh`. This locks in
  // the safety property that a real coding request is never mis-resolved onto an
  // unrelated existing issue (the false-positive direction). Live resolution of
  // "#N" / "the oldest issue" is exercised against real `gh` in manual/dev runs.
  test("resolveExistingIssue: null for empty / whitespace task", () => {
    assert.strictEqual(resolveExistingIssue(repoRoot, ""), null);
    assert.strictEqual(resolveExistingIssue(repoRoot, "   \n  "), null);
  });

  test("resolveExistingIssue: null for a genuine coding task (no issue ref)", () => {
    assert.strictEqual(
      resolveExistingIssue(repoRoot, "Add a dark-mode toggle to the settings page"),
      null
    );
    assert.strictEqual(
      resolveExistingIssue(repoRoot, "fix the parseDocRequest handler that hijacks pdf requests"),
      null
    );
  });

  test("resolveExistingIssue: 'issues' as a plain word does not trigger resolution", () => {
    // "report issues" is not a reference to a specific or superlative issue.
    assert.strictEqual(
      resolveExistingIssue(repoRoot, "make the error banner report issues more clearly"),
      null
    );
  });

  // ── looksLikePlaceholderPatch (#1354): reject non-implementation patches ──
  test("placeholder: flags the auto-dispatch.js scaffolding from the live report", () => {
    // The actual hallucinated diff an autowork run produced for a junk meta-command.
    const diff = [
      "--- /dev/null",
      "+++ b/apps/lantern-garage/lib/auto-dispatch.js",
      "@@ -0,0 +1,12 @@",
      "+let isEnabled = false; // Assuming an internal state for enabled/disabled",
      "+async function performDispatch() {",
      "+  // Placeholder for the actual dispatch logic",
      "+  // Simulate async work",
      "+  await new Promise(resolve => setTimeout(resolve, 1000));",
      "+  // In a real scenario, this would fetch and process one issue.",
      "+  console.log('Performing auto-dispatch...');",
      "+}",
    ].join("\n");
    const r = looksLikePlaceholderPatch(diff);
    assert.strictEqual(r.placeholder, true);
    assert.ok(r.signals.length >= 2, `expected >=2 markers, got ${r.signals.length}`);
  });

  test("placeholder: a single stray marker does NOT trip (false-positive guard)", () => {
    const diff = [
      "--- a/lib/x.js",
      "+++ b/lib/x.js",
      "@@ -1,1 +1,2 @@",
      " function x(a, b) {",
      "+  return a + b; // replace this with a real reducer later",
      " }",
    ].join("\n");
    assert.strictEqual(looksLikePlaceholderPatch(diff).placeholder, false);
  });

  test("placeholder: a genuine implementation is not flagged", () => {
    const diff = [
      "--- a/lib/sum.js",
      "+++ b/lib/sum.js",
      "@@ -0,0 +1,4 @@",
      "+function sum(nums) {",
      "+  return nums.reduce((acc, n) => acc + n, 0);",
      "+}",
      "+module.exports = { sum };",
    ].join("\n");
    assert.strictEqual(looksLikePlaceholderPatch(diff).placeholder, false);
  });

  test("placeholder: only ADDED lines count, not context/removed", () => {
    // Markers that already exist in the file (context lines) must not trip it.
    const diff = [
      "--- a/lib/y.js",
      "+++ b/lib/y.js",
      "@@ -1,3 +1,3 @@",
      "   // Placeholder for the actual logic",
      "-  // in a real scenario this would fetch",
      "+  return realImplementation();",
    ].join("\n");
    assert.strictEqual(looksLikePlaceholderPatch(diff).placeholder, false);
  });

  // ── patchSyntaxErrors (#1359): reject patches that leave a file unparseable ──
  test("patchSyntaxErrors: flags a JS file with a syntax error, passes a valid one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-syn-"));
    try {
      fs.writeFileSync(path.join(dir, "good.js"), "function ok(a){ return a + 1; }\nmodule.exports = ok;\n");
      // The exact #1359 break: a function declaration with no body, then a `const`.
      fs.writeFileSync(path.join(dir, "bad.js"), "function parseImageRequest(text)\nconst FALLBACKS = [];\n");
      const errs = patchSyntaxErrors(["good.js", "bad.js"], dir);
      const files = errs.map((e) => e.file);
      assert.ok(files.includes("bad.js"), "expected bad.js to be flagged");
      assert.ok(!files.includes("good.js"), "good.js must not be flagged");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patchSyntaxErrors: ignores non-source files and empty input", () => {
    assert.deepStrictEqual(patchSyntaxErrors([], process.cwd()), []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-syn2-"));
    try {
      // .json / .md aren't parse-checked here — must not be flagged even if malformed.
      fs.writeFileSync(path.join(dir, "data.json"), "{ not valid json (((");
      fs.writeFileSync(path.join(dir, "notes.md"), "# heading with ``` unbalanced");
      assert.deepStrictEqual(patchSyntaxErrors(["data.json", "notes.md"], dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patchSyntaxErrors: flags a broken Python file (skipped if no python)", () => {
    let pyBin = null;
    for (const bin of [process.env.PYTHON_PATH, process.platform === "win32" ? "python" : "python3"].filter(Boolean)) {
      try { require("child_process").execFileSync(bin, ["--version"], { stdio: "pipe" }); pyBin = bin; break; } catch { /* try next */ }
    }
    if (!pyBin) return; // no python on PATH → skip (the JS case already covers the gate)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-syn-py-"));
    try {
      fs.writeFileSync(path.join(dir, "good.py"), "def f(x):\n    return x + 1\n");
      fs.writeFileSync(path.join(dir, "bad.py"), "def f(x):\n    return x +\n");
      const errs = patchSyntaxErrors(["good.py", "bad.py"], dir);
      const files = errs.map((e) => e.file);
      assert.ok(files.includes("bad.py"), "expected bad.py to be flagged");
      assert.ok(!files.includes("good.py"), "good.py must not be flagged");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
