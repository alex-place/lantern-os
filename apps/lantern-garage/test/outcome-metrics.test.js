// #1411 — outcome metric computation (verified-patch / honesty / route-quality).
// Pure functions over parsed records; locks the honesty rule (no data → null +
// status:"insufficient_data", never a fabricated rate).
//
// Run: node apps/lantern-garage/test/outcome-metrics.test.js
const assert = require("assert");
const m = require("../lib/outcome-metrics");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// ── verifiedPatchRate ───────────────────────────────────────────────────────────
check("verified flag + pass result both count as verified", () => {
  const r = m.verifiedPatchRate([
    { verified: true }, { verified: false },
    { result: "tests passed" }, { result: "apply_failed" },
  ]);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.verified, 2);
  assert.strictEqual(r.rate, 0.5);
  assert.strictEqual(r.status, "ok");
});

check("no records → insufficient_data, null rate (no fabrication)", () => {
  const r = m.verifiedPatchRate([]);
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.status, "insufficient_data");
});

// ── honestyRate ─────────────────────────────────────────────────────────────────
check("anchored vs confident-but-unanchored", () => {
  const r = m.honestyRate([
    { grounded: true, groundedBy: "execution" },
    { grounded: true, groundedBy: "anchor" },
    { grounded: false, groundedBy: "none" },   // the 42-state
    { grounded: false },                          // unsupported, no anchor
  ]);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.anchored, 2);
  assert.strictEqual(r.unsupported, 2);
  assert.strictEqual(r.rate, 0.5);
});

check("honesty with no reviews → insufficient_data", () => {
  const r = m.honestyRate([]);
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.status, "insufficient_data");
});

// ── routeQuality ────────────────────────────────────────────────────────────────
check("escalation rate + latency from leaderboard", () => {
  const r = m.routeQuality(
    [{ escalate: true }, { escalate: false }, { escalate: false }, { escalate: true }],
    [{ sec_per_problem: 2 }, { sec_per_problem: 4 }, { sec_per_problem: null }]);
  assert.strictEqual(r.decisions, 4);
  assert.strictEqual(r.escalations, 2);
  assert.strictEqual(r.escalationRate, 0.5);
  assert.strictEqual(r.avgLatencySec, 3);
  assert.strictEqual(r.latencySamples, 2);
});

check("route quality reports uninstrumented fields honestly", () => {
  const r = m.routeQuality([{ escalate: false }], []);
  assert.strictEqual(r.cost.status, "not_instrumented");
  assert.strictEqual(r.rePromptRate.status, "not_instrumented");
  assert.strictEqual(r.avgLatencySec, null);
});

check("no decisions → insufficient_data", () => {
  const r = m.routeQuality([], []);
  assert.strictEqual(r.escalationRate, null);
  assert.strictEqual(r.status, "insufficient_data");
});

// ── distillationFlywheelMetrics (#1421/#1555) ───────────────────────────────────
// Reuses keystone-escalation.js's readRolloverShare() — only adds a corpus-size number
// and packages both as one tile-ready metric. Not re-testing readRolloverShare's own
// aggregation logic here (that's keystone-escalation's test file); this checks the wiring.
check("counts only escalation-distill pairs, ignores other distill sources", () => {
  const pairs = [
    { meta: { source: "escalation-distill" } },
    { meta: { source: "escalation-distill" } },
    { meta: { source: "some-other-pipeline" } },
    { meta: {} },
    {},
  ];
  const r = m.distillationFlywheelMetrics(pairs, []);
  assert.strictEqual(r.corpusSize, 2);
});

check("no corpus + no landed work → insufficient_data", () => {
  const r = m.distillationFlywheelMetrics([], []);
  assert.strictEqual(r.corpusSize, 0);
  assert.strictEqual(r.status, "insufficient_data");
});

check("landed work with zero corpus still reports ok (share/escalation known, corpus just empty)", () => {
  const records = [
    { reasoner: "keystone-kernel", result: "landed-by-ollama/ouro", timestamp: new Date().toISOString() },
    { reasoner: "keystone-kernel", result: "landed-by-anthropic/claude", timestamp: new Date().toISOString() },
  ];
  const r = m.distillationFlywheelMetrics([], records);
  assert.strictEqual(r.corpusSize, 0);
  assert.strictEqual(r.landed, 2);
  assert.strictEqual(r.keystoneShare, 0.5);
  assert.strictEqual(r.status, "ok");
});

check("computeOutcomeMetrics wires distillationFlywheel into the aggregate output", () => {
  const out = m.computeOutcomeMetrics("/no/such/repo/root");
  assert.ok(out.distillationFlywheel);
  assert.strictEqual(out.distillationFlywheel.status, "insufficient_data"); // empty repo root
});

// ── adaptiveDepthMetrics (#1423) — Q-exit gate telemetry, native-mode runs only ─────
check("no ouro-deep rows -> insufficient_data, no fabricated depth", () => {
  const r = m.adaptiveDepthMetrics([{ benchmark: "other-bench", mean_depth: 3 }]);
  assert.strictEqual(r.n, 0);
  assert.strictEqual(r.meanDepth, null);
  assert.strictEqual(r.status, "insufficient_data");
});

check("aggregates mean depth, exit reasons, and canary signal rate from ouro-deep rows only", () => {
  const rows = [
    { benchmark: "ouro-deep", mean_depth: 2, exit_reason: "adaptive_qexit", canary_signal: "none" },
    { benchmark: "ouro-deep", mean_depth: 4, exit_reason: "adaptive_qexit", canary_signal: "echo" },
    { benchmark: "ouro-deep", mean_depth: 6, exit_reason: "convergence_exit", canary_signal: "none" },
    { benchmark: "other-bench", mean_depth: 99, exit_reason: "ignored", canary_signal: "ignored" },
  ];
  const r = m.adaptiveDepthMetrics(rows);
  assert.strictEqual(r.n, 3);
  assert.strictEqual(r.meanDepth, 4); // (2+4+6)/3, other-bench row excluded
  assert.deepStrictEqual(r.exitReasons, { adaptive_qexit: 2, convergence_exit: 1 });
  assert.strictEqual(r.canarySignalRate, 1 / 3);
  assert.strictEqual(r.status, "ok");
});

check("computeOutcomeMetrics wires adaptiveDepth into the aggregate output", () => {
  const out = m.computeOutcomeMetrics("/no/such/repo/root");
  assert.ok(out.adaptiveDepth);
  assert.strictEqual(out.adaptiveDepth.status, "insufficient_data"); // empty repo root
});

// ── readJsonl is resilient to bad lines / missing files ─────────────────────────
check("readJsonl returns [] for a missing file", () =>
  assert.deepStrictEqual(m.readJsonl("/no/such/file.jsonl"), []));

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall outcome-metrics checks passed\n");
