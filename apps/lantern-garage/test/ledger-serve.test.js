"use strict";

/**
 * test/ledger-serve.test.js — serve-from-ledger + answer-stability canary (#2859).
 *
 * The deterministic-from-outside invariant in unit form:
 *   - exact-normalized-question matching (a miss is a miss — no fuzzy hits)
 *   - only converged claims serve (confidence-gated, never refuted/corrected)
 *   - the served answer is byte-stable across row order (determinism)
 *   - the canary alarms ONLY on movement without an evidence delta
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/ledger-serve.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { normalizeQuestion, buildIndex, serveFromLedger } = require("../lib/ledger-serve");
const { runCanary } = require("../lib/answer-stability-canary");

const row = (over = {}) => ({
  timestamp: "2026-07-21T00:00:00Z",
  claim: "unisona.ai runs locally",
  confidence: 0.9,
  source: "codebase-grep",
  refuted: false,
  corrected: false,
  userMessage: "does it run locally?",
  ...over,
});

function ledgerFile(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-serve-"));
  const file = path.join(dir, "records.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
const serveOpts = (file) => ({ file, force: true });

test("normalizeQuestion: case / whitespace / terminal punctuation insensitive", () => {
  assert.equal(normalizeQuestion("  What   model is THIS?? "), "what model is this");
  assert.equal(normalizeQuestion("what model is this"), normalizeQuestion("What model is this?!"));
  assert.equal(normalizeQuestion(null), "");
});

test("serve hit: aggregates the question's converged claims verbatim + provenance", () => {
  const file = ledgerFile([
    row({ claim: "claim A", timestamp: "2026-07-20T00:00:00Z" }),
    row({ claim: "claim B", timestamp: "2026-07-21T00:00:00Z", confidence: 0.85, source: "web" }),
  ]);
  const s = serveFromLedger("Does it run locally??", serveOpts(file));
  assert.ok(s && s.servedFromLedger);
  assert.equal(s.answer, "claim A\nclaim B", "claims verbatim, timestamp order");
  assert.equal(s.provenance.recordCount, 2);
  assert.equal(s.provenance.asOf, "2026-07-21T00:00:00Z");
  assert.deepEqual(s.provenance.sources, ["codebase-grep", "web"]);
});

test("gates: refuted / corrected / below-confidence claims never serve; a fully-gated question is a MISS", () => {
  const file = ledgerFile([
    row({ claim: "refuted claim", refuted: true }),
    row({ claim: "corrected claim", corrected: true }),
    row({ claim: "hedge", confidence: 0.6 }),
  ]);
  assert.equal(serveFromLedger("does it run locally", serveOpts(file)), null, "nothing converged → regenerate path");
});

test("unknown question is a miss — exact-key matching, no fuzzy hits", () => {
  const file = ledgerFile([row()]);
  assert.equal(serveFromLedger("does it run local", serveOpts(file)), null, "near-miss text is NOT the same question");
});

test("determinism: served answer is byte-identical regardless of ledger row order; duplicates dedupe to latest", () => {
  const a = row({ claim: "claim A", timestamp: "2026-07-20T00:00:00Z" });
  const b = row({ claim: "claim B", timestamp: "2026-07-21T00:00:00Z" });
  const dupA = row({ claim: "claim A", timestamp: "2026-07-22T00:00:00Z", confidence: 0.95 });
  const s1 = serveFromLedger("does it run locally", serveOpts(ledgerFile([a, b, dupA])));
  const s2 = serveFromLedger("does it run locally", serveOpts(ledgerFile([dupA, a, b])));
  assert.equal(s1.answerHash, s2.answerHash, "row order cannot change the answer");
  assert.equal(s1.recordHash, s2.recordHash);
  assert.equal(s1.provenance.recordCount, 2, "duplicate claim text collapsed to its latest instance");
  assert.equal(s1.provenance.maxConfidence, 0.95);
});

test("buildIndex keys rows per normalized question", () => {
  const idx = buildIndex([row(), row({ userMessage: "what model is this", claim: "the Spiral" })]);
  assert.equal(idx.size, 2);
  assert.ok(idx.has("does it run locally"));
  assert.ok(idx.has("what model is this"));
});

// ── the canary ──────────────────────────────────────────────────────────────

const served = (answerHash, recordHash) => (q) =>
  q === "covered?" ? { key: "covered", answerHash, recordHash, provenance: { recordCount: 1 } } : null;

test("canary baseline → stable: identical serve twice = stability 1, no alarms", () => {
  const first = runCanary({ questions: ["covered?"], serve: served("a1", "r1"), now: () => 0 });
  assert.equal(first.rows[0].status, "baseline");
  const second = runCanary({ questions: ["covered?"], priorRows: first.rows, serve: served("a1", "r1"), now: () => 0 });
  assert.equal(second.rows[0].status, "stable");
  assert.equal(second.stability, 1);
  assert.equal(second.alarms.length, 0);
});

test("canary ALARM: answer moved WITHOUT an evidence delta = unstable (the M1 violation)", () => {
  const prior = runCanary({ questions: ["covered?"], serve: served("a1", "r1"), now: () => 0 });
  const drift = runCanary({ questions: ["covered?"], priorRows: prior.rows, serve: served("a2", "r1"), now: () => 0 });
  assert.equal(drift.rows[0].status, "unstable");
  assert.equal(drift.alarms.length, 1);
  assert.equal(drift.stability, 0);
});

test("canary receipt: answer moved WITH an evidence delta = changed-evidence, NOT an alarm", () => {
  const prior = runCanary({ questions: ["covered?"], serve: served("a1", "r1"), now: () => 0 });
  const legit = runCanary({ questions: ["covered?"], priorRows: prior.rows, serve: served("a2", "r2"), now: () => 0 });
  assert.equal(legit.rows[0].status, "changed-evidence");
  assert.equal(legit.alarms.length, 0);
});

test("canary ALARM: coverage lost (converged answer fell back to regeneration)", () => {
  const prior = runCanary({ questions: ["covered?"], serve: served("a1", "r1"), now: () => 0 });
  const lost = runCanary({ questions: ["covered?"], priorRows: prior.rows, serve: () => null, now: () => 0 });
  assert.equal(lost.rows[0].status, "coverage-lost");
  assert.equal(lost.alarms.length, 1);
});

test("canary end-to-end against a REAL ledger file (no injection)", () => {
  const file = ledgerFile([row({ userMessage: "covered?", claim: "yes" })]);
  const first = runCanary({ questions: ["covered?", "never asked?"], ledgerFile: file, now: () => 0 });
  assert.equal(first.rows[0].status, "baseline");
  assert.equal(first.rows[1].status, "uncovered");
  const second = runCanary({ questions: ["covered?", "never asked?"], priorRows: first.rows, ledgerFile: file, now: () => 0 });
  assert.equal(second.rows[0].status, "stable");
  assert.equal(second.stability, 1);
});
