"use strict";

/**
 * test/m1-gate.test.js — the M1 No-Free-Confidence enforced gate (#2872).
 *
 * The invariant in unit form: confidence on a claim-chain may rise ONLY with a
 * changed evidence fingerprint. Free rises clamp (with a receipt); falls, flats,
 * first sightings, and evidence-backed rises pass untouched. The gate mirrors
 * experiments/v1_10_toy/m1_ledger_check.py so replay and live enforcement agree.
 *
 * Zero-dep — run with:  node --test test/m1-gate.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { applyM1Gate, evidenceKey, _resetForTests } = require("../lib/m1-gate");

const row = (over = {}) => ({
  timestamp: "2026-07-22T00:00:00Z",
  claim: "the sky is blue",
  confidence: 0.6,
  source: "web",
  evidence: "observation A",
  ...over,
});

function ledger(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-gate-"));
  const file = path.join(dir, "records.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

test("free rise CLAMPS to the chain's prior confidence, with a receipt", () => {
  _resetForTests();
  const file = ledger([row()]);
  const out = applyM1Gate(row({ timestamp: "2026-07-23T00:00:00Z", confidence: 0.9 }), { file });
  assert.equal(out.confidence, 0.6, "the rise was free (same evidence) → clamped");
  assert.equal(out.m1_clamped.from, 0.9);
  assert.equal(out.m1_clamped.to, 0.6);
  assert.equal(out.m1_clamped.reason, "no-new-evidence");
});

test("rise WITH a new evidence fingerprint passes untouched", () => {
  _resetForTests();
  const file = ledger([row()]);
  const out = applyM1Gate(row({ timestamp: "2026-07-23T00:00:00Z", confidence: 0.9, source: "exec-test", evidence: "observation B" }), { file });
  assert.equal(out.confidence, 0.9, "paid for by new evidence");
  assert.equal(out.m1_clamped, undefined);
});

test("falls and flats always pass (supermartingale-compatible)", () => {
  _resetForTests();
  const file = ledger([row()]);
  assert.equal(applyM1Gate(row({ confidence: 0.3 }), { file }).confidence, 0.3);
  _resetForTests();
  assert.equal(applyM1Gate(row({ confidence: 0.6 }), { file }).confidence, 0.6);
});

test("first sighting of a claim passes at any confidence", () => {
  _resetForTests();
  const file = ledger([row()]);
  const out = applyM1Gate(row({ claim: "a brand new claim", confidence: 0.95 }), { file });
  assert.equal(out.confidence, 0.95);
});

test("same-batch enforcement: the second row of one batch is gated against the first (no file re-read)", () => {
  _resetForTests();
  const file = ledger([]);
  const a = applyM1Gate(row({ confidence: 0.5 }), { file });
  assert.equal(a.confidence, 0.5, "first sighting");
  const b = applyM1Gate(row({ timestamp: "2026-07-22T00:00:01Z", confidence: 0.8 }), { file });
  assert.equal(b.confidence, 0.5, "free rise within the same batch clamps via the in-process tail");
});

test("claim normalization: case/punctuation variants are ONE chain", () => {
  _resetForTests();
  const file = ledger([row()]);
  const out = applyM1Gate(row({ claim: "The sky is BLUE!!", confidence: 0.9 }), { file });
  assert.equal(out.confidence, 0.6, "normalized to the same chain → still a free rise");
});

test("hypothesis-shaped rows: verified_by change is a new evidence basis; without it a rise clamps", () => {
  _resetForTests();
  const hyp = { timestamp: "2026-07-22T00:00:00Z", hypothesis: "the harness works", confidence: 0.7, source: "run", verified_by: [] };
  const file = ledger([hyp]);
  const paid = applyM1Gate({ ...hyp, timestamp: "2026-07-23T00:00:00Z", confidence: 0.9, verified_by: ["exec:test.js"] }, { file });
  assert.equal(paid.confidence, 0.9, "a new verified_by artifact is new evidence");
  _resetForTests();
  const free = applyM1Gate({ ...hyp, timestamp: "2026-07-23T00:00:00Z", confidence: 0.9 }, { file });
  assert.equal(free.confidence, 0.7, "no artifact → clamped");
});

test("never throws: unreadable file / missing key returns the row unchanged", () => {
  _resetForTests();
  const r = row({ confidence: 0.9 });
  assert.equal(applyM1Gate(r, { file: path.join(os.tmpdir(), "m1-gate-absent", "nope.jsonl") }).confidence, 0.9);
  assert.equal(applyM1Gate({ confidence: 0.9 }, { file: ledger([]) }).confidence, 0.9, "no claim/hypothesis → pass-through");
});

test("evidenceKey mirrors the replay checker: order-insensitive sources, evidence text capped at 400", () => {
  const a = evidenceKey({ sources: ["b", "a"], evidence: "x".repeat(500) });
  const b = evidenceKey({ sources: ["a", "b"], evidence: "x".repeat(400) });
  assert.equal(a, b);
});
