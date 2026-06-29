/**
 * Autowork research / grounding (lib/autowork-research.js).
 *
 * Regressions for the two long-standing autowork grounding bugs:
 *   1. "research always returns 20 files" — keyword extraction kept stopwords
 *      (this/with/test/error/...) which `git grep` matched in hundreds of files,
 *      so the scope was always 20 irrelevant paths. extractKeywords now drops
 *      stopwords and ranks identifier-looking tokens first.
 *   2. step logging — every research sub-step must reach the onStep sink AND be
 *      appended to data/autowork-runs/<date>.jsonl so runs are reviewable.
 *
 * Hermetic — no network (web:false), no git repo needed. Run:
 *   node tests/test_autowork_research.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { extractKeywords, researchIssue, logStep, STOPWORDS } =
  require("../apps/lantern-garage/lib/autowork-research");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack || e.message}`); failed++; }
}

(async () => {
  await test("extractKeywords drops stopwords", () => {
    const kw = extractKeywords(
      "This is an issue with the test. We should fix the error in the data file when the function returns.");
    assert.ok(kw.length > 0, "expected some keywords");
    for (const k of kw) {
      assert.ok(!STOPWORDS.has(k.toLowerCase()), `stopword leaked into keywords: ${k}`);
    }
  });

  await test("extractKeywords ranks identifier-looking tokens first", () => {
    const kw = extractKeywords("The webSearch grounding and researchIssue helper both matter here.");
    assert.ok(
      kw[0] === "webSearch" || kw[0] === "researchIssue",
      `expected an identifier first, got ${JSON.stringify(kw)}`);
  });

  await test("extractKeywords caps at the requested max", () => {
    const kw = extractKeywords("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo", 5);
    assert.strictEqual(kw.length, 5);
  });

  await test("researchIssue emits every step to onStep and returns a bounded, ranked scope", async () => {
    const steps = [];
    const r = await researchIssue({
      workRoot: process.cwd(),
      issueNumber: 424242, // sentinel — cleaned up below
      issueTitle: "webSearch grounding returns 0 and scopeFiles is always 20",
      issueBody: "Fix the researchIssue ranking in convergence-dispatch.",
      web: false, // hermetic — no network
      onStep: (phase, status) => steps.push(`${phase}:${status}`),
    });
    assert.ok(steps.includes("research:keywords"), "missing keywords step");
    assert.ok(steps.includes("research:done"), "missing done step");
    assert.ok(Array.isArray(r.scopeFiles), "scopeFiles should be an array");
    assert.ok(r.scopeFiles.length <= 8, `scope should be bounded (got ${r.scopeFiles.length})`);
    assert.ok(r.researchContext && Array.isArray(r.researchContext.keywords), "missing researchContext");
  });

  await test("logStep appends a reviewable JSONL record", () => {
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(process.cwd(), "data", "autowork-runs", `${date}.jsonl`);
    logStep("test-run-424242", 424242, "verify", "ok", { marker: "unit-test" });
    assert.ok(fs.existsSync(logFile), "run log file was not created");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const mine = lines.map((l) => JSON.parse(l)).filter((r) => r.issue === 424242);
    assert.ok(mine.length > 0, "no test record found in run log");
    assert.ok(mine.some((r) => r.marker === "unit-test"), "marker not persisted");

    // Cleanup: strip the sentinel records (and remove the file if it was test-only).
    const kept = lines.map((l) => JSON.parse(l)).filter((r) => r.issue !== 424242);
    if (kept.length) fs.writeFileSync(logFile, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
    else { fs.unlinkSync(logFile); try { fs.rmdirSync(path.dirname(logFile)); } catch (_e) { /* not empty */ } }
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
})();
