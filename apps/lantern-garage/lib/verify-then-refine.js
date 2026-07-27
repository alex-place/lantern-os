"use strict";

/**
 * Verify-then-refine (#2870) — a fix closes ONLY when the target metric actually
 * recovered, and every outcome feeds the remediation playbook.
 *
 * Precedent: Bowe Bell+Howell remediation (US20100094676A1) — after a corrective
 * action, MEASURE that the failing metric recovered before closing the ticket,
 * and refine the playbook with what worked. This extends the Fix-Rate ratchet's
 * discipline (tests decide, not opinions) from test suites to arbitrary metrics:
 * a latency regression, an error rate, a benchmark score, an eval number.
 *
 * Contract:
 *   openRemediation()  — snapshot the failing metric BEFORE acting (the baseline;
 *                        a fix without a before-reading is unverifiable by
 *                        construction and is refused).
 *   assess()           — direction-aware recovery verdict from a real after-
 *                        reading: recovered iff it strictly improved AND met the
 *                        target when one was declared. No reading, no recovery.
 *   closeOrReopen()    — the only two honest exits: "closed-recovered" or
 *                        "kept-open-not-recovered". There is no "probably fine".
 *   recordOutcome()/playbookFor() — append-only keyed playbook (mirrors the
 *                        #2869 failure-cache shape) so the next remediation of
 *                        the same failure class starts from measured history.
 *
 * Pure module: metric readers are the caller's; file I/O only in the playbook
 * helpers (best-effort, never throws).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let _repoRoot;
try {
  _repoRoot = require("./app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..", "..", "..");
}
const DEFAULT_PLAYBOOK = path.join(_repoRoot, "data", "ops", "remediation-playbook.jsonl");

const sig = (s) =>
  crypto.createHash("sha1").update(String(s || "").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

/**
 * Snapshot the failing state before acting.
 * @param {object} o { failure, metric, baseline, direction: "up"|"down", target? , action? }
 *   direction "up" = recovery means the metric RISES (accuracy); "down" = falls (latency, error rate).
 */
function openRemediation(o = {}) {
  const baseline = Number(o.baseline);
  if (!o.failure || !o.metric || !Number.isFinite(baseline)) {
    throw new Error("openRemediation: failure, metric, and a numeric baseline are required — a fix without a before-reading is unverifiable");
  }
  const direction = o.direction === "down" ? "down" : "up";
  return {
    id: `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    signature: sig(o.failure),
    failure: String(o.failure),
    metric: String(o.metric),
    baseline,
    direction,
    target: o.target == null ? null : Number(o.target),
    action: o.action == null ? null : String(o.action),
    openedAt: new Date().toISOString(),
  };
}

/** Direction-aware recovery verdict from a REAL after-reading. */
function assess(record, after) {
  const a = Number(after);
  if (!Number.isFinite(a)) {
    return { recovered: false, reason: "no-after-reading", delta: null, after: null };
  }
  const delta = a - record.baseline;
  const improved = record.direction === "down" ? a < record.baseline : a > record.baseline;
  const targetMet =
    record.target == null ? true : record.direction === "down" ? a <= record.target : a >= record.target;
  const recovered = improved && targetMet;
  return {
    recovered,
    reason: recovered ? "recovered" : !improved ? "did-not-improve" : "target-not-met",
    delta,
    after: a,
  };
}

/** The only two honest exits. */
function closeOrReopen(record, after) {
  const v = assess(record, after);
  return {
    ...v,
    status: v.recovered ? "closed-recovered" : "kept-open-not-recovered",
    record,
  };
}

/** Append the measured outcome to the keyed playbook (best-effort, never throws). */
function recordOutcome(record, verdict, { file = DEFAULT_PLAYBOOK } = {}) {
  try {
    const row = {
      signature: record.signature,
      failure: record.failure.slice(0, 200),
      metric: record.metric,
      action: record.action,
      baseline: record.baseline,
      after: verdict.after,
      delta: verdict.delta,
      recovered: Boolean(verdict.recovered),
      reason: verdict.reason,
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return row;
  } catch (e) {
    console.error("[verify-then-refine] playbook write failed (non-fatal):", e && e.message);
    return null;
  }
}

/** Measured history for a failure class, newest first (best-effort, never throws). */
function playbookFor(failure, { file = DEFAULT_PLAYBOOK, max = 10 } = {}) {
  try {
    const key = sig(failure);
    const rows = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.signature === key) rows.push(r);
      } catch {
        /* torn tail line */
      }
    }
    return rows.slice(-max).reverse();
  } catch {
    return [];
  }
}

module.exports = { openRemediation, assess, closeOrReopen, recordOutcome, playbookFor, DEFAULT_PLAYBOOK };
