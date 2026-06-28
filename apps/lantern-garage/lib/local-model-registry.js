"use strict";

/**
 * Local Model Registry — the Σ₀ "best local model" adapter.
 *
 * ONE contract for every LOCAL backend the Convergence Core can reason with.
 * Models are interchangeable (CLAUDE.md North Star): the Core never hardcodes a
 * model. This registry is the single place that answers two questions the Reason
 * stage needs before it picks a local backend:
 *
 *   1. "Which local model should LEAD for this task — and does it fit the box?"
 *      (VRAM-gated; the box is auto-detected — 8GB laptop or 24GB workstation.)
 *   2. "Does that model self-converge?" — i.e. does it loop / Q-exit INTERNALLY
 *      (Ouro), or must the Core wrap it in lib/loop-reasoner.js to be Σ₀-compliant
 *      (verify-gated convergence)? A non-self-converging model (e.g. Qwen) is only
 *      "Σ₀" once the API-level loop wraps it.
 *
 * This improves the **Reason** loop stage (better model selection) and keeps
 * **Verify** honest (no double-loop on Ouro; no skipped-grounding on Qwen). It is
 * extension, not sprawl: it feeds the EXISTING loop-reasoner + the EXISTING
 * Ollama-compatible transport. No new memory system, no new serving path.
 *
 * Per-entry capability contract:
 *   id            string   served model name (what /api/chat receives)
 *   endpoint      string   base URL of the Ollama/OpenAI-compatible server
 *   selfConverges bool     true  = native looped/Q-exit reasoning (Ouro family);
 *                          false = single-pass → Core wraps it in loopedReason()
 *   toolCalling   bool     trained for tool_use / function calling
 *   vramGB        number   approx VRAM at the served quant (the box-fit gate)
 *   ctxTokens     int      usable context window
 *   taskTypes     string[] task intents this model is eligible to LEAD
 *   rank          number   default preference within a task (lower = earlier)
 *   capabilityScore number raw-task strength 0..1 (used when capability-first)
 *   note          string   human note
 *
 * Source of truth: built-in DEFAULTS below, overlaid (by id) with
 * data/models/local-registry.json when present — operator-editable, TTL-cached.
 *
 * Decision (2026-06-28, #1387 / docs/research/2026-06-28-keystone-chat-frontier-stack.md):
 * selection is CAPABILITY-GATED by the DETECTED box. Non-kernel tasks
 * (coding/reasoning/default) lead with the highest-capability model that *fits
 * the VRAM budget* — so a ≥24GB box leads with the frontier Qwen-3.6-27B coder,
 * an 8GB box leads with Qwen2.5-Coder-7B, and when nothing local fits/serves the
 * provider chain falls back to cloud (Claude). The kernel path stays strict
 * rank-order (Ouro / keystone-ft) — the Σ₀ Convergence Core is unchanged.
 * Ouro-1.4B stays a registered entry (recurrent-depth research front, #1292) but
 * is no longer the universal coding default. VRAM is auto-detected via nvidia-smi
 * (override: VRAM_BUDGET_GB; disable detection: VRAM_AUTODETECT=0; force
 * rank-order / Ouro-first: LOCAL_CAPABILITY_FIRST=0).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_ENDPOINT = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const REGISTRY_JSON_PATH = path.resolve(__dirname, "..", "..", "..", "data", "models", "local-registry.json");
const CACHE_TTL_MS = 60_000;

// Task types that must NOT be widened by "default"-tagged general-fallback models.
// The kernel is the Σ₀ Convergence Core path — only explicit kernel models qualify.
const STRICT_TASKS = new Set(["kernel"]);

// ── Built-in defaults (safety net if the JSON file is absent/broken) ──────────
const DEFAULTS = [
  {
    id: "ouro:latest",
    endpoint: DEFAULT_ENDPOINT,
    selfConverges: true,          // native recurrent depth + Q-exit (arXiv 2510.25741)
    toolCalling: false,           // stock Σ₀ has no tool training (see memory)
    vramGB: 3,
    ctxTokens: 8192,
    taskTypes: ["kernel", "reasoning", "coding", "default"],
    rank: 0,                      // kernel lead; rank-order escape via LOCAL_CAPABILITY_FIRST=0
    capabilityScore: 0.4,
    note: "Recurrent-depth research front (#1292). No tools; no longer the universal coding default (capability-gated). Force Ouro-first with LOCAL_CAPABILITY_FIRST=0.",
  },
  {
    id: "keystone-ft",
    endpoint: DEFAULT_ENDPOINT,
    selfConverges: true,          // Ouro fine-tune; loops internally
    toolCalling: true,
    vramGB: 3,
    ctxTokens: 8192,
    taskTypes: ["kernel"],
    rank: 0,
    capabilityScore: 0.45,
    note: "Keystone kernel fine-tune of Ouro (kernel chain lead, #894).",
  },
  {
    id: "qwen2.5-coder",
    endpoint: DEFAULT_ENDPOINT,
    selfConverges: false,         // single-pass → MUST be wrapped by loopedReason()
    toolCalling: true,
    vramGB: 5,                    // Q4_K_M ~4.7GB — fits the 8GB box
    ctxTokens: 32768,
    taskTypes: ["coding", "default"],
    rank: 1,
    capabilityScore: 0.8,         // strongest code model in the 8GB tier (2026)
    note: "8GB-tier default coder: Qwen2.5-Coder-7B (Q4). Leads coding on an 8GB box; sits behind the 27B frontier on a ≥24GB box.",
  },
  {
    id: "qwen3.6-27b",
    endpoint: DEFAULT_ENDPOINT,
    selfConverges: false,         // single-pass → wrapped by loopedReason()
    toolCalling: true,            // native qwen3_coder tool format
    vramGB: 18,                   // dense 27B @ Q4 ~17GB — needs a ≥24GB box; gated out of 8GB
    ctxTokens: 262144,
    taskTypes: ["coding", "reasoning", "default"],
    rank: 0,
    capabilityScore: 0.92,        // SWE-bench Verified 77.2% — consumer-frontier local (2026)
    note: "Local FRONTIER coder (Qwen 3.6-27B dense). Leads only on a ≥24GB box. PENDING #1388: confirm exact served tag + measured VRAM.",
  },
  {
    id: "lantern-csf-dream",
    endpoint: DEFAULT_ENDPOINT,
    selfConverges: false,
    toolCalling: false,
    vramGB: 5,
    ctxTokens: 8192,
    taskTypes: ["creative", "csf"],
    rank: 0,
    capabilityScore: 0.3,
    note: "Dream/RP-tuned model — Three Doors surface only (never a tool assistant).",
  },
];

let _cache = { at: 0, entries: null };
let _detectedVramGB; // undefined = unprobed; number|null once probed (memoized)

/**
 * Largest single-GPU VRAM in GB via nvidia-smi, or null if unavailable. One model
 * process / box → size to the biggest single card, not the sum. Fixed argv +
 * execFileSync (no shell, no interpolation) → injection-safe. Memoized; cleared
 * by _resetCache().
 */
function _detectVramGB() {
  if (_detectedVramGB !== undefined) return _detectedVramGB;
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const mibs = out
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    _detectedVramGB = mibs.length ? Math.round((Math.max(...mibs) / 1024) * 10) / 10 : null;
  } catch {
    _detectedVramGB = null; // no NVIDIA GPU / nvidia-smi absent → caller falls back
  }
  return _detectedVramGB;
}

/**
 * The box's VRAM budget in GB. Order: explicit env override (VRAM_BUDGET_GB) →
 * auto-detect (nvidia-smi) → the safe 8GB fallback. Disable detection with
 * VRAM_AUTODETECT=0 (forces the 8GB fallback — used by tests for determinism).
 */
function _vramBudgetGB() {
  const v = parseFloat(process.env.VRAM_BUDGET_GB || "");
  if (Number.isFinite(v) && v > 0) return v; // explicit override always wins
  if (process.env.VRAM_AUTODETECT !== "0") {
    const d = _detectVramGB();
    if (Number.isFinite(d) && d > 0) return d;
  }
  return 8; // safe fallback: the 8GB box
}

/**
 * Explicit capability-first preference from opts/env, or null if unspecified
 * (→ selectChain defaults BY TASK: capability-gated for non-kernel, rank-order
 * for kernel). LOCAL_CAPABILITY_FIRST=0 forces rank-order (Ouro-first research /
 * escape mode); =1 forces capability-first everywhere.
 */
function _capabilityFirstPref(override) {
  if (typeof override === "boolean") return override;
  if (process.env.LOCAL_CAPABILITY_FIRST === "1") return true;
  if (process.env.LOCAL_CAPABILITY_FIRST === "0") return false;
  return null;
}

/** Merge the JSON overlay (by id) onto the built-in defaults. TTL-cached. */
function loadRegistry() {
  const now = Date.now();
  if (_cache.entries && now - _cache.at < CACHE_TTL_MS) return _cache.entries;

  const byId = new Map(DEFAULTS.map((e) => [e.id, { ...e }]));
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.models) ? raw.models : [];
    for (const e of list) {
      if (!e || !e.id) continue;
      byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
    }
  } catch {
    /* file missing or malformed → defaults only */
  }
  const entries = Array.from(byId.values());
  _cache = { at: now, entries };
  return entries;
}

/** Reset the TTL cache + memoized VRAM probe (tests / after an operator edit). */
function _resetCache() {
  _cache = { at: 0, entries: null };
  _detectedVramGB = undefined;
}

/** Find an entry by served name. Exact match first, then prefix (e.g. an id of
 *  "qwen2.5-coder" matches a served "qwen2.5-coder:7b" and vice-versa). */
function getEntry(modelId) {
  if (!modelId) return null;
  const id = String(modelId).toLowerCase();
  const reg = loadRegistry();
  let hit = reg.find((e) => e.id.toLowerCase() === id);
  if (hit) return hit;
  hit = reg.find((e) => id.startsWith(e.id.toLowerCase()) || e.id.toLowerCase().startsWith(id));
  return hit || null;
}

/** Does this local model loop/Q-exit INTERNALLY? Unknown → false, so the Core
 *  defaults to wrapping it in loopedReason() (safe: grounding by default). */
function selfConverges(modelId) {
  const e = getEntry(modelId);
  return e ? !!e.selfConverges : false;
}

/** Is this local model trained for tool/function calling? Unknown → false. */
function toolCalling(modelId) {
  const e = getEntry(modelId);
  return e ? !!e.toolCalling : false;
}

/**
 * Ordered list of local model ids eligible to LEAD this task, gated by VRAM.
 *
 * Default ordering is CAPABILITY-GATED for non-kernel tasks: among the models
 * that fit the (auto-detected) box, the highest capabilityScore leads — so the
 * frontier 27B coder leads a 24GB box and Qwen2.5-Coder-7B leads an 8GB box. The
 * kernel stays strict rank-order (Ouro / keystone-ft). An explicit
 * opts.capabilityFirst or LOCAL_CAPABILITY_FIRST env overrides the per-task
 * default (=0 → rank-order / Ouro-first).
 *
 * @param {string} taskType  intent: kernel|coding|reasoning|creative|csf|default
 * @param {object} [opts]
 *   vramBudgetGB    {number}  override the box budget (default: detected / 8GB)
 *   capabilityFirst {boolean} override the per-task default ordering
 *   includeAll      {boolean} ignore the VRAM gate (introspection/tests)
 * @returns {string[]} model ids, best-first
 */
function selectChain(taskType = "default", opts = {}) {
  const budget = Number.isFinite(opts.vramBudgetGB) ? opts.vramBudgetGB : _vramBudgetGB();
  const pref = _capabilityFirstPref(opts.capabilityFirst);
  // No explicit preference → capability-gated for non-kernel, rank-order for kernel.
  const capFirst = pref === null ? !STRICT_TASKS.has(taskType) : pref;
  const reg = loadRegistry();

  // "default"-tagged models are general fallbacks for open-ended chat — but the
  // kernel (the Σ₀ Convergence Core path) must stay strict: only models that
  // explicitly opt into "kernel" are eligible there. No general-fallback widening.
  const widenWithDefault = !STRICT_TASKS.has(taskType);
  const eligible = reg.filter(
    (e) =>
      (opts.includeAll || (e.vramGB || 0) <= budget) &&
      Array.isArray(e.taskTypes) &&
      (e.taskTypes.includes(taskType) || (widenWithDefault && e.taskTypes.includes("default"))),
  );

  eligible.sort((a, b) =>
    capFirst
      ? (b.capabilityScore || 0) - (a.capabilityScore || 0) || (a.rank || 0) - (b.rank || 0)
      : (a.rank || 0) - (b.rank || 0) || (b.capabilityScore || 0) - (a.capabilityScore || 0),
  );

  return eligible.map((e) => e.id);
}

/** The single best local model id to lead this task (or null if none fit). */
function selectBest(taskType = "default", opts = {}) {
  return selectChain(taskType, opts)[0] || null;
}

module.exports = {
  loadRegistry,
  getEntry,
  selfConverges,
  toolCalling,
  selectChain,
  selectBest,
  _resetCache,
  _vramBudgetGB,
  _detectVramGB,
  DEFAULTS,
  REGISTRY_JSON_PATH,
};
