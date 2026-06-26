/**
 * Unit tests for PrWatcher decision logic (no server / no gh needed).
 * Run: node tests/test_pr_watcher.js
 *
 * Regression target: the auto-review feature posted 200+ duplicate reviews on a
 * single PR because (a) it re-triggered on its own comment (updatedAt bump) and
 * (b) it posted the no_provider_configured error JSON as a "review". These tests
 * lock the fix: review once per head SHA, and never treat an error as a review.
 */
const assert = require("node:assert");
const os = require("node:os");
const { PrWatcher } = require("../apps/lantern-garage/lib/pr-watcher");

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log("  ok -", name); pass++; }

// ── _parseChatResponse: an error response must NOT be treated as a review ──
const P = (o) => PrWatcher._parseChatResponse(typeof o === "string" ? o : JSON.stringify(o));
ok("no_provider_configured -> not ok", P({ error: "no_provider_configured", online: false }).ok === false);
ok("online:false -> not ok", P({ online: false, reply: "x" }).ok === false);
ok("valid reply -> ok", P({ reply: "Looks good. APPROVE", online: true }).ok === true);
ok("response field -> ok", P({ response: "r" }).ok === true);
ok("missing reply -> not ok", P({ foo: 1 }).ok === false);
ok("plain text -> ok", P("a plain review").ok === true);
ok("empty string -> not ok", P("").ok === false);
ok("blank reply -> not ok", P({ reply: "   " }).ok === false);

// ── _shouldReview: review once per head SHA, idle-gated, with backoff ──
const w = new PrWatcher({ repoRoot: os.tmpdir(), idleMs: 1000 });
const now = 1_000_000;
ok("not idle yet -> false", w._shouldReview({ headSha: "A", reviewedSha: null, shaSeenAt: now }, now) === false);
ok("idle + unreviewed -> true", w._shouldReview({ headSha: "A", reviewedSha: null, shaSeenAt: now - 2000 }, now) === true);
ok("already reviewed this SHA -> false", w._shouldReview({ headSha: "A", reviewedSha: "A", shaSeenAt: now - 9e9 }, now) === false);
ok("within fail backoff -> false", w._shouldReview({ headSha: "A", reviewedSha: null, shaSeenAt: now - 2000, lastAttemptAt: now - 1000 }, now) === false);
ok("after fail backoff -> true", w._shouldReview({ headSha: "A", reviewedSha: null, shaSeenAt: now - 2000, lastAttemptAt: now - 31 * 60_000 }, now) === true);

// ── THE BUG: a comment bumps updatedAt but NOT the head SHA → must not re-trigger ──
ok("comment bump cannot re-trigger", w._shouldReview({ headSha: "A", reviewedSha: "A", shaSeenAt: now - 9e9, lastAttemptAt: now - 9e9 }, now) === false);
// A genuine new commit (SHA changes) IS eligible again after idle.
ok("new commit eligible after idle", w._shouldReview({ headSha: "B", reviewedSha: "A", shaSeenAt: now - 2000 }, now) === true);

// ── _shouldMerge: reviewed + idle + mergeable + checks-green (minus ignore list) ──
const m = new PrWatcher({ repoRoot: os.tmpdir(), idleMs: 1000, autoMerge: true, mergeIgnoreChecks: ["Python tests"] });
const reviewed = { headSha: "A", reviewedSha: "A", shaSeenAt: now - 2000 };
const green = [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }];

ok("merge: ready -> true", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green }, reviewed, now).merge === true);
ok("merge: draft -> false", m._shouldMerge({ isDraft: true, mergeable: "MERGEABLE", statusCheckRollup: green }, reviewed, now).merge === false);
ok("merge: conflicting -> false", m._shouldMerge({ isDraft: false, mergeable: "CONFLICTING", statusCheckRollup: green }, reviewed, now).merge === false);
ok("merge: unreviewed commit -> false", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green }, { headSha: "B", reviewedSha: "A", shaSeenAt: now - 2000 }, now).merge === false);
ok("merge: not idle -> false", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green }, { headSha: "A", reviewedSha: "A", shaSeenAt: now }, now).merge === false);
ok("merge: real check failure -> false", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "CI", status: "COMPLETED", conclusion: "FAILURE" }] }, reviewed, now).merge === false);
ok("merge: ignored check failure -> true", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Python tests", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === true);
ok("merge: pending check -> false", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "CI", status: "IN_PROGRESS" }] }, reviewed, now).merge === false);
ok("merge: StatusContext failure -> false", m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ context: "legacy", state: "FAILURE" }] }, reviewed, now).merge === false);
ok("merge: disabled -> false", new PrWatcher({ repoRoot: os.tmpdir(), idleMs: 1000, autoMerge: false })._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green }, reviewed, now).merge === false);

// ── protected-path gate: sensitive surfaces need a human, even when green (#1251) ──
const greenPv = (files) => ({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green, files });
ok("merge: no files -> true (back-compat)", m._shouldMerge(greenPv(undefined), reviewed, now).merge === true);
ok("merge: docs-only -> true", m._shouldMerge(greenPv([{ path: "docs/README.md" }, { path: "apps/foo.js" }]), reviewed, now).merge === true);
ok("merge: workflow change -> false", m._shouldMerge(greenPv([{ path: ".github/workflows/ci.yml" }]), reviewed, now).merge === false);
ok("merge: auth change -> false", m._shouldMerge(greenPv([{ path: "apps/lantern-garage/lib/request-auth.js" }]), reviewed, now).merge === false);
ok("merge: trading change -> false", m._shouldMerge(greenPv([{ path: "apps/lantern-garage/routes/trading.js" }]), reviewed, now).merge === false);
ok("merge: .env change -> false", m._shouldMerge(greenPv([{ path: ".env.example" }]), reviewed, now).merge === false);
ok("merge: protected reason names the file", m._shouldMerge(greenPv([{ path: ".github/workflows/ci.yml" }]), reviewed, now).reason === "protected_path:.github/workflows/ci.yml");
ok("merge: GitHub `filename` field also works", m._shouldMerge(greenPv([{ filename: "src/migration/001.sql" }]), reviewed, now).merge === false);

console.log(`\n${pass} checks passed`);
