/**
 * Regression for the archive.org Save-Page-Now guard (#940 / #919.5).
 * Run: node tests/test_archive_grounding_guard.js
 *
 * Invariant: read-only archive grounding is allowed; /save pinning is default-deny
 * (needs operator consent) and PII-redacts submitted content; and the guard is the
 * ONLY code path that may reference web.archive.org/save.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const LIB = path.resolve(__dirname, "../apps/lantern-garage/lib");
const { isReadOnlyArchiveUrl, assertReadOnlyArchive, pinToArchive } =
  require(`${LIB}/archive-grounding-guard`);

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

// ── read-only classification ─────────────────────────────────────────────────
assert.strictEqual(isReadOnlyArchiveUrl("https://archive.org/details/foo"), true);
assert.strictEqual(isReadOnlyArchiveUrl("https://web.archive.org/web/2020/http://x.com"), true);
assert.strictEqual(isReadOnlyArchiveUrl("https://web.archive.org/save/http://x.com"), false);
assert.strictEqual(isReadOnlyArchiveUrl("https://evil.example.com/details/foo"), false);
assert.strictEqual(isReadOnlyArchiveUrl("not a url"), false);
ok("isReadOnlyArchiveUrl allows reads, rejects /save + non-archive hosts");

assert.throws(() => assertReadOnlyArchive("https://web.archive.org/save/http://x.com"));
assert.strictEqual(assertReadOnlyArchive("https://archive.org/details/x"), "https://archive.org/details/x");
ok("assertReadOnlyArchive throws on a pin URL, passes a read URL");

// ── pinning is default-deny ──────────────────────────────────────────────────
assert.throws(() => pinToArchive("https://web.archive.org/save/http://x.com"),
  /operator consent/i);
assert.throws(() => pinToArchive("https://web.archive.org/save/http://x.com", { operatorApproved: false }),
  /operator consent/i);
ok("pinToArchive without operator consent throws (default-deny)");

// ── consent path redacts PII ─────────────────────────────────────────────────
const res = pinToArchive("https://web.archive.org/save/http://x.com",
  { operatorApproved: true, content: "contact me at jane.doe@example.com now" });
assert.strictEqual(res.operatorApproved, true);
assert.ok(!/jane\.doe@example\.com/.test(res.redactedContent),
  "submitted content must be PII-redacted before pinning");
ok("pinToArchive with consent redacts PII from submitted content");

assert.throws(() => pinToArchive("https://evil.example.com/save", { operatorApproved: true }),
  /non-archive host/i);
ok("pinToArchive refuses a non-archive host even with consent");

// ── the guard is the only path that may touch /save ──────────────────────────
const repoRoot = path.resolve(__dirname, "..");
let hits = "";
try {
  hits = execFileSync("git", ["grep", "-lE", "web\\.archive\\.org/save", "--",
    "*.js", "*.mjs", "*.cjs", ":(exclude)**/node_modules/**"], { cwd: repoRoot, encoding: "utf8" });
} catch (e) { hits = (e.stdout || "").toString(); } // git grep exit 1 = no matches
const offenders = hits.split(/\r?\n/).filter(Boolean)
  .filter((f) => !f.endsWith("archive-grounding-guard.js") && !f.endsWith("test_archive_grounding_guard.js"));
assert.deepStrictEqual(offenders, [],
  `only the guard may reference web.archive.org/save; offenders: ${offenders.join(", ")}`);
ok("no JS outside the guard references web.archive.org/save");

console.log(`\n#940 archive guard: ${passed} checks passed.`);
