"use strict";

/**
 * test/spiral-failure-cache.test.js — the #2869 failure-mode cache in unit form.
 *
 * The RRO-servo contract: repeatable error (verified failed approaches, keyed by
 * task signature) is recorded on unsolved halts and pre-subtracted as NEGATIVE
 * space next time — never solutions, never a hard block, verifier stays judge.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/spiral-failure-cache.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { signatureOf, recordFailures, avoidFor, renderAvoid, _resetForTests } = require("../lib/spiral-failure-cache");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "failcache-")), "failure-modes.jsonl");
const PROBLEM = { id: "rle", prompt: "function rle(s) — run-length encode, e.g. rle('aaab')==='a3b1'." };

test("signature is stable across whitespace/case variants of the same ask", () => {
  const a = signatureOf(PROBLEM);
  const b = signatureOf({ prompt: "  FUNCTION rle(s) — run-length ENCODE, e.g. rle('aaab')==='a3b1'.  " });
  assert.equal(a, b);
  assert.notEqual(a, signatureOf({ prompt: "function factorial(n)" }));
});

test("record on unsolved halt → avoidFor returns the verified failures, newest first, deduped by approach", () => {
  _resetForTests();
  const file = tmpFile();
  recordFailures(
    { problem: PROBLEM, haltReason: "stalled", stalledCandidates: [
      { text: "function rle(s){return s}", failingTests: ["t0", "t1"] },
      { text: "function rle(s){return s.length}", failingTests: ["t0"] },
    ] },
    { file },
  );
  recordFailures( // second run re-fails the first approach — dedupes to one entry
    { problem: PROBLEM, haltReason: "loop", stalledCandidates: [{ text: "function rle(s){return s}", failingTests: ["t0", "t1", "t2"] }] },
    { file },
  );
  _resetForTests();
  const avoid = avoidFor(PROBLEM, { file });
  assert.equal(avoid.length, 2, "two distinct failed approaches, not three rows");
  const snippets = avoid.map((f) => f.snippet);
  assert.ok(snippets.some((s) => s.includes("return s}")) && snippets.some((s) => s.includes("s.length")));
});

test("unknown signature → empty avoid list; absent file → empty, never throws", () => {
  _resetForTests();
  assert.deepEqual(avoidFor({ prompt: "never seen" }, { file: tmpFile() }), []);
  assert.deepEqual(avoidFor(PROBLEM, { file: path.join(os.tmpdir(), "nope", "absent.jsonl") }), []);
});

test("renderAvoid emits negative space only — snippets + failing tests, no solutions, empty for []", () => {
  const block = renderAvoid([{ snippet: "function rle(s){return s}", failingTests: ["t0"] }]);
  assert.match(block, /do NOT repeat/);
  assert.match(block, /return s\}/);
  assert.match(block, /failed: t0/);
  assert.equal(renderAvoid([]), "");
});

test("solved runs / empty inputs record nothing", () => {
  const file = tmpFile();
  assert.equal(recordFailures({ problem: PROBLEM, haltReason: "solved", stalledCandidates: [] }, { file }), null);
  assert.ok(!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() === "");
});

test("avoid list is capped (negative-space hints, not a corpus dump)", () => {
  _resetForTests();
  const file = tmpFile();
  const cands = Array.from({ length: 8 }, (_, i) => ({ text: `function rle(s){/*v${i}*/}`, failingTests: [] }));
  recordFailures({ problem: PROBLEM, haltReason: "stalled", stalledCandidates: cands }, { file });
  _resetForTests();
  assert.ok(avoidFor(PROBLEM, { file }).length <= 4);
});
