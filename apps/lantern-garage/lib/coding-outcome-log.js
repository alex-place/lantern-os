"use strict";
// Router corpus logger (#2798) — one row per coding turn where the exec-verify GATE RAN,
// carrying the real VERIFIED label a cascade-router (RouteLLM/FrugalGPT/cascade-routing)
// trains on: [intent, tier/provider/model, exec pass/fail, latency]. This is the labeled
// data neither the convergance records (reasoning claims, wrong shape) nor the pcsf
// receipts (success = 99.9% "responded", not "correct") provide — see the #2798 audit.
//
// Only rows where a real test EXECUTED are logged (exec_ran === true) — a row without a
// verified label is not router-training data. Best-effort: a failed log must NEVER break a
// chat reply (every path returns, never throws).

const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const OUT_REL = "data/convergence/coding-outcomes.jsonl";
const OUT_PATH = path.resolve(__dirname, "..", "..", "..", OUT_REL);

/**
 * Append one router-corpus row. Returns the row (also on the no-op/null paths, returns
 * null) — never throws.
 * @param {object} o
 *   exec_ran {boolean}   REQUIRED true — a real test executed (else this is not a label)
 *   exec_passed {boolean} the VERIFIED label — did the test pass? (the router's y)
 *   intent, taskType, provider, source, model, tier, latencyMs, surface
 *   path {string} [test only] override the output file
 */
async function logCodingOutcome(o = {}) {
  try {
    if (!o || o.exec_ran !== true) return null; // only rows carrying a real verified label
    const row = {
      ts: new Date().toISOString(),
      intent: o.intent == null ? null : String(o.intent),
      task_type: o.taskType == null ? null : String(o.taskType),
      provider: o.provider == null ? null : String(o.provider),
      source: o.source == null ? null : String(o.source),
      model: o.model == null ? null : String(o.model),
      tier: o.tier == null ? null : String(o.tier), // cloud | local | cpu
      exec_ran: true,
      exec_passed: !!o.exec_passed, // the cascade-router's label — un-gameable ground truth
      latency_ms: Number.isFinite(o.latencyMs) ? Math.round(o.latencyMs) : null,
      surface: o.surface || "dream-chat",
    };
    await appendJsonlQueued(o.path || OUT_PATH, row, { rotate: true });
    return row;
  } catch {
    return null; // never throw — logging must not break a reply
  }
}

module.exports = { logCodingOutcome, OUT_PATH, OUT_REL };
