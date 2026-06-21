"use strict";
/**
 * Keystone kernel escalation + landed-work attribution (#897, #898).
 *
 * When a kernel run fails verification, we escalate to the next provider in the
 * #894 kernel chain (Keystone/Ouro → … → Claude) and record EACH escalation as a
 * convergence event so the rollover loop has a real, queryable proof artifact —
 * not a silent "Keystone failed". On success we record who landed the work, so the
 * rollover dashboard (#898) can compute the Keystone-vs-Claude landed-work share
 * from JSONL with no new persistent store.
 *
 * The orchestrator is pure/injectable (runOne + onEscalate are supplied), so the
 * escalation logic is unit-testable without the live kernel or SSE stream.
 */
const path = require("path");
const fsSync = require("fs");
const { PROVIDER_CHAINS } = require("./provider-router");
const { emitConvergenceRecord } = require("./convergence-records");

const KERNEL_REASONER = "keystone-kernel";
const HARD_TASK_REL = path.join("data", "convergence-autonomous-work.jsonl");
// keystoneRun statuses that mean "the kernel landed it" — anything else escalates.
const SUCCESS_STATUSES = new Set(["success", "applied_unverified"]);
// Providers that are "Claude" for landed-work share purposes.
const CLAUDE_PROVIDERS = new Set(["anthropic"]);

/** Flatten the kernel provider chain into an ordered [{provider, model}] list. */
function kernelEscalationChain(chain = PROVIDER_CHAINS.kernel) {
  const out = [];
  for (const link of chain || []) {
    for (const model of link.models || []) out.push({ provider: link.provider, model });
  }
  return out;
}

/**
 * Run the kernel across `providers`, escalating to the next on failure.
 * @param providers ordered [{provider, model}]
 * @param runOne async (provider, model, index) -> keystoneRun result ({status,...})
 * @param onEscalate async (escalationRecord, result) -> void  (per failed attempt)
 * @returns { result, providerUsed|null, attempts, escalations[] }
 */
async function runKernelWithEscalation({ providers, runOne, onEscalate = async () => {} }) {
  const escalations = [];
  let lastResult = null;
  const list = providers || [];
  for (let i = 0; i < list.length; i++) {
    const { provider, model } = list[i];
    const result = await runOne(provider, model, i);
    lastResult = result;
    if (result && SUCCESS_STATUSES.has(result.status)) {
      return { result, providerUsed: { provider, model }, attempts: i + 1, escalations };
    }
    const next = list[i + 1] || null;
    const rec = {
      failedProvider: provider, failedModel: model, escalatedTo: next,
      attempt: i + 1, status: result && result.status, error: result && result.error,
    };
    escalations.push(rec);
    await onEscalate(rec, result);
    if (!next) break; // chain exhausted
  }
  return { result: lastResult, providerUsed: null, attempts: list.length, escalations };
}

/** Persist one escalation as a convergence record + a hard task for distillation. */
async function recordEscalation({ issue, failedProvider, failedModel, escalatedTo, runId, attempt, error, repoRoot }) {
  const escalatedLabel = escalatedTo ? `${escalatedTo.provider}/${escalatedTo.model}` : "none(exhausted)";
  const rec = await emitConvergenceRecord({
    hypothesis: `Keystone kernel can land: ${String(issue || "").slice(0, 200)}`,
    result: `escalated-to-${escalatedLabel}`,
    confidence: Math.max(0.1, 0.5 - 0.1 * (attempt || 1)),
    reasoner: KERNEL_REASONER,
    verified: false,
    verification_notes: error ? String(error).slice(0, 500) : null,
    source: `kernel/${failedProvider}/${failedModel}`,
    evidence_ids: runId ? [runId] : [],
  });
  _appendHardTask(repoRoot, {
    type: "kernel-escalation", issue: String(issue || "").slice(0, 200),
    failedProvider, failedModel, escalatedTo: escalatedLabel, runId, attempt,
  });
  return rec;
}

/** Record who landed the work (for the rollover landed-work share, #898). */
async function recordLanded({ issue, provider, model, runId, verified, repoRoot }) {
  return emitConvergenceRecord({
    hypothesis: `Keystone kernel can land: ${String(issue || "").slice(0, 200)}`,
    result: `landed-by-${provider}/${model}`,
    confidence: verified ? 0.85 : 0.6,
    reasoner: KERNEL_REASONER,
    verified: !!verified,
    source: `kernel/${provider}/${model}`,
    evidence_ids: runId ? [runId] : [],
  });
}

function _appendHardTask(repoRoot, obj) {
  try {
    const p = path.join(repoRoot, HARD_TASK_REL);
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.appendFileSync(p, JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n");
  } catch (_e) { /* best effort — never block the stream on logging */ }
}

function _isClaudeResult(result) {
  // result is "landed-by-anthropic/claude-..." or "escalated-to-anthropic/claude-...".
  return [...CLAUDE_PROVIDERS].some((p) => result.includes(`-${p}/`) || result.includes(`-${p})`));
}

/**
 * Aggregate the Keystone-vs-Claude landed-work share + escalation rate from
 * convergence records (reasoner === "keystone-kernel"), optionally since a ts (ms).
 */
function readRolloverShare(records, { sinceTs = 0 } = {}) {
  let keystoneLanded = 0, claudeLanded = 0, escalations = 0, exhausted = 0;
  // Accept both this module's reasoner and the earlier inline "kernel-escalation"
  // records already on disk, so the dashboard aggregates historical escalations too.
  const KERNEL_REASONERS = new Set([KERNEL_REASONER, "kernel-escalation"]);
  for (const r of records || []) {
    if (!r || !KERNEL_REASONERS.has(r.reasoner) || typeof r.result !== "string") continue;
    const ts = Date.parse(r.timestamp || r.ts || 0) || 0;
    if (ts < sinceTs) continue;
    if (r.result.startsWith("landed-by-")) {
      if (_isClaudeResult(r.result)) claudeLanded++; else keystoneLanded++;
    } else if (r.result.startsWith("escalated-to-")) {
      escalations++;
      if (r.result.includes("none(exhausted)")) exhausted++;
    }
  }
  const landed = keystoneLanded + claudeLanded;
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    keystoneLanded, claudeLanded, landed, escalations, exhausted,
    keystoneShare: landed ? round(keystoneLanded / landed) : null,
    // escalation rate = fraction of kernel attempts that had to escalate off Keystone.
    escalationRate: (keystoneLanded + escalations)
      ? round(escalations / (keystoneLanded + escalations)) : null,
  };
}

module.exports = {
  kernelEscalationChain, runKernelWithEscalation, recordEscalation, recordLanded,
  readRolloverShare, KERNEL_REASONER, SUCCESS_STATUSES,
};
