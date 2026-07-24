"use strict";
// #2853 live wiring — the grounding tick in stream-chat.js now composes
// grounding-calibration.readEvents() → regrounding-scheduler.isRegroundingDue(key, ...), keyed
// by `agent:<id>` (the SAME key grounding-calibration writes). This test exercises that exact
// composition against a real on-disk ledger (minus the SSE plumbing): a fittable per-key ρ
// yields a DERIVED EOQ cadence; an unknown/unfittable key falls back to the constant tick — so
// behavior is unchanged until longitudinal per-key data exists.
//
// Run: node test/regrounding-live-wiring.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readEvents } = require("../lib/grounding-calibration");
const { isRegroundingDue } = require("../lib/regrounding-scheduler");
const { GROUNDING_TICK_MS } = require("../lib/grounding-policy");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const HOUR = 3600 * 1000;
const t0 = Date.parse("2026-07-01T00:00:00Z");
const KEY = "agent:unisona.ai"; // matches `agent:${agent.id||agent.name||"keystone"}` in stream-chat

// Seed a real ledger at the exact path readEvents(root) reads (root/data/convergence/…).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reground-live-"));
fs.mkdirSync(path.join(root, "data", "convergence"), { recursive: true });
fs.writeFileSync(
  path.join(root, "data", "convergence", "grounding-calibration.jsonl"),
  [
    { key: KEY, predicted: 0.9, outcome: 1, ts: new Date(t0).toISOString(), source: "web" },
    // success → failure 100h later = one fittable flip over 100h exposure → ρ fittable
    { key: KEY, predicted: 0.9, outcome: 0, ts: new Date(t0 + 100 * HOUR).toISOString(), source: "web" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n"
);

check("readEvents reads the calibration ledger the live tick feeds the scheduler", () => {
  const rows = readEvents(root);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].key, KEY);
  assert.strictEqual(rows[1].outcome, 0);
});

check("live composition derives a per-key EOQ cadence (≠ constant) when ρ is fittable", () => {
  const rows = readEvents(root);
  const r = isRegroundingDue(KEY, t0 + 200 * HOUR, { calRows: rows, nowMs: t0 + 300 * HOUR });
  assert.strictEqual(r.derived, true, "a fittable ρ must yield a derived cadence");
  assert.ok(r.cadenceMs > 0 && r.cadenceMs !== GROUNDING_TICK_MS, "cadence overrides the constant");
});

check("unknown agent key falls back to the constant GROUNDING_TICK_MS (unchanged behavior)", () => {
  const rows = readEvents(root);
  const r = isRegroundingDue("agent:nobody", 0, { calRows: rows, nowMs: t0 });
  assert.strictEqual(r.derived, false);
  assert.strictEqual(r.cadenceMs, GROUNDING_TICK_MS);
  assert.strictEqual(r.due, true); // never grounded → due now, exactly as isGroundingDue behaved
});

check("empty/missing ledger → constant fallback (a fresh box never breaks)", () => {
  const rows = readEvents(path.join(root, "does-not-exist"));
  assert.deepStrictEqual(rows, []);
  const r = isRegroundingDue(KEY, t0, { calRows: rows, nowMs: t0 + GROUNDING_TICK_MS + 1 });
  assert.strictEqual(r.derived, false);
  assert.strictEqual(r.cadenceMs, GROUNDING_TICK_MS);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
