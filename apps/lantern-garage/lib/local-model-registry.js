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
 *   verified      bool     OPTIONAL. The capability above is REPRODUCED on our box
 *                          (eval/probe log), not just vendor-claimed. Absent → treated
 *                          as verified (back-compat). Explicit `false` = vendor/predicted
 *                          only → the model is registered but CANNOT lead by capability
 *                          over a reproduced peer (External Reality Rule). Flip to true
 *                          only when a probe/eval log backs the number.
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
 *
 * Grounding gate (2026-06-29, best-in-slot rule): capability-first selection is
 * EVIDENCE-GATED. A registered model whose capability is vendor-claimed / predicted
 * but not yet reproduced on our hardware (`verified:false`) may sit in the chain but
 * is sorted BEHIND every reproduced peer — it never auto-LEADS on a benchmark we
 * haven't run (External Reality Rule). This is how new candidates (e.g.
 * LoopCoder-v2, whose every number is predicted and whose PLT arch may not even load
 * 4-bit — see experiments/loopcoder_v2_4bit_probe.py) enter without silently
 * displacing a known-good lead. Override for the probe/eval run itself with
 * LOCAL_ALLOW_UNVERIFIED=1.
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
    taskTypes: ["kernel"],        // KERNEL-ONLY now: keystone-sigma0-plt is the sole local
                                  // coder/default (the LoopCoder-lineage Σ₀ model). Ouro stays
                                  // the strict Q-exit Convergence-Core kernel; it no longer
                                  // competes on coding/reasoning/default.
    rank: 0,                      // kernel lead; rank-order escape via LOCAL_CAPABILITY_FIRST=0
    capabilityScore: 0.4,
    note: "Recurrent-depth Σ₀ kernel (#1292). Kernel-only since the PLT coder became the sole local coding default. Its Σ₀ adapter is improved offline by the crystallization flywheel — a LOCAL Qwen2.5-Coder-7B teacher distills execution-verified traces into this student (scripts/gen_sigma0_traces.py --teacher qwen2.5-coder:7b; docs/research/2026-07-02-qwen-teacher-ouro-crystallization.md), eval-gated on HumanEval before final/ swaps.",
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
    id: "keystone-sigma0-plt",
    // The SOLE local coder/default. It serves on its own ollama-compatible shim
    // (models/keystone-sigma0-plt/serve_keystone_plt.py → :11435), separate from the
    // kernel/dream ollama on :11434. Per-model routing (endpointFor) honors this so the
    // kernel (Ouro) and Three Doors (lantern-csf-dream) keep working on :11434.
    endpoint: process.env.KEYSTONE_PLT_ENDPOINT || "http://127.0.0.1:11435",
    selfConverges: false,         // PLT loops internally (fixed 2-loop) but that is NOT a
                                  // Q-exit convergence certificate → Core still wraps it in
                                  // loopedReason() (grounding by default).
    toolCalling: false,
    vramGB: 6,                    // 7.6B PLT @ 4-bit ≈ 6.4GB MEASURED on-box (RTX 3070, #1757/serve).
    ctxTokens: 131072,
    taskTypes: ["coding", "reasoning", "default"],  // sole local coder AND general default
    rank: 0,
    capabilityScore: 0.84,        // vendor two-loop SWE-bench (predicted); it is the only local
                                  // coder so it leads regardless — no verified peer to displace.
    verified: false,             // OWNED proprietary PLT bootstrap from the LoopCoder-V2 Apache-2.0
                                  // weights (ADR-0011). On-box (RTX 3070) it LOADS 4-bit (~6.4GB<8),
                                  // serves ollama-compatible, and generates coherent code at ~5–6 tok/s
                                  // (static KV cache). Kept `verified:false` honestly: it is the SOLE
                                  // local coder by operator decision, not yet a reproduced eval WIN over
                                  // a peer. The head-to-head vs a frontier coder (HumanEval) remains the
                                  // gate to flip this true. Requires serve_keystone_plt.py running on
                                  // :11435 (or KEYSTONE_PLT_ENDPOINT); if the shim is down the provider
                                  // chain falls back to cloud (Claude), not to another local model.
    note: "Sole local Σ₀ coder (ADR-0011, LoopCoder-V2 lineage). Default for coding/reasoning/default; kernel stays Ouro. Serve via models/keystone-sigma0-plt/serve_keystone_plt.py on :11435.",
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

/** The ollama-compatible base URL this model is served at. The registry is the
 *  source of truth for per-model routing: keystone-sigma0-plt lives on its own
 *  shim (:11435) while the kernel + dream models stay on :11434. Falls back to
 *  the global OLLAMA_BASE_URL for any model the registry has no opinion on, so an
 *  operator custom pin still works. */
function endpointFor(modelId) {
  const e = getEntry(modelId);
  return (e && e.endpoint) || DEFAULT_ENDPOINT;
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

/** Is this entry's capability REPRODUCED on our box (not just vendor-claimed)?
 *  Absent `verified` → true (back-compat); only an explicit `false` demotes. */
function _isVerified(e) {
  return !!e && e.verified !== false;
}

/** Public: has this model's capability been reproduced on-box? (id or entry) */
function isVerified(modelId) {
  const e = typeof modelId === "object" ? modelId : getEntry(modelId);
  return _isVerified(e);
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

  // Grounding gate: an unverified (vendor-claimed) model never leads over a
  // reproduced peer, regardless of its predicted capabilityScore. LOCAL_ALLOW_UNVERIFIED=1
  // lifts the gate (used by the probe/eval run that PRODUCES the evidence).
  const allowUnverified = process.env.LOCAL_ALLOW_UNVERIFIED === "1";
  eligible.sort((a, b) => {
    if (!allowUnverified) {
      const d = (_isVerified(a) ? 0 : 1) - (_isVerified(b) ? 0 : 1);
      if (d) return d; // verified first
    }
    return capFirst
      ? (b.capabilityScore || 0) - (a.capabilityScore || 0) || (a.rank || 0) - (b.rank || 0)
      : (a.rank || 0) - (b.rank || 0) || (b.capabilityScore || 0) - (a.capabilityScore || 0);
  });

  return eligible.map((e) => e.id);
}

/** The single best local model id to lead this task (or null if none fit). */
function selectBest(taskType = "default", opts = {}) {
  return selectChain(taskType, opts)[0] || null;
}

/**
 * Resolve the AUTHORITATIVE local model lead + ordered chain for an intent.
 *
 * The registry is the SOURCE OF TRUTH for which local model leads (CLAUDE.md North
 * Star: models are replaceable; never hardcode one). This folds the operator's
 * OLLAMA_MODEL pin and any caller-supplied served fallback chain into the registry's
 * VRAM-gated capability order WITHOUT letting a stale pin (e.g. the legacy
 * `ouro:latest` default) silently front-jump and defeat the capability swap — the
 * exact bug that left keystone chat pinned to Ouro while the adapter quietly picked
 * the better model.
 *
 * LEAD precedence:
 *   1. An OLLAMA_MODEL pin the registry does NOT manage (operator pulled a custom
 *      model the registry has no opinion on) → honor it as the lead.
 *   2. Otherwise the registry's capability-gated #1 for this intent + detected box.
 * A registry-managed pin stays a CANDIDATE in the chain but takes its capability
 * slot — never a front-jump. Escape hatch: LOCAL_CAPABILITY_FIRST=0 flips the
 * registry to rank-order (Ouro-first) and that rank-0 model leads naturally.
 *
 * @param {string} intent  kernel|coding|reasoning|creative|csf|default
 * @param {object} [opts]
 *   pin       {string|null} operator pin (default: process.env.OLLAMA_MODEL)
 *   fallback  {string[]}    extra served models kept as deduped tail candidates
 *   vramBudgetGB, capabilityFirst, includeAll — forwarded to selectChain
 * @returns {{chain:string[], lead:string|null, registryLead:string|null,
 *   reason:string, vramBudgetGB:number, capabilityFirst:boolean,
 *   pinHonored:boolean, pin:string|null}}
 */
function resolveLocalLead(intent = "default", opts = {}) {
  const pin = (opts.pin !== undefined ? opts.pin : process.env.OLLAMA_MODEL) || "";
  const fallback = Array.isArray(opts.fallback) ? opts.fallback : [];
  const budget = Number.isFinite(opts.vramBudgetGB) ? opts.vramBudgetGB : _vramBudgetGB();
  const pref = _capabilityFirstPref(opts.capabilityFirst);
  const capabilityFirst = pref === null ? !STRICT_TASKS.has(intent) : pref;

  const registryChain = selectChain(intent, opts);
  const registryLead = registryChain[0] || null;

  // Registry chain leads; the caller's served fallbacks fill the tail (deduped).
  const seen = new Set();
  const chain = [];
  const push = (m) => { if (m && !seen.has(m)) { seen.add(m); chain.push(m); } };
  registryChain.forEach(push);
  fallback.forEach(push);

  // OLLAMA_MODEL pin: always kept as a CANDIDATE; it LEADS only when the registry
  // does not manage it (a deliberate custom model). A registry-managed pin keeps
  // its capability slot so it can never front-jump the swap.
  const pinManaged = pin ? !!getEntry(pin) : false;
  if (pin) push(pin);
  let lead = registryLead;
  let pinHonored = false;
  if (pin && !pinManaged) { lead = pin; pinHonored = true; }

  // Re-assert the resolved lead as the chain head.
  let ordered = chain;
  if (lead && chain[0] !== lead) ordered = [lead, ...chain.filter((x) => x !== lead)];

  const reason = pinHonored
    ? `operator pin OLLAMA_MODEL=${pin} (not registry-managed)`
    : (lead
        ? `best local model for ${intent} @ ${budget}GB box${capabilityFirst ? "" : " · rank-order"}`
        : `no local model fits ${budget}GB → cloud fallback`);

  return { chain: ordered, lead, registryLead, reason, vramBudgetGB: budget, capabilityFirst, pinHonored, pin: pin || null };
}

module.exports = {
  loadRegistry,
  getEntry,
  endpointFor,
  selfConverges,
  toolCalling,
  isVerified,
  selectChain,
  selectBest,
  resolveLocalLead,
  _resetCache,
  _vramBudgetGB,
  _detectVramGB,
  DEFAULTS,
  REGISTRY_JSON_PATH,
};
