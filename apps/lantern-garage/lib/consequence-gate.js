"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { appendJsonlQueued } = require("./file-queue");

// Lazy-require tool-runner to avoid the circular dependency
// (tool-runner re-exports us, so a top-level require would deadlock the module graph).
function _runTool(name, input, ctx) {
  return require("./tool-runner").runTool(name, input, ctx);
}

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const TIERS_PATH = path.join(REPO, "data", "action-tiers.json");
const PENDING_PATH = path.join(REPO, "data", "pending-approvals.jsonl");

function _loadTiers() {
  try {
    return JSON.parse(fs.readFileSync(TIERS_PATH, "utf8"));
  } catch {
    return { tier1: { tools: ["Read", "LS", "Glob", "Grep"] }, tier2: { tools: ["Write", "Edit", "Bash", "PowerShell"] }, tier3: { tools: [] } };
  }
}

function classifyAction(toolName, _input) {
  const tiers = _loadTiers();
  if (tiers.tier3.tools.includes(toolName)) {
    return { tier: 3, reason: `'${toolName}' is in the tier-3 blocked list` };
  }
  if (tiers.tier1.tools.includes(toolName)) {
    return { tier: 1, reason: `'${toolName}' is a read-only auto-execute tool` };
  }
  if (tiers.tier2.tools.includes(toolName)) {
    return { tier: 2, reason: `'${toolName}' is a mutating tool requiring approval` };
  }
  // unknown tools default to tier 2 — safer than auto-executing something unclassified
  return { tier: 2, reason: `'${toolName}' is not in any tier list; defaulting to confirm` };
}

async function runToolGated(name, input, ctx, opts = {}) {
  const { tier, reason } = classifyAction(name, input);

  if (tier === 3) {
    return { ok: false, tier: 3, error: "action blocked — tier 3" };
  }

  if (tier === 1) {
    const result = await _runTool(name, input, ctx);
    return { ok: result.ok, tier: 1, result: result.result, error: result.error };
  }

  // tier 2: write a pending record and return without executing
  const pendingId = crypto.randomUUID();
  const description = `${name}(${JSON.stringify(input).slice(0, 120)})`;
  const record = {
    id: pendingId,
    status: "pending",
    tool: name,
    input,
    requestedAt: new Date().toISOString(),
    description,
    reason,
  };
  await appendJsonlQueued(PENDING_PATH, record);
  if (typeof opts.onPending === "function") {
    opts.onPending(pendingId, description);
  }
  return { ok: false, tier: 2, pendingId, error: "awaiting approval" };
}

function _readAllPending() {
  try {
    const raw = fs.readFileSync(PENDING_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function approvePending(pendingId, ctx) {
  const records = _readAllPending();
  const record = records.find((r) => r.id === pendingId && r.status === "pending");
  if (!record) {
    return { ok: false, error: `no pending approval found with id '${pendingId}'` };
  }
  const result = await _runTool(record.tool, record.input, ctx);
  await appendJsonlQueued(PENDING_PATH, {
    id: pendingId,
    status: result.ok ? "approved" : "failed",
    completedAt: new Date().toISOString(),
    result: result.result,
    error: result.error,
  });
  return result.ok
    ? { ok: true, result: result.result }
    : { ok: false, error: result.error };
}

async function rejectPending(pendingId) {
  const records = _readAllPending();
  const record = records.find((r) => r.id === pendingId && r.status === "pending");
  if (!record) {
    return { ok: false, error: `no pending approval found with id '${pendingId}'` };
  }
  await appendJsonlQueued(PENDING_PATH, {
    id: pendingId,
    status: "rejected",
    rejectedAt: new Date().toISOString(),
  });
  return { ok: true };
}

function listPending() {
  const records = _readAllPending();
  // fold status updates onto their originating records; last status wins
  const byId = new Map();
  for (const r of records) {
    if (!byId.has(r.id)) {
      byId.set(r.id, { ...r });
    } else {
      Object.assign(byId.get(r.id), r);
    }
  }
  return [...byId.values()].filter((r) => r.status === "pending");
}

module.exports = { classifyAction, runToolGated, approvePending, rejectPending, listPending };
