// #1503 — pure helpers behind the autowork PR review actions (Approve / Discard).
// The gh-shelling runPrAction is exercised live, not in CI; the parsing/validation
// that decides what gets shelled out is locked down here.
//
// Run: node test/pr-actions.test.js
const assert = require("assert");
const { sanitizeRepo, parsePrUrl, cleanGhErr, resolveTarget } = require("../lib/pr-actions");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// sanitizeRepo
check("accepts owner/repo", () => assert.strictEqual(sanitizeRepo("alex-place/lantern-os"), "alex-place/lantern-os"));
check("rejects shell metachars", () => assert.strictEqual(sanitizeRepo("a/b; rm -rf /"), ""));
check("rejects missing slash", () => assert.strictEqual(sanitizeRepo("lantern-os"), ""));
check("rejects empty / null", () => { assert.strictEqual(sanitizeRepo(""), ""); assert.strictEqual(sanitizeRepo(null), ""); });

// parsePrUrl
check("parses a github PR url", () => assert.deepStrictEqual(parsePrUrl("https://github.com/alex-place/lantern-os/pull/1503"), { repo: "alex-place/lantern-os", number: 1503 }));
check("parses fork PR url", () => assert.deepStrictEqual(parsePrUrl("https://github.com/Mookman11/lantern-os/pull/42"), { repo: "Mookman11/lantern-os", number: 42 }));
check("non-PR url → null", () => assert.strictEqual(parsePrUrl("https://github.com/alex-place/lantern-os/issues/9"), null));
check("garbage → null", () => assert.strictEqual(parsePrUrl("not a url"), null));

// cleanGhErr
check("returns last meaningful stderr line, capped", () =>
  assert.strictEqual(cleanGhErr("\nfoo\n  GraphQL: not mergeable  \n"), "GraphQL: not mergeable"));
check("empty stderr → empty string", () => assert.strictEqual(cleanGhErr(""), ""));

// resolveTarget — prUrl wins; falls back to {repo, pr}; rejects bad input
check("resolves from prUrl", () =>
  assert.deepStrictEqual(resolveTarget({ prUrl: "https://github.com/o/r/pull/7" }), { repo: "o/r", pr: 7 }));
check("resolves from explicit repo+pr", () =>
  assert.deepStrictEqual(resolveTarget({ repo: "o/r", pr: "12" }), { repo: "o/r", pr: 12 }));
check("rejects non-positive pr", () => assert.strictEqual(resolveTarget({ repo: "o/r", pr: 0 }), null));
check("rejects bad repo with no prUrl", () => assert.strictEqual(resolveTarget({ repo: "bad;repo", pr: 3 }), null));

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall pr-actions checks passed\n");
