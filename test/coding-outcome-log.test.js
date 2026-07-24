"use strict";
// Router-corpus logger (#2798): logs one row per coding turn where the exec-verify gate
// RAN, carrying the real verified label. Run: node test/coding-outcome-log.test.js
const assert = require("assert");
const os = require("os");
const path = require("path");
const { logCodingOutcome } = require("../lib/coding-outcome-log");

(async () => {
  const tmp = path.join(os.tmpdir(), `coding-outcome-${Date.now()}.jsonl`);

  // Only rows carrying a REAL verified label (exec_ran === true) are logged.
  assert.strictEqual(await logCodingOutcome({ exec_ran: false, path: tmp }), null, "exec_ran:false -> null");
  assert.strictEqual(await logCodingOutcome({ path: tmp }), null, "no exec_ran -> null");

  // A real outcome yields the router-corpus row with the verified label + normalized fields.
  const row = await logCodingOutcome({
    exec_ran: true, exec_passed: true, intent: "coding_change", taskType: "coding",
    provider: "openai", source: "openai", model: "gpt-4.1-mini", tier: "cloud",
    latencyMs: 1234.7, path: tmp,
  });
  assert(row && row.exec_ran === true, "row logged");
  assert.strictEqual(row.exec_passed, true, "verified label captured (the router's y)");
  assert.strictEqual(row.tier, "cloud");
  assert.strictEqual(row.latency_ms, 1235, "latency rounded");
  assert.strictEqual(row.intent, "coding_change");
  assert.strictEqual(row.task_type, "coding");

  // A FAILED test is a valid (negative) label — kept, not dropped.
  const fail = await logCodingOutcome({ exec_ran: true, exec_passed: false, latencyMs: "bad", path: tmp });
  assert.strictEqual(fail.exec_passed, false, "negative label kept");
  assert.strictEqual(fail.latency_ms, null, "bad latency -> null field, no throw");

  // Never throws on garbage.
  assert.strictEqual(await logCodingOutcome(null), null, "null input -> null, no throw");
  assert.strictEqual(await logCodingOutcome(undefined), null, "undefined input -> null, no throw");

  console.log("coding-outcome-log: all assertions passed");
})().catch((e) => { console.error("FAIL:", e && e.message); process.exit(1); });
