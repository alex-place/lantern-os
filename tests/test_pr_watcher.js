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
const reviewed = { headSha: "A", reviewedSha: "A", reviewVerdict: "APPROVE", shaSeenAt: now - 2000 };
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

// ── ignore-list self-heal: aggregate gate + base-branch reds never block ──
// The "All checks passed" roll-up is red whenever any constituent is red, so it
// must never block (we recompute the constituents ourselves) — even when it is NOT
// in the configured ignore set. This is the wedge that kept every PR un-mergeable.
ok("merge: 'All checks passed' aggregate ignored -> true",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "All checks passed", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === true);
// extraIgnore (the checks failing on the base branch) self-heals the list at runtime.
ok("merge: base-red check via extraIgnore -> true",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Lint & validate", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now, new Set(["Lint & validate"])).merge === true);
ok("merge: base-GREEN check still blocks (not in extraIgnore) -> false",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Lint & validate", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now, new Set()).merge === false);

// ── deploy-preview infra ignored by PATTERN: PR-only checks (Netlify/Vercel) that
// _baseFailingChecks can never reach. A Netlify "Deploy failed" must not wedge merges. ──
const netlifyFail = [
  { name: "Header rules - magical-rabanadas-2c70f4", status: "COMPLETED", conclusion: "FAILURE" },
  { name: "Pages changed - magical-rabanadas-2c70f4", status: "COMPLETED", conclusion: "FAILURE" },
  { name: "Redirect rules - magical-rabanadas-2c70f4", status: "COMPLETED", conclusion: "FAILURE" },
  { context: "netlify/magical-rabanadas-2c70f4/deploy-preview", state: "FAILURE" },
];
ok("merge: failing Netlify deploy-preview cluster ignored -> true",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [...netlifyFail, ...green] }, reviewed, now).merge === true);
ok("merge: Vercel deployment failure ignored -> true",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Vercel", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === true);
ok("merge: generic 'Deploy Preview' check ignored -> true",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Deploy Preview / build", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === true);
// …but a real, non-preview failure alongside green deploy previews STILL blocks.
ok("merge: real failure beside ignored previews still blocks -> false",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [...netlifyFail, { name: "Debug statement check", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === false);
// A check that merely CONTAINS "deploy" but is a real gate (e.g. "Deploy readiness
// tests") must NOT be swallowed — the pattern targets *-preview, not the word deploy.
ok("merge: non-preview 'deploy' gate not swallowed -> false",
  m._shouldMerge({ isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [{ name: "Deploy readiness tests", status: "COMPLETED", conclusion: "FAILURE" }, ...green] }, reviewed, now).merge === false);

// ── verdict gate: review must APPROVE, not merely happen (the #1302 hole) ──
const greenPvBase = { isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: green };
ok("merge: REQUEST_CHANGES verdict -> false", m._shouldMerge(greenPvBase, { headSha: "A", reviewedSha: "A", reviewVerdict: "REQUEST_CHANGES", shaSeenAt: now - 2000 }, now).merge === false);
ok("merge: COMMENT verdict -> false", m._shouldMerge(greenPvBase, { headSha: "A", reviewedSha: "A", reviewVerdict: "COMMENT", shaSeenAt: now - 2000 }, now).merge === false);
ok("merge: missing verdict (legacy state) -> false", m._shouldMerge(greenPvBase, { headSha: "A", reviewedSha: "A", shaSeenAt: now - 2000 }, now).merge === false);
ok("merge: not_approved reason names the verdict", m._shouldMerge(greenPvBase, { headSha: "A", reviewedSha: "A", reviewVerdict: "REQUEST_CHANGES", shaSeenAt: now - 2000 }, now).reason === "not_approved:REQUEST_CHANGES");

// ── _parseVerdict: last verdict token wins; fail closed to COMMENT ──
ok("verdict: trailing APPROVE", PrWatcher._parseVerdict("Looks good.\n\nVerdict: APPROVE") === "APPROVE");
ok("verdict: APPROVED past tense", PrWatcher._parseVerdict("APPROVED — ship it") === "APPROVE");
ok("verdict: REQUEST_CHANGES wins when it follows approve talk", PrWatcher._parseVerdict("I'd approve, but actually REQUEST_CHANGES") === "REQUEST_CHANGES");
ok("verdict: REQUEST CHANGES (spaced)", PrWatcher._parseVerdict("Verdict: REQUEST CHANGES") === "REQUEST_CHANGES");
ok("verdict: bare COMMENT", PrWatcher._parseVerdict("Some notes. COMMENT") === "COMMENT");
ok("verdict: disapprove never counts as approve", PrWatcher._parseVerdict("I disapprove of this approach") === "COMMENT");
ok("verdict: empty -> COMMENT (fail closed)", PrWatcher._parseVerdict("") === "COMMENT");

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

// ── assigned-issue convergence gate: pure signal helpers ─────────────────────
// _closingIssues: GitHub's closingIssuesReferences first, else a body scan.
ok("closing: from closingIssuesReferences",
  JSON.stringify(PrWatcher._closingIssues({ closingIssuesReferences: [{ number: 42 }, { number: 7 }] })) === "[42,7]");
ok("closing: body 'Fixes #N' fallback",
  JSON.stringify(PrWatcher._closingIssues({ body: "Fixes #99\n\nsome text" })) === "[99]");
ok("closing: Closes/Resolves variants + dedupe",
  JSON.stringify(PrWatcher._closingIssues({ body: "Closes #5, resolved #5, fix #6" })) === "[5,6]");
ok("closing: none -> []", PrWatcher._closingIssues({ body: "no refs here" }).length === 0);
ok("closing: refs win over body",
  JSON.stringify(PrWatcher._closingIssues({ closingIssuesReferences: [{ number: 1 }], body: "Fixes #2" })) === "[1]");

// _gateFromLabels: both spellings of the convergance label + autowork-verified, case-insensitive.
ok("labels: convergance-record -> convergance", PrWatcher._gateFromLabels([{ name: "convergance-record" }]).convergance === true);
ok("labels: convergence-record (alt spelling) -> convergance", PrWatcher._gateFromLabels([{ name: "Convergence-Record" }]).convergance === true);
ok("labels: autowork-verified -> autowork", PrWatcher._gateFromLabels([{ name: "autowork-verified" }]).autowork === true);
ok("labels: none -> both false", PrWatcher._gateFromLabels([{ name: "bug" }]).convergance === false && PrWatcher._gateFromLabels([]).autowork === false);

// _runRecordSignals: convergence/record phases → convergance; council/done-ok/result-ok/testsVerified → autowork.
ok("run: convergence done -> convergance", PrWatcher._runRecordSignals({ phase: "convergence", status: "done" }).convergance === true);
ok("run: record done -> convergance", PrWatcher._runRecordSignals({ phase: "record", status: "done" }).convergance === true);
ok("run: council -> autowork", PrWatcher._runRecordSignals({ phase: "council", status: "done" }).autowork === true);
ok("run: done ok -> autowork", PrWatcher._runRecordSignals({ phase: "done", status: "ok" }).autowork === true);
ok("run: result ok -> autowork", PrWatcher._runRecordSignals({ phase: "result", status: "ok" }).autowork === true);
ok("run: testsVerified -> autowork", PrWatcher._runRecordSignals({ phase: "test", status: "done", testsVerified: true }).autowork === true);
ok("run: plain research step -> neither", (() => { const s = PrWatcher._runRecordSignals({ phase: "research", status: "done" }); return !s.convergance && !s.autowork; })());

// ── _shouldMerge with the gate: assigned issue needs BOTH records ─────────────
const gReady = { required: true, issue: 42, convergance: true, autowork: true };
const gNoConv = { required: true, issue: 42, convergance: false, autowork: true };
const gNoWork = { required: true, issue: 42, convergance: true, autowork: false };
const gNotReq = { required: false };
ok("gate: required + both -> merges", m._shouldMerge(greenPvBase, reviewed, now, null, gReady).merge === true);
ok("gate: missing convergance -> blocked", m._shouldMerge(greenPvBase, reviewed, now, null, gNoConv).merge === false);
ok("gate: missing convergance names reason", m._shouldMerge(greenPvBase, reviewed, now, null, gNoConv).reason === "needs_convergance_record:#42");
ok("gate: missing autowork -> blocked", m._shouldMerge(greenPvBase, reviewed, now, null, gNoWork).merge === false);
ok("gate: missing autowork names reason", m._shouldMerge(greenPvBase, reviewed, now, null, gNoWork).reason === "needs_autowork_verification:#42");
ok("gate: not required (unassigned) -> merges", m._shouldMerge(greenPvBase, reviewed, now, null, gNotReq).merge === true);
ok("gate: null gate -> merges (back-compat)", m._shouldMerge(greenPvBase, reviewed, now, null, null).merge === true);
// The gate only applies once the normal gates pass — a draft assigned PR still blocks on draft, not the gate.
ok("gate: draft still blocks before gate", m._shouldMerge({ isDraft: true, mergeable: "MERGEABLE", statusCheckRollup: green }, reviewed, now, null, gNoConv).reason === "draft");

console.log(`\n${pass} checks passed`);
