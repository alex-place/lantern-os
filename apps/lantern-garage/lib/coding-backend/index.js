"use strict";

// Keystone coding-backend control plane (first slice of the OSS-BASELINE thesis).
//
// The blank space the OSS audit found in EVERY layer: mature coding agents (Aider,
// OpenHands, opencode, …) are stateless per-repo executors — they apply+commit
// immediately, keep no owned memory, hold nothing for approval, and emit no receipt.
// This module is the accountable layer OVER any such backend:
//
//   backend.propose()  ->  HOLD for approval (consequence-gate pattern)  ->  RECEIPT
//                                        |
//                              user approves / rejects
//                                        |
//                                    apply / drop
//
// It reuses the existing consequence-gate PATTERN (propose -> pending -> approve) and
// adds the receipt (task, backend, model, cost, files, patch-hash, why, status) that
// no raw coding agent produces. Backends are pluggable; a mock drives the tests and the
// Aider adapter activates when the CLI is installed. See docs/OSS-BASELINE.md.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _repoRoot;
try {
  _repoRoot = require("../app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
}
const DEFAULT_DATA_DIR = path.join(_repoRoot, "data");

const ADAPTERS = {
  mock: require("./adapters/mock"),
  ollama: require("./adapters/ollama"),
  aider: require("./adapters/aider"),
  openhands: require("./adapters/openhands"),
};

function listBackends() {
  return Object.keys(ADAPTERS);
}

// The default LOCAL coding engine, resolved from the VRAM-gated model registry
// (OSS-BASELINE #2171 → supported Qwen2.5-Coder on the 8GB box; kernel stays Ouro).
// Local-serving backends (aider via Ollama) use this; the receipt records it.
function defaultLocalEngine(intent = "coding") {
  try {
    const reg = require("../local-model-registry");
    const r = reg.resolveLocalLead(intent);
    return { lead: r.lead, endpoint: r.lead ? reg.endpointFor(r.lead) : null, reason: r.reason };
  } catch (e) {
    return { lead: null, endpoint: null, reason: `registry unavailable: ${e.message}` };
  }
}

function _append(dataDir, file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, file), JSON.stringify(obj) + "\n");
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
function _fold(records) {
  // status updates are appended; last write per id wins
  const byId = new Map();
  for (const r of records) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r });
    else Object.assign(byId.get(r.id), r);
  }
  return byId;
}

// Run a coding task through the control plane: propose, HOLD for approval, emit a receipt.
async function runCodingTask({ task, repoPath, backend = "aider", why = "", repo, taskType }, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const _router = require("./router");
  const repoId = _router.repoIdOf(repoPath, repo); // per-repo outcome key (#2175)
  const _taskType = taskType || _router.taskTypeOf(task);
  const adapter = ADAPTERS[backend];
  if (!adapter) return { ok: false, error: `unknown backend '${backend}'`, backends: listBackends() };

  const available = await adapter.available();
  if (!available) {
    return { ok: false, backend, error: `backend '${backend}' not available`, hint: adapter.installHint || null };
  }

  const localEngine = defaultLocalEngine("coding");
  const model = opts.model || localEngine.lead || null;
  let proposal;
  try {
    proposal = await adapter.propose({ task, repoPath, model });
  } catch (e) {
    return { ok: false, backend, error: `propose failed: ${e.message}` };
  }
  if (!proposal || !proposal.ok) {
    return { ok: false, backend, error: (proposal && proposal.error) || "no proposal" };
  }

  const files = proposal.filesChanged || [];
  const receiptId = crypto.randomUUID();
  const pendingId = crypto.randomUUID();
  const patchPreview = proposal.patchPreview || "";

  // VERIFICATION-DECIDES (#2174): a verifier — not a model vote — judges the held
  // proposal before it can apply. The verdict fills receipt.test, which the #2175
  // router reads as the authoritative outcome. Never throws (adapters degrade to
  // skipped). Policy (enforce / runTests) is configurable via opts.verify + env.
  const verifier = require("./verifier");
  let verdict;
  try {
    verdict = await verifier.verifyProposal(
      { repoPath, files, task, taskType: _taskType, patchPreview, backend },
      opts.verify || {}
    );
  } catch (e) {
    // The verifier must never sink a proposal; degrade to an undecisive verdict.
    verdict = { passed: null, decisive: false, enforce: false, error: `verifier failed: ${e.message}`, checks: [] };
  }
  const blocked = verifier.isBlocked(verdict);

  // The receipt — the accountable artifact no raw coding agent emits.
  const receipt = {
    id: receiptId,
    ts: new Date().toISOString(),
    task,
    repo: repoId, // per-repo outcome key (#2175)
    taskType: _taskType,
    backend,
    model: proposal.model || model || null,
    localEngine: localEngine.lead || null,
    costUsd: proposal.costUsd ?? null,
    filesChanged: files.map((f) => f.path),
    why,
    patchSha256: crypto.createHash("sha256").update(patchPreview).digest("hex"),
    test: verdict, // verification-decides verdict (#2174) — { passed, decisive, checks, ... }
    status: "proposed",
    pendingId,
  };
  _append(dataDir, "coding-receipts.jsonl", receipt);

  // HOLD: pending record in the consequence-gate shape (tool = coding.apply_patch).
  // Carries the verification summary so approve can refuse a blocked patch.
  _append(dataDir, "coding-pending.jsonl", {
    id: pendingId,
    status: "pending",
    tool: "coding.apply_patch",
    input: { receiptId, repoPath, backend, files },
    verification: { passed: verdict.passed, decisive: verdict.decisive, enforce: verdict.enforce, blocked },
    requestedAt: new Date().toISOString(),
    description: `apply ${files.length} file change(s) from ${backend}: ${task}`.slice(0, 160),
    reason: blocked
      ? "coding backend proposes; verification FAILED — apply blocked until overridden"
      : "coding backend proposes; changes HELD until the user approves",
  });

  return {
    ok: true,
    status: "awaiting_approval",
    backend,
    localEngine: localEngine.lead || null,
    pendingId,
    receiptId,
    verification: verdict,
    blocked,
    receipt: { ...receipt },
    proposal: { filesChanged: receipt.filesChanged, patchPreview },
  };
}

function _findPending(dataDir, pendingId) {
  return _fold(_readAll(dataDir, "coding-pending.jsonl")).get(pendingId) || null;
}

async function approveCodingPatch(pendingId, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const rec = _findPending(dataDir, pendingId);
  if (!rec || rec.status !== "pending") return { ok: false, error: `no pending coding patch '${pendingId}'` };

  // VERIFICATION-DECIDES (#2174): refuse to apply a patch whose verifier verdict
  // is an enforced, decisive failure — unless the caller explicitly overrides.
  if (rec.verification && rec.verification.blocked && !opts.overrideVerification) {
    return {
      ok: false,
      error: "apply blocked by failing verification",
      verification: rec.verification,
      hint: "pass { overrideVerification: true } to apply anyway",
    };
  }

  const { repoPath, files, receiptId } = rec.input;
  const { resolveInsideRepo } = require("./fs-guard");
  const applied = [];
  try {
    for (const f of files) {
      // Containment: a proposal path must never write outside the repo.
      const g = resolveInsideRepo(repoPath, f.path);
      if (!g.ok) throw new Error(g.reason);
      fs.mkdirSync(path.dirname(g.abs), { recursive: true });
      fs.writeFileSync(g.abs, f.content);
      applied.push(f.path);
    }
  } catch (e) {
    _append(dataDir, "coding-pending.jsonl", { id: pendingId, status: "apply_failed", error: e.message, at: new Date().toISOString() });
    _append(dataDir, "coding-receipts.jsonl", { id: receiptId, status: "apply_failed", error: e.message, appliedAt: new Date().toISOString() });
    return { ok: false, error: `apply failed: ${e.message}`, applied };
  }
  _append(dataDir, "coding-pending.jsonl", { id: pendingId, status: "approved", at: new Date().toISOString() });
  _append(dataDir, "coding-receipts.jsonl", { id: receiptId, status: "applied", filesApplied: applied, appliedAt: new Date().toISOString() });
  return { ok: true, applied, receiptId };
}

async function rejectCodingPatch(pendingId, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const rec = _findPending(dataDir, pendingId);
  if (!rec || rec.status !== "pending") return { ok: false, error: `no pending coding patch '${pendingId}'` };
  _append(dataDir, "coding-pending.jsonl", { id: pendingId, status: "rejected", at: new Date().toISOString() });
  _append(dataDir, "coding-receipts.jsonl", { id: rec.input.receiptId, status: "rejected", rejectedAt: new Date().toISOString() });
  return { ok: true };
}

function listCodingPending(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  return [..._fold(_readAll(dataDir, "coding-pending.jsonl")).values()].filter((r) => r.status === "pending");
}

function readReceipts(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  return _readAll(dataDir, "coding-receipts.jsonl");
}

// Honest A/B: the wrapped path always adds hold-for-approval + a receipt the raw backend
// never emits. The measured EDIT-ACCURACY comparison over the golden task set lives in
// `scripts/eval_coding_backend_ab.py` (raw qwen vs wrapped, reusing the exec grader);
// this in-process helper is the single-task structural check.
async function abCompare({ task, repoPath, backend = "ollama" }, opts = {}) {
  const adapter = ADAPTERS[backend];
  if (!adapter || !(await adapter.available())) {
    return { measured: false, reason: `backend '${backend}' unavailable; install it + a local coder to measure`, backend };
  }
  const wrapped = await runCodingTask({ task, repoPath, backend, why: "ab:wrapped" }, opts);
  return {
    measured: true,
    backend,
    wrapped: {
      held_for_approval: wrapped.status === "awaiting_approval",
      has_receipt: !!wrapped.receiptId,
      filesChanged: wrapped.proposal && wrapped.proposal.filesChanged,
    },
    note: "wrapped adds hold-for-approval + a receipt the raw backend never emits; edit-accuracy delta needs a task set (backlog).",
  };
}

// Route by measured per-repo outcome (#2175), then run. When there's no outcome signal
// yet, route() returns the defaultBackend with hasSignal:false — the answer-first cascade.
async function routeCodingTask({ task, repoPath, candidates, defaultBackend = "ollama", why = "" }, opts = {}) {
  const router = require("./router");
  const decision = router.route({ task, repoPath, candidates, defaultBackend }, opts);
  const r = await runCodingTask(
    { task, repoPath, backend: decision.backend, why: why || `route:${decision.hasSignal ? "outcome" : "cold-start"}` },
    opts
  );
  return { ...r, routing: decision };
}

// Re-run verification on a still-held pending patch (e.g. after installing the
// test runner or MiniCheck) and update its receipt.test + pending verification.
// Returns the fresh verdict. The verification-decides layer's re-entry point.
async function verifyPending(pendingId, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const rec = _findPending(dataDir, pendingId);
  if (!rec || rec.status !== "pending") return { ok: false, error: `no pending coding patch '${pendingId}'` };
  const { repoPath, files, receiptId, backend } = rec.input;
  const receipt = _fold(_readAll(dataDir, "coding-receipts.jsonl")).get(receiptId) || {};
  const verifier = require("./verifier");
  const verdict = await verifier.verifyProposal(
    { repoPath, files, task: receipt.task, taskType: receipt.taskType, patchPreview: "", backend },
    opts.verify || {}
  );
  const blocked = verifier.isBlocked(verdict);
  _append(dataDir, "coding-receipts.jsonl", { id: receiptId, test: verdict });
  _append(dataDir, "coding-pending.jsonl", {
    id: pendingId,
    verification: { passed: verdict.passed, decisive: verdict.decisive, enforce: verdict.enforce, blocked },
  });
  return { ok: true, verification: verdict, blocked, receiptId };
}

const _router = require("./router");
const _verifier = require("./verifier");

module.exports = {
  runCodingTask,
  routeCodingTask,
  approveCodingPatch,
  rejectCodingPatch,
  listCodingPending,
  readReceipts,
  abCompare,
  listBackends,
  defaultLocalEngine,
  // verification-decides layer (#2174)
  verifyProposal: _verifier.verifyProposal,
  verifyPending,
  verifyPolicy: _verifier.resolvePolicy,
  // outcome-based routing (#2175)
  route: _router.route,
  outcomeStats: _router.outcomeStats,
  recordOutcome: _router.recordOutcome,
  taskTypeOf: _router.taskTypeOf,
  repoIdOf: _router.repoIdOf,
};
