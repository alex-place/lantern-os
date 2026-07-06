// #2145 — the continual-improvement flywheel must be wired into server.js, but
// stay OFF by default and never dispatch a GPU training run without the gate.
//
// This test verifies the two safety properties without booting the server or
// firing a real weekly pass:
//   1. server.js arms the scheduler ONLY behind SIGMA0_IMPROVEMENT_SCHEDULER === "1"
//      (default off) — asserted against the source, so a future refactor that
//      drops the gate reddens here.
//   2. maybeDispatchTraining() returns below_threshold (no dispatch) when the
//      promoted-pattern count is under TRAINING_PROMOTE_THRESHOLD — the internal
//      gate that keeps "schedule" from meaning "train".

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cron = require("../lib/self-improvement-cron");

(async () => {
  // (0) Public surface exists.
  assert.strictEqual(typeof cron.startImprovementScheduler, "function",
    "startImprovementScheduler must be exported");
  assert.strictEqual(typeof cron.maybeDispatchTraining, "function",
    "maybeDispatchTraining must be exported");

  // (1) server.js gates the scheduler default-off behind the env flag.
  const serverSrc = fs.readFileSync(
    path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/startImprovementScheduler/.test(serverSrc),
    "server.js must call startImprovementScheduler");
  assert.ok(/SIGMA0_IMPROVEMENT_SCHEDULER\s*===\s*["']1["']/.test(serverSrc),
    "scheduler must be gated behind SIGMA0_IMPROVEMENT_SCHEDULER === '1' (default off)");

  // (2) No GPU dispatch below the promote threshold, even with 0 promoted.
  process.env.TRAINING_PROMOTE_THRESHOLD = "999";
  const result = await cron.maybeDispatchTraining(repoRoot, 0);
  assert.strictEqual(result.trainingDispatched, false,
    "maybeDispatchTraining must NOT dispatch below threshold");
  assert.strictEqual(result.reason, "below_threshold",
    `expected below_threshold, got ${result.reason}`);

  console.log("flywheel-scheduler-wiring.test.js: OK");
})().catch((err) => {
  console.error("flywheel-scheduler-wiring.test.js: FAIL");
  console.error(err);
  process.exit(1);
});
