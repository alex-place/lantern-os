"use strict";

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");
const {
  packAndUploadCheckpoint,
  dispatchTrainingJob,
  rotateProvider,
  loadGpuPcsf,
} = require("./training-dispatcher");

// Σ₀ principle: every claim persisted here must carry [claim, evidence, confidence, source].

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isoNow() {
  return new Date().toISOString();
}

// Reads every *.jsonl in a directory, returns parsed records (bad lines silently skipped).
function readJsonlDir(dirPath) {
  let records = [];
  let files;
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return records;
  }
  for (const f of files) {
    const raw = safeReadFile(path.join(dirPath, f));
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch { /* malformed line — skip */ }
    }
  }
  return records;
}

function readJsonlFile(filePath) {
  const raw = safeReadFile(filePath);
  const out = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      out.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  return out;
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  } catch {
    return "";
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Loads records from data/convergence/*.jsonl — the canonical location for convergence data.
// Falls back to data/convergence-records.jsonl (legacy flat file) if the directory is empty.
function loadConvergenceRecords(repoRoot) {
  const dirPath = path.join(repoRoot, "data", "convergence");
  const records = readJsonlDir(dirPath);
  if (records.length === 0) {
    return readJsonlFile(path.join(repoRoot, "data", "convergence-records.jsonl"));
  }
  return records;
}

// Returns true when a record's timestamp field is older than `days` days.
function isOlderThan(record, days) {
  const ts = record.timestamp || record.ts || record.convergedAt || null;
  if (!ts) return false;
  const age = Date.now() - new Date(ts).getTime();
  return age > days * 24 * 60 * 60 * 1000;
}

// Returns true when a record has been recently re-verified (within 30 days).
function isRecentlyVerified(record) {
  if (!record.verified) return false;
  const note = record.verification_notes;
  if (note && note.verifiedAt) {
    return !isOlderThan({ timestamp: note.verifiedAt }, 30);
  }
  // verified=true but no timestamp — assume it's recent enough to skip
  return true;
}

/**
 * minePatterns — scans convergence records for high/low-confidence outcomes,
 * writes a summary so the system can reinforce what works and flag what fails.
 */
async function minePatterns(repoRoot) {
  const records = loadConvergenceRecords(repoRoot);

  const highConfidence = records.filter(
    (r) => typeof r.confidence === "number" && r.confidence >= 0.8 && r.status !== "failed"
  );
  const lowConfidence = records.filter(
    (r) =>
      (typeof r.confidence === "number" && r.confidence < 0.4) ||
      r.status === "failed"
  );

  // "Promoted" = high-confidence records that have a result and were verified — safest to learn from.
  const promoted = highConfidence.filter((r) => r.result && r.verified).length;

  const outPath = path.join(
    repoRoot, "data", "self-improvement",
    `patterns-${today()}.json`
  );

  const summary = {
    minedAt: isoNow(),
    source: "data/convergence",
    totalScanned: records.length,
    highConfidence: highConfidence.map((r) => ({
      id: r.id || null,
      reasoner: r.reasoner || r.agent || null,
      confidence: r.confidence,
      verified: r.verified || false,
      timestamp: r.timestamp || r.ts || null,
    })),
    lowConfidence: lowConfidence.map((r) => ({
      id: r.id || null,
      reasoner: r.reasoner || r.agent || null,
      confidence: r.confidence || null,
      status: r.status || null,
      timestamp: r.timestamp || r.ts || null,
    })),
    promoted,
  };

  writeJson(outPath, summary);
  return { patterns: records.length, promoted };
}

/**
 * scoreTools — reads tool-usage-log.jsonl, computes per-tool performance over
 * the last 7 days, and writes a ranked JSON so callers know which tools to prefer.
 */
async function scoreTools(repoRoot) {
  const logPath = path.join(repoRoot, "data", "tool-usage-log.jsonl");
  const allEntries = readJsonlFile(logPath);

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = allEntries.filter((e) => {
    const ts = e.timestamp || e.ts || null;
    return ts && new Date(ts).getTime() >= cutoff;
  });

  const byTool = {};
  for (const entry of recent) {
    const tool = entry.tool || "unknown";
    if (!byTool[tool]) byTool[tool] = { callCount: 0, successes: 0, totalLatency: 0 };
    byTool[tool].callCount += 1;
    if (entry.success) byTool[tool].successes += 1;
    if (typeof entry.latencyMs === "number") byTool[tool].totalLatency += entry.latencyMs;
  }

  const ranking = Object.entries(byTool)
    .map(([tool, stats]) => ({
      tool,
      callCount: stats.callCount,
      successRate: stats.callCount > 0 ? stats.successes / stats.callCount : 0,
      avgLatencyMs: stats.callCount > 0 ? Math.round(stats.totalLatency / stats.callCount) : null,
      // composite score: success rate weighted higher than speed so correctness wins
      score: (stats.callCount > 0 ? stats.successes / stats.callCount : 0) -
             (stats.totalLatency / (stats.callCount || 1)) / 100_000,
    }))
    .sort((a, b) => b.score - a.score);

  const outPath = path.join(repoRoot, "data", "self-improvement", "tool-scores.json");
  writeJson(outPath, {
    scoredAt: isoNow(),
    windowDays: 7,
    entriesScanned: allEntries.length,
    entriesInWindow: recent.length,
    ranking,
  });

  return ranking;
}

/**
 * decayStaleMemories — finds convergence records older than 30 days that haven't
 * been re-verified. Writes a decay report listing items that need re-grounding.
 * This is not deletion — it's a prompt for re-verification (Σ₀ external reality rule).
 */
async function decayStaleMemories(repoRoot) {
  const records = loadConvergenceRecords(repoRoot);

  const stale = records.filter(
    (r) => isOlderThan(r, 30) && !isRecentlyVerified(r)
  );

  const outPath = path.join(
    repoRoot, "data", "self-improvement",
    `decay-report-${today()}.json`
  );

  writeJson(outPath, {
    reportedAt: isoNow(),
    totalScanned: records.length,
    staleCount: stale.length,
    staleItems: stale.map((r) => ({
      id: r.id || null,
      hypothesis: typeof r.hypothesis === "string"
        ? r.hypothesis.slice(0, 120)
        : null,
      confidence: r.confidence || null,
      timestamp: r.timestamp || r.ts || null,
      verified: r.verified || false,
      // Σ₀: every stale item carries the claim that it needs re-verification + evidence of age
      needsReVerification: {
        claim: "record is older than 30 days without recent verification",
        evidence: `timestamp=${r.timestamp || r.ts}`,
        confidence: 1.0,
        source: "self-improvement-cron/decayStaleMemories",
      },
    })),
  });

  return { stale: stale.length };
}

/**
 * maybeDispatchTraining — called after minePatterns. Dispatches a training job
 * when enough promoted high-confidence records have accumulated since the last run.
 * Reads threshold from TRAINING_PROMOTE_THRESHOLD env (default 20).
 */
async function maybeDispatchTraining(repoRoot, promoted) {
  const pcsf = loadGpuPcsf();
  const threshold = Number(
    process.env.TRAINING_PROMOTE_THRESHOLD
    || pcsf?.promote_threshold_default
    || 20
  );

  if (promoted < threshold) {
    return { trainingDispatched: false, reason: "below_threshold", promoted, threshold };
  }

  // Find latest local checkpoint dir (configurable via OURO_CHECKPOINT_DIR)
  const checkpointDir = process.env.OURO_CHECKPOINT_DIR
    || path.join(repoRoot, "data", "self-improvement", "ouro-checkpoint");

  // Pack and upload checkpoint; proceed even if dir absent (cold start)
  let checkpointUri = null;
  if (fs.existsSync(checkpointDir)) {
    const uploadResult = await packAndUploadCheckpoint(checkpointDir).catch(err => ({
      error: err.message,
    }));
    if (uploadResult.error) {
      console.error("[self-improvement] checkpoint upload failed:", uploadResult.error);
    } else {
      checkpointUri = uploadResult.uri;
    }
  }

  // Pick provider — start from last used, rotate if quota exhausted
  const lastJobsLog = path.join(repoRoot, "data", "self-improvement", "training-jobs.jsonl");
  let lastProvider = "kaggle";
  try {
    const lines = fs.readFileSync(lastJobsLog, "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = JSON.parse(lines[i]);
      if (r.type === "training_dispatch" && r.provider) { lastProvider = r.provider; break; }
    }
  } catch { /* no log yet — default to kaggle */ }

  const provider = rotateProvider(lastProvider);
  if (!provider) return { trainingDispatched: false, reason: "all_providers_exhausted" };
  const steps = Number(process.env.TRAINING_STEPS || 600);
  const dispatchResult = await dispatchTrainingJob(provider, checkpointUri, steps).catch(err => ({
    error: err.message,
  }));

  if (dispatchResult.error) {
    console.error("[self-improvement] training dispatch failed:", dispatchResult.error);
    return { trainingDispatched: false, reason: dispatchResult.error };
  }

  return {
    trainingDispatched: true,
    provider,
    jobId: dispatchResult.jobId || null,
    status: dispatchResult.status,
    steps,
  };
}

/**
 * runWeeklyImprovement — orchestrates all three mechanisms and appends a summary
 * record to the append-only improvement log.
 */
async function runWeeklyImprovement(repoRoot) {
  const [patternResult, toolRanking, decayResult] = await Promise.all([
    minePatterns(repoRoot).catch((err) => {
      console.error("[self-improvement] minePatterns failed:", err.message);
      return { patterns: 0, promoted: 0 };
    }),
    scoreTools(repoRoot).catch((err) => {
      console.error("[self-improvement] scoreTools failed:", err.message);
      return [];
    }),
    decayStaleMemories(repoRoot).catch((err) => {
      console.error("[self-improvement] decayStaleMemories failed:", err.message);
      return { stale: 0 };
    }),
  ]);

  const trainingResult = await maybeDispatchTraining(repoRoot, patternResult.promoted).catch((err) => {
    console.error("[self-improvement] maybeDispatchTraining failed:", err.message);
    return { trainingDispatched: false, reason: err.message };
  });

  const summary = {
    runAt: isoNow(),
    patterns: patternResult.patterns,
    promoted: patternResult.promoted,
    toolsScored: toolRanking.length,
    staleMemories: decayResult.stale,
    ...trainingResult,
  };

  const logPath = path.join(repoRoot, "data", "self-improvement", "improvement-log.jsonl");
  await appendJsonlQueued(logPath, summary);

  return summary;
}

/**
 * startImprovementScheduler — sets up the weekly interval and runs immediately on
 * first boot if the log is absent or the last recorded run is more than 7 days old.
 */
function startImprovementScheduler(repoRoot, intervalMs = 604_800_000) {
  const logPath = path.join(repoRoot, "data", "self-improvement", "improvement-log.jsonl");

  function shouldRunNow() {
    const entries = readJsonlFile(logPath);
    if (entries.length === 0) return true;
    const last = entries[entries.length - 1];
    const lastRun = new Date(last.runAt).getTime();
    return Date.now() - lastRun > 7 * 24 * 60 * 60 * 1000;
  }

  if (shouldRunNow()) {
    // Fire asynchronously so server startup isn't blocked
    setImmediate(() => {
      runWeeklyImprovement(repoRoot).catch((err) => {
        console.error("[self-improvement] initial run failed:", err.message);
      });
    });
  }

  const handle = setInterval(() => {
    runWeeklyImprovement(repoRoot).catch((err) => {
      console.error("[self-improvement] scheduled run failed:", err.message);
    });
  }, intervalMs);

  // Allow process to exit normally even if the interval is still registered
  if (handle.unref) handle.unref();

  return () => clearInterval(handle);
}

module.exports = {
  minePatterns,
  scoreTools,
  decayStaleMemories,
  maybeDispatchTraining,
  runWeeklyImprovement,
  startImprovementScheduler,
};
