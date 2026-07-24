// #1198 — distillation flywheel capture gate.
// recordDistillationPair must fire ONLY for a verified cloud-teacher landing of an
// ESCALATED task, and write a training pair in the training-data.jsonl schema
// ({instruction, input, output}) so the continual pipeline ingests it directly.
//
// Run: node test/distillation-capture.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { recordDistillationPair, DISTILL_REL } = require("../lib/keystone-escalation");

let failures = 0;
function check(name, fn) {
  try { fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "distill-"));
}
function readRows(repoRoot) {
  const p = path.join(repoRoot, DISTILL_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const WIN = {
  task: "Fix the off-by-one in paginate()",
  plan: "Adjust the slice bound.",
  patch: "--- a/p.js\n+++ b/p.js\n@@\n- end\n+ end + 1\n",
  landedBy: "cloud", verified: true, escalated: true,
  provider: "anthropic", model: "claude-opus-4-8",
};

check("captures a verified cloud escalation win in the right schema", () => {
  const repo = tmpRepo();
  const row = recordDistillationPair({ ...WIN, repoRoot: repo });
  assert.ok(row, "should return a row");
  assert.deepEqual(Object.keys(row).sort(), ["input", "instruction", "meta", "output"]);
  assert.equal(row.instruction, WIN.task);
  assert.equal(row.input, "");
  assert.ok(row.output.includes("end + 1"), "output carries the cloud patch");
  assert.ok(row.output.includes("Plan:"), "output carries the plan");
  assert.equal(row.meta.source, "escalation-distill");
  assert.equal(row.meta.verified, true);
  const onDisk = readRows(repo);
  assert.equal(onDisk.length, 1, "one row appended to disk");
});

check("does NOT capture a local landing", () => {
  const repo = tmpRepo();
  assert.equal(recordDistillationPair({ ...WIN, landedBy: "local", repoRoot: repo }), null);
  assert.equal(readRows(repo).length, 0);
});

check("does NOT capture an unverified cloud landing", () => {
  const repo = tmpRepo();
  assert.equal(recordDistillationPair({ ...WIN, verified: false, repoRoot: repo }), null);
});

check("does NOT capture a cloud win that was NOT escalated (no local attempt)", () => {
  const repo = tmpRepo();
  assert.equal(recordDistillationPair({ ...WIN, escalated: false, repoRoot: repo }), null);
});

check("falls back to plan-only when no patch is present", () => {
  const repo = tmpRepo();
  const row = recordDistillationPair({ ...WIN, patch: null, repoRoot: repo });
  assert.ok(row && row.output.trim().length > 0);
});

check("gates out an empty solution", () => {
  const repo = tmpRepo();
  assert.equal(recordDistillationPair({ ...WIN, patch: null, plan: "  ", repoRoot: repo }), null);
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
