"use strict";
/**
 * Outcome metrics (#1411) — instrument the three Σ₀ "are we actually good?" numbers
 * from append-only logs, so the moat is evidence, not assertion:
 *
 *   1. verified-patch-rate — % of code tasks whose patch applied + tests passed
 *   2. honesty-rate        — anchored/grounded replies vs confident-but-unanchored
 *   3. route-quality       — escalation rate + latency per route
 *
 * Pure compute functions take parsed records (testable, no I/O). computeOutcomeMetrics()
 * reads the live JSONL logs and aggregates. Honesty rule: when a metric has no data we
 * return rate=null with status:"insufficient_data" — never a fabricated number.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

function readJsonl(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8")
      .split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function pct(numer, denom) {
  return denom > 0 ? numer / denom : null;
}

function statusFor(rate, n) {
  if (n === 0 || rate == null) return "insufficient_data";
  return "ok";
}

// 1. Verified patch success rate — code/issue work records that carry a verified flag
// or a pass/fail result. A record counts as a verified patch when verified===true or its
// result reads as a pass.
function verifiedPatchRate(records) {
  const code = (records || []).filter(
    (r) => r && (typeof r.verified === "boolean" || typeof r.result === "string"));
  const passed = code.filter(
    (r) => r.verified === true || /\b(pass|passed|resolved|applied|success|merged)\b/i.test(String(r.result || "")));
  const n = code.length;
  return { n, verified: passed.length, rate: pct(passed.length, n), status: statusFor(pct(passed.length, n), n) };
}

// 2. Honesty rate — from groundedness-canary / council reviews. A reply is "honest" when
// it is anchored (grounded===true or groundedBy is a real anchor), and "unsupported" when
// it is confident-but-unanchored (the 42-state: grounded===false and groundedBy none).
function honestyRate(reviews) {
  const list = (reviews || []).filter((r) => r && typeof r === "object");
  const isAnchored = (r) => r.grounded === true || (r.groundedBy && r.groundedBy !== "none");
  const isUnsupported = (r) => r.grounded === false && (!r.groundedBy || r.groundedBy === "none");
  const anchored = list.filter(isAnchored).length;
  const unsupported = list.filter(isUnsupported).length;
  const n = list.length;
  return { n, anchored, unsupported, rate: pct(anchored, n), status: statusFor(pct(anchored, n), n) };
}

// 3. Route quality — escalation rate from router-gate decisions, latency from the eval
// leaderboard. Cost and user re-prompt rate are not yet instrumented; reported as such
// rather than guessed.
function routeQuality(decisions, leaderboard) {
  const d = (decisions || []).filter((x) => x && typeof x === "object");
  const escalations = d.filter((x) => x.escalate === true).length;
  const lat = (leaderboard || [])
    .map((l) => (l && typeof l.sec_per_problem === "number" ? l.sec_per_problem : null))
    .filter((x) => x != null);
  const avgLatencySec = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  return {
    decisions: d.length,
    escalations,
    escalationRate: pct(escalations, d.length),
    avgLatencySec,
    latencySamples: lat.length,
    cost: { status: "not_instrumented" },
    rePromptRate: { status: "not_instrumented" },
    status: d.length === 0 ? "insufficient_data" : "ok",
  };
}

// 4. Distillation flywheel (#1421/#1555) — is local->cloud escalation actually feeding local
// improvement? Reuses the EXISTING flywheel primitives in keystone-escalation.js
// (recordDistillationPair()'s corpus, readRolloverShare()'s landed-work aggregation) rather
// than a new store — this function only adds the "observable" half that was missing: a
// corpus-size number and the local/cloud landed-work share as one tile-ready metric.
function distillationFlywheelMetrics(distillPairs, convergenceRecords) {
  const { readRolloverShare } = require("./keystone-escalation");
  const share = readRolloverShare(convergenceRecords);
  const corpus = (distillPairs || []).filter((r) => r && r.meta && r.meta.source === "escalation-distill");
  return {
    corpusSize: corpus.length,
    keystoneShare: share.keystoneShare,        // fraction of landed work the LOCAL model won
    escalationRate: share.escalationRate,       // fraction of attempts that had to escalate off local
    landed: share.landed, escalations: share.escalations,
    status: (corpus.length === 0 && share.landed === 0) ? "insufficient_data" : "ok",
  };
}

// 5. Adaptive-depth (Ouro Q-exit) telemetry (#1423) — the recurrent-depth gate already
// computes mean_depth/exit_reason/canary_* per generation (src/sigma0/loop_lm.py) and
// scripts/ouro_serve.py already persists it to the SAME eval leaderboard routeQuality()
// reads for latency (data/eval/leaderboard.jsonl, benchmark:"ouro-deep") — no new store.
// Honest scope: this reflects OURO_NATIVE=1 (native/deep-mode) runs only. The default
// live chat-serving path is the fast cached generate() and never computes this — see
// ADR-0012 for why flipping that default is a product decision, not a bug fix.
function adaptiveDepthMetrics(leaderboardRecords) {
  const rows = (leaderboardRecords || []).filter((r) => r && r.benchmark === "ouro-deep");
  const n = rows.length;
  const depths = rows.map((r) => r.mean_depth).filter((d) => typeof d === "number");
  const meanDepth = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null;
  const exitReasons = {};
  for (const r of rows) {
    const reason = r.exit_reason || "unknown";
    exitReasons[reason] = (exitReasons[reason] || 0) + 1;
  }
  const signaled = rows.filter((r) => r.canary_signal && r.canary_signal !== "none").length;
  return {
    n,
    meanDepth: meanDepth == null ? null : Math.round(meanDepth * 100) / 100,
    exitReasons,
    canarySignalRate: pct(signaled, n),
    status: statusFor(n > 0 ? 1 : null, n),
  };
}

// Aggregate from the live append-only logs.
function computeOutcomeMetrics(repoRoot) {
  const root = repoRoot || DEFAULT_REPO_ROOT;
  const d = (...p) => path.join(root, "data", ...p);

  // Verified patch rate: ONLY genuine code-patch tasks, not the general convergence /
  // chat records (which carry verified flags but aren't patches — counting them would
  // misreport the rate). A record qualifies when it has a PR/branch/actions field or its
  // result/notes describe a patch/test outcome.
  const isPatchRecord = (r) => {
    if (!r || typeof r !== "object") return false;
    if ("pr" in r || "branch" in r || "actions_taken" in r || "fix_plan" in r) return true;
    const blob = `${r.result || ""} ${r.verification_notes || ""}`;
    return /\b(patch|git apply|apply_failed|FAIL_TO_PASS|tests?\s+(passed|failed))\b/i.test(blob);
  };
  const convergenceRecords = readJsonl(d("convergence", "records.jsonl"));
  const patchRecords = [
    ...readJsonl(d("convergence", "issue-work-records.jsonl")),
    ...convergenceRecords,
    ...readJsonl(d("convergence-autonomous-work.jsonl")),
  ].filter(isPatchRecord);
  const reviews = readJsonl(d("convergence", "council-reviews.jsonl"));
  const decisions = readJsonl(d("router-gate-decisions.jsonl"));
  const leaderboard = readJsonl(d("eval", "leaderboard.jsonl"));
  const distillPairs = readJsonl(d("distill", "escalation-wins.jsonl"));

  return {
    generatedAt: new Date().toISOString(),
    verifiedPatchRate: verifiedPatchRate(patchRecords),
    honestyRate: honestyRate(reviews),
    routeQuality: routeQuality(decisions, leaderboard),
    distillationFlywheel: distillationFlywheelMetrics(distillPairs, convergenceRecords),
    adaptiveDepth: adaptiveDepthMetrics(leaderboard),
  };
}

// Baseline: capture the first computed snapshot to data/metrics/outcome-baseline.json so
// later runs can show movement against a fixed reference point (#1411 acceptance).
function loadOrCaptureBaseline(metrics, repoRoot) {
  const root = repoRoot || DEFAULT_REPO_ROOT;
  const dir = path.join(root, "data", "metrics");
  const file = path.join(dir, "outcome-baseline.json");
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    fs.mkdirSync(dir, { recursive: true });
    const baseline = {
      capturedAt: metrics.generatedAt,
      verifiedPatchRate: metrics.verifiedPatchRate.rate,
      honestyRate: metrics.honestyRate.rate,
      escalationRate: metrics.routeQuality.escalationRate,
      // #1421/#1555: local-vs-cloud landed-work share + corpus size at capture time, so
      // "local model closed X% of the gap this week" has a real fixed reference point.
      flywheelKeystoneShare: metrics.distillationFlywheel.keystoneShare,
      flywheelCorpusSize: metrics.distillationFlywheel.corpusSize,
      // #1423: canary-signal rate across native-mode (OURO_NATIVE=1) runs at capture time.
      adaptiveDepthCanaryRate: metrics.adaptiveDepth.canarySignalRate,
    };
    fs.writeFileSync(file, JSON.stringify(baseline, null, 2));
    return baseline;
  } catch { return null; }
}

module.exports = {
  readJsonl,
  verifiedPatchRate,
  honestyRate,
  routeQuality,
  distillationFlywheelMetrics,
  adaptiveDepthMetrics,
  computeOutcomeMetrics,
  loadOrCaptureBaseline,
};
