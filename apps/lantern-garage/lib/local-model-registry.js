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
 *      (VRAM-gated; 8GB / one-process-at-a-time is the real constraint here.)
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
 *   vramGB        number   approx VRAM at the served quant (the 8GB-box gate)
 *   ctxTokens     int      usable context window
 *   taskTypes     string[] task intents this model is eligible to LEAD
 *   rank          number   default preference within a task (lower = earlier)
 *   capabilityScore number raw-task strength 0..1 (used when capability-first)
 *   note          string   human note
 *
 * Source of truth: built-in DEFAULTS below, overlaid (by id) with
 * data/models/local-registry.json when present — operator-editable, TTL-cached.
 *
 * Decision (2026-06-26): Ouro-1.4B stays the Σ₀-native DEFAULT (Q-exit is the
 * collapse-certificate thesis). Qwen2.5-Coder-7B is registered as the opt-in
 * high-capability local backend, selected when LOCAL_CAPABILITY_FIRST=1 (and it
 * fits the VRAM budget). Web-grounded "best that fits 8GB" — see
 * docs/SIGMA0-MODEL-ADAPTER.md for the comparison + sources.
 */

const fs = require("fs");
const path = require("path");

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
    rank: 0,                      // Σ₀-native DEFAULT everywhere it's eligible
    capabilityScore: 0.4,
    note: "Σ₀-native default — Ouro-1.4B looped coder; Q-exit IS the thesis.",
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
    rank: 1,                      // behind Ouro by default; leads under capability-first
    capabilityScore: 0.8,         // strongest code model in the 8GB tier (2026)
    note: "Opt-in capability lever: Qwen2.5-Coder-7B (Q4). Set LOCAL_CAPABILITY_FIRST=1.",
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

function _vramBudgetGB() {
  const v = parseFloat(process.env.VRAM_BUDGET_GB || "");
  return Number.isFinite(v) && v > 0 ? v : 8; // the box: 8GB, one model process
}

function _capabilityFirst(override) {
  if (typeof override === "boolean") return override;
  return process.env.LOCAL_CAPABILITY_FIRST === "1";
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

/** Reset the TTL cache (tests / after an operator edit). */
function _resetCache() {
  _cache = { at: 0, entries: null };
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
 * Default order = `rank` asc (Ouro-native first). With capabilityFirst, order =
 * `capabilityScore` desc (best raw-task model that still fits the box).
 *
 * @param {string} taskType  intent: kernel|coding|reasoning|creative|csf|default
 * @param {object} [opts]
 *   vramBudgetGB    {number}  override the box budget (default env VRAM_BUDGET_GB||8)
 *   capabilityFirst {boolean} override LOCAL_CAPABILITY_FIRST
 *   includeAll      {boolean} ignore the VRAM gate (introspection/tests)
 * @returns {string[]} model ids, best-first
 */
function selectChain(taskType = "default", opts = {}) {
  const budget = Number.isFinite(opts.vramBudgetGB) ? opts.vramBudgetGB : _vramBudgetGB();
  const capFirst = _capabilityFirst(opts.capabilityFirst);
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
  DEFAULTS,
  REGISTRY_JSON_PATH,
};
