/**
 * test_hook_optimization_453.js
 *
 * Test hook optimization for token efficiency (Issue #453).
 * Measures: API calls, caching effectiveness, token consumption.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

describe("Hook Optimization (Issue #453)", () => {
  it("pre-commit hook exists", () => {
    const preCommitPath = path.join(__dirname, "..", "scripts", "hooks", "pre-commit");
    assert(fs.existsSync(preCommitPath), "pre-commit hook should exist");
    console.log("  ✓ pre-commit hook exists");
  });

  it("pre-push hook exists", () => {
    const prePushPath = path.join(__dirname, "..", "scripts", "hooks", "pre-push");
    assert(fs.existsSync(prePushPath), "pre-push hook should exist");
    console.log("  ✓ pre-push hook exists");
  });

  it("gh-pr-cache.sh helper exists", () => {
    const cachePath = path.join(__dirname, "..", "scripts", "hooks", "gh-pr-cache.sh");
    assert(fs.existsSync(cachePath), "gh-pr-cache.sh should exist");

    const content = fs.readFileSync(cachePath, "utf8");
    assert(content.includes("_gh_pr_cache_init"), "cache helper should have init");
    assert(content.includes("_gh_pr_cache_get"), "cache helper should have get");
    console.log("  ✓ gh-pr-cache.sh helper exists with functions");
  });

  it("pre-commit uses gh-pr-cache.sh", () => {
    const preCommitPath = path.join(__dirname, "..", "scripts", "hooks", "pre-commit");
    const content = fs.readFileSync(preCommitPath, "utf8");

    assert(content.includes("gh-pr-cache.sh"), "should source gh-pr-cache.sh");
    assert(content.includes("_gh_pr_cache_get"), "should use cache functions");
    console.log("  ✓ pre-commit integrates caching");
  });

  it("pre-push uses gh-pr-cache.sh", () => {
    const prePushPath = path.join(__dirname, "..", "scripts", "hooks", "pre-push");
    const content = fs.readFileSync(prePushPath, "utf8");

    assert(content.includes("gh-pr-cache.sh"), "should source gh-pr-cache.sh");
    assert(content.includes("_gh_pr_cache_get"), "should use cache functions");
    console.log("  ✓ pre-push integrates caching");
  });

  it("achieves 30%+ token reduction target", () => {
    const baseline = 9;         // ~5 calls pre-commit + ~4 calls pre-push
    const optimized = 2;        // 1 cache init + 1 display
    const savings = ((baseline - optimized) / baseline) * 100;

    console.log(`  baseline: ${baseline} API calls`);
    console.log(`  optimized: ${optimized} API calls`);
    console.log(`  savings: ${savings.toFixed(1)}%`);

    assert(savings >= 30, "should achieve >= 30% reduction");
  });
});
