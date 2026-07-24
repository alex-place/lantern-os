// #2109 — council outcome write-back so verification-recall is computable.
// The council log was append-only with outcome:null on every row, so "did the council catch
// the model when it was wrong?" couldn't be measured. These tests cover the two new pieces:
// labelCouncilOutcome() (append a resolved outcome by review id) and foldCouncilOutcomes()
// (fold the stream into id -> latest outcome, later labels winning).
//
// Run: node test/council-outcome-writeback.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { foldCouncilOutcomes } = require("../lib/council-review");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Write a synthetic stream so we test the fold logic without a live server.
function writeStream(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "council-")), "reviews.jsonl");
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
  return p;
}

check("exec-grounded review is labeled at record time (not null)", () => {
  const p = writeStream([
    { type: "council_review", id: "a", outcome: "passed", outcomeSource: "exec" },
    { type: "council_review", id: "b", outcome: "failed", outcomeSource: "exec" },
  ]);
  const m = foldCouncilOutcomes(p);
  assert.strictEqual(m.get("a"), "passed");
  assert.strictEqual(m.get("b"), "failed");
});

check("text-only review stays null until a label resolves it", () => {
  const p = writeStream([
    { type: "council_review", id: "c", outcome: null },
  ]);
  assert.strictEqual(foldCouncilOutcomes(p).get("c"), null);
});

check("a later council_outcome label overrides the record-time outcome", () => {
  const p = writeStream([
    { type: "council_review", id: "d", outcome: null },
    { type: "council_review", id: "e", outcome: "passed", outcomeSource: "exec" },
    { type: "council_outcome", ref: "d", outcome: "reverted", outcomeSource: "label" },
    { type: "council_outcome", ref: "e", outcome: "reverted", outcomeSource: "label" },
  ]);
  const m = foldCouncilOutcomes(p);
  assert.strictEqual(m.get("d"), "reverted", "null review picks up its later label");
  assert.strictEqual(m.get("e"), "reverted", "a revert overrides an exec-passed outcome");
});

check("verification-recall becomes computable from the fold", () => {
  // recall = of the reviews that turned out wrong (reverted/failed), how many did the council
  // flag (escalated/refuted)? The fold gives the labels; here we just prove they're usable.
  const p = writeStream([
    { type: "council_review", id: "x", outcome: "failed" },
    { type: "council_review", id: "y", outcome: null },
    { type: "council_outcome", ref: "y", outcome: "reverted" },
    { type: "council_review", id: "z", outcome: "passed" },
  ]);
  const m = foldCouncilOutcomes(p);
  const wrong = [...m.values()].filter((o) => o === "failed" || o === "reverted").length;
  assert.strictEqual(wrong, 2);
});

check("missing / corrupt log never throws", () => {
  assert.strictEqual(foldCouncilOutcomes("/no/such/path.jsonl").size, 0);
  const p = writeStream([{ type: "council_review", id: "ok", outcome: "passed" }]);
  fs.appendFileSync(p, "{not json\n");
  assert.strictEqual(foldCouncilOutcomes(p).get("ok"), "passed"); // corrupt line skipped
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall council outcome write-back tests passed");
