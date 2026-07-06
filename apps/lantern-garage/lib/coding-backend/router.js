"use strict";

// Outcome-based per-repo routing (#2175) — the wedge the OSS baseline found NO router has:
// route by what actually SUCCEEDED on THIS user's repos, learned from the coding-backend's
// own receipts, rather than a pre-generation proxy signal. (RouteLLM / vLLM-semantic-router
// / RoRF all decide before generation and never own the outcome — docs/OSS-BASELINE.md.)
//
// Fed from `coding-receipts.jsonl`: a receipt's final status IS an outcome — `applied` =
// success, `rejected`/`apply_failed` = failure, `proposed` = unresolved (no outcome yet).
// Plus optional explicit outcomes in `coding-outcomes.jsonl` for richer signals (a verifier
// / test result — recordOutcome(), which #2174 will feed). Keyed by (repo, backend,
// taskType). The router picks the backend with the best measured success on this repo+type;
// cold-starts on a default and signals `hasSignal:false` so the caller falls back to the
// answer-first cascade.

const fs = require("fs");
const path = require("path");

let _repoRoot;
try {
  _repoRoot = require("../app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
}
const DEFAULT_DATA_DIR = path.join(_repoRoot, "data");

// ── task-type classification (cheap keyword heuristic) ──────────────────────
// Order matters: earlier patterns win (test before feature so "add a test" → test).
const TASK_TYPES = [
  ["test", /\b(test|spec|unit ?test|coverage|pytest|jest)\b/i],
  ["docs", /\b(doc|docs|readme|comment|docstring|changelog)\b/i],
  ["bugfix", /\b(fix|bug|error|crash|broken|regression|traceback|exception)\b/i],
  ["refactor", /\b(refactor|rename|clean ?up|simplify|extract|inline|reorganize)\b/i],
  ["feature", /\b(add|implement|create|build|feature|support|new)\b/i],
];
function taskTypeOf(task) {
  const t = String(task || "");
  for (const [name, re] of TASK_TYPES) if (re.test(t)) return name;
  return "other";
}

// Repo identity: an explicit id wins; else the directory basename (a stable per-repo key).
function repoIdOf(repoPath, explicit) {
  if (explicit) return String(explicit);
  try {
    return path.basename(path.resolve(String(repoPath || "."))) || "repo";
  } catch {
    return "repo";
  }
}

function _readAll(dataDir, file) {
  try {
    return fs
      .readFileSync(path.join(dataDir, file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A receipt's final status → outcome. Fold by id (status updates are appended; last wins).
function _receiptOutcomes(dataDir) {
  const byId = new Map();
  for (const r of _readAll(dataDir, "coding-receipts.jsonl")) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r });
    else Object.assign(byId.get(r.id), r);
  }
  const out = [];
  for (const r of byId.values()) {
    let success;
    if (r.test && typeof r.test.passed === "boolean") success = r.test.passed; // verifier wins (#2174)
    else if (r.status === "applied") success = true;
    else if (r.status === "rejected" || r.status === "apply_failed") success = false;
    else continue; // "proposed" — unresolved, no outcome yet
    out.push({ repo: r.repo || null, backend: r.backend, taskType: r.taskType || "other", success, ts: r.ts, receiptId: r.id });
  }
  return out;
}

// Aggregate outcomes (receipts + explicit) by (repo, backend, taskType).
function outcomeStats(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const rows = [..._receiptOutcomes(dataDir), ..._readAll(dataDir, "coding-outcomes.jsonl")];
  const stats = new Map(); // `${repo}|${backend}|${taskType}` -> {attempts, successes}
  for (const r of rows) {
    if (!r.backend || typeof r.success !== "boolean") continue;
    const key = `${r.repo || ""}|${r.backend}|${r.taskType || "other"}`;
    const s = stats.get(key) || { repo: r.repo || null, backend: r.backend, taskType: r.taskType || "other", attempts: 0, successes: 0 };
    s.attempts += 1;
    if (r.success) s.successes += 1;
    stats.set(key, s);
  }
  for (const s of stats.values()) s.rate = s.attempts ? s.successes / s.attempts : 0;
  return [...stats.values()];
}

// Explicit outcome (richer than approve/reject — e.g. a verifier/test result). #2174 feeds this.
function recordOutcome({ repo, repoPath, backend, taskType, task, success, receiptId }, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const row = {
    repo: repoIdOf(repoPath, repo),
    backend,
    taskType: taskType || taskTypeOf(task),
    success: !!success,
    ts: new Date().toISOString(),
    receiptId: receiptId || null,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, "coding-outcomes.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

// Route a task to the backend with the best MEASURED success on THIS repo+taskType.
// Cold-starts on defaultBackend when no candidate has >= minAttempts of history, and
// signals hasSignal:false so the caller falls back to the answer-first cascade.
function route({ repo, repoPath, taskType, task, candidates, defaultBackend = "ollama", minAttempts = 3 }, opts = {}) {
  const rid = repoIdOf(repoPath, repo);
  const tt = taskType || taskTypeOf(task);
  const cand = Array.isArray(candidates) && candidates.length ? candidates : null;
  const scoped = outcomeStats(opts).filter(
    (s) => s.repo === rid && s.taskType === tt && (!cand || cand.includes(s.backend))
  );
  const eligible = scoped.filter((s) => s.attempts >= minAttempts);
  if (eligible.length) {
    eligible.sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);
    const w = eligible[0];
    return {
      backend: w.backend,
      hasSignal: true,
      repo: rid,
      taskType: tt,
      reason: `measured: ${(w.rate * 100).toFixed(0)}% success over ${w.attempts} run(s) for ${rid}/${tt}`,
      stats: eligible,
    };
  }
  return {
    backend: defaultBackend,
    hasSignal: false,
    repo: rid,
    taskType: tt,
    reason: `cold-start — no candidate has >= ${minAttempts} outcomes for ${rid}/${tt}; fall back to answer-first cascade`,
    stats: scoped,
  };
}

module.exports = { taskTypeOf, repoIdOf, outcomeStats, recordOutcome, route };
