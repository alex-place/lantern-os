"use strict";

/**
 * Image Model Registry — the OSS-first "best image generator" adapter.
 *
 * ONE contract for every image-generation backend the Act stage can dispatch to.
 * Providers are interchangeable (CLAUDE.md North Star: never hardcode a model),
 * and the default policy is LOCAL/OSS-FIRST: a locally-owned Apache-2.0 generator
 * (Flux.1-schnell via ComfyUI) leads whenever it is reachable, and closed cloud
 * providers (OpenAI Images) are used ONLY as a fallback tail while no OSS provider
 * is reachable — or forbidden entirely with IMAGE_OSS_ONLY=1.
 *
 * This improves the **Act** loop stage (better tool execution + provider
 * observability) and serves North Star #6 (local ownership). It is EXTENSION, not
 * sprawl: it mirrors the proven lib/local-model-registry.js structure and feeds the
 * EXISTING /api/image/ai-generate route + the existing lib/openai-image.js driver.
 * No new memory system, no new serving path.
 *
 * Per-entry contract (built-in DEFAULTS, overlaid by id with the operator JSON):
 *   id             string   provider id (stable enum used by the route)
 *   kind           string   driver key: 'comfyui' | 'openai' | 'pollinations'
 *   endpoint       string   base URL of the backend (SSRF-allowlisted per kind)
 *   oss            bool     true = locally-owned OSS generator; false = closed/hosted
 *   taskTypes      string[] intents this provider can serve ('scene' | 'character')
 *   vramGB         number   approx VRAM the local model needs (0 for cloud)
 *   supportsRefImage bool   can take a reference image (IP-Adapter / img2img — Phase 4)
 *   cost           number   relative $/image, 0..1 (lower first within a tier)
 *   rank           number   preference within a tier (lower = earlier)
 *   enabled        bool     operator switch; closed providers ship enabled but only
 *                           ever run as fallback (never lead over a reachable OSS one)
 *
 * Source of truth: DEFAULTS below, overlaid (by id) with data/models/image-registry.json
 * when present — operator-editable, TTL-cached, gitignored, schema-validated.
 * SSRF guard: the overlay can NOT point a provider at an arbitrary host — comfyui is
 * pinned to loopback and openai to api.openai.com; a violating entry is dropped.
 */

const fs = require("fs");
const path = require("path");

const REGISTRY_JSON_PATH = path.resolve(__dirname, "..", "..", "..", "data", "models", "image-registry.json");
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3000;   // hard cap; never operator-configurable (boot-safety)
const REACH_TTL_MS = 30_000;     // reachability memo TTL

// ── Built-in defaults (safety net if the JSON overlay is absent/broken) ───────
const DEFAULTS = [
  {
    id: "local-flux-schnell",
    kind: "comfyui",
    endpoint: process.env.COMFYUI_ENDPOINT || "http://127.0.0.1:8188",
    oss: true,                    // FLUX.1-schnell is Apache-2.0 (locally owned)
    taskTypes: ["scene", "character"],
    vramGB: 8,                    // fp8/GGUF on an 8GB RTX 3070 (Phase 3 verifies on-box)
    supportsRefImage: true,       // IP-Adapter conditioning on assets/reference/ (Phase 4)
    cost: 0,
    rank: 0,
    enabled: true,
    note: "OSS lead: Flux.1-schnell via local ComfyUI. Driver lands in Phase 3 (#1847); until then it is registered but unreachable, so the chain falls to OpenAI with no behavior change.",
  },
  {
    id: "openai-images",
    kind: "openai",
    endpoint: "https://api.openai.com",
    oss: false,                   // closed/hosted → fallback tail only
    taskTypes: ["scene"],
    vramGB: 0,
    supportsRefImage: false,
    cost: 0.9,
    rank: 50,
    enabled: true,
    note: "Closed fallback (gpt-image-2 → dall-e-3). Used only while no OSS provider is reachable; disabled entirely by IMAGE_OSS_ONLY=1.",
  },
  {
    id: "pollinations",
    kind: "pollinations",
    endpoint: "https://image.pollinations.ai",
    oss: false,                   // free but someone else's hosted service (not owned)
    taskTypes: ["scene"],
    vramGB: 0,
    supportsRefImage: false,
    cost: 0.3,
    rank: 60,
    enabled: false,               // opt-in; the browser already keyless-falls-back to it
    note: "Keyless hosted fallback. Off by default (the client handles Pollinations itself).",
  },
];

let _cache = { at: 0, entries: null };
const _reach = new Map(); // kind/id → { at, ok }

/** Only loopback hosts are allowed for a local ComfyUI endpoint (SSRF guard). */
function _isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0";
}

/**
 * Validate an entry's endpoint against a per-kind allowlist. Blocks the operator
 * overlay (or a stale default) from pointing a provider at an attacker host to
 * exfiltrate prompts. Returns true when the endpoint is safe for the kind.
 */
function _endpointAllowed(kind, endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (kind === "comfyui") return u.protocol === "http:" && _isLoopback(u.hostname);
  if (kind === "openai") return u.protocol === "https:" && (u.hostname === "api.openai.com" || u.hostname.endsWith(".openai.com"));
  if (kind === "pollinations") return u.protocol === "https:" && u.hostname.endsWith("pollinations.ai");
  return false; // unknown kind → deny
}

/** A well-formed, allowlisted registry entry, or null. */
function _sanitize(e) {
  if (!e || typeof e !== "object" || !e.id || !e.kind) return null;
  if (!_endpointAllowed(e.kind, e.endpoint)) return null;
  return {
    id: String(e.id),
    kind: String(e.kind),
    endpoint: String(e.endpoint),
    oss: !!e.oss,
    taskTypes: Array.isArray(e.taskTypes) ? e.taskTypes.map(String) : [],
    vramGB: Number(e.vramGB) || 0,
    supportsRefImage: !!e.supportsRefImage,
    cost: Number.isFinite(e.cost) ? e.cost : 1,
    rank: Number.isFinite(e.rank) ? e.rank : 100,
    enabled: e.enabled !== false,
    note: e.note ? String(e.note) : "",
  };
}

/** Merge the operator JSON overlay (by id) onto the built-in defaults. TTL-cached. */
function loadRegistry() {
  const now = Date.now();
  if (_cache.entries && now - _cache.at < CACHE_TTL_MS) return _cache.entries;

  const byId = new Map();
  for (const d of DEFAULTS) { const s = _sanitize(d); if (s) byId.set(s.id, s); }
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.providers) ? raw.providers : [];
    for (const e of list) {
      if (!e || !e.id) continue;
      const merged = _sanitize({ ...(byId.get(e.id) || {}), ...e });
      if (merged) byId.set(merged.id, merged); // drop entries that violate the allowlist
    }
  } catch {
    /* file missing or malformed → defaults only */
  }
  const entries = Array.from(byId.values());
  _cache = { at: now, entries };
  return entries;
}

/** Reset caches (tests / after an operator edit). */
function _resetCache() {
  _cache = { at: 0, entries: null };
  _reach.clear();
}

function getEntry(id) {
  if (!id) return null;
  return loadRegistry().find((e) => e.id === String(id)) || null;
}

/**
 * Is this provider reachable RIGHT NOW? Cheap + synchronous, from a memoized probe.
 *  - openai/pollinations: reachable iff its precondition holds (key present / always).
 *  - comfyui: reachable iff the last async probe said so (defaults to false until a
 *    probe completes — so before ComfyUI exists the chain safely falls to OpenAI).
 * Never blocks and never touches the API key value.
 */
function isReachable(entry) {
  const e = typeof entry === "object" ? entry : getEntry(entry);
  if (!e || !e.enabled) return false;
  if (e.kind === "openai") return !!process.env.OPENAI_API_KEY;
  if (e.kind === "pollinations") return true;
  if (e.kind === "comfyui") {
    const r = _reach.get(e.id);
    return !!(r && r.ok);
  }
  return false;
}

/**
 * Fire-and-forget async reachability probe for a comfyui-kind entry. 3s hard cap,
 * fails silent, memoized for REACH_TTL_MS. Safe to call from boot (non-blocking).
 */
async function probeReachable(entry) {
  const e = typeof entry === "object" ? entry : getEntry(entry);
  if (!e || e.kind !== "comfyui") return isReachable(e);
  const cached = _reach.get(e.id);
  if (cached && Date.now() - cached.at < REACH_TTL_MS) return cached.ok;
  let ok = false;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${e.endpoint.replace(/\/$/, "")}/system_stats`, { signal: ctrl.signal });
    ok = res.ok;
  } catch { ok = false; } finally { clearTimeout(to); }
  _reach.set(e.id, { at: Date.now(), ok });
  return ok;
}

/** Kick off a background probe of every comfyui provider. Non-blocking. */
function warmReachability() {
  for (const e of loadRegistry()) {
    if (e.kind === "comfyui") probeReachable(e).catch(() => {});
  }
}

/**
 * Ordered provider chain for a task, best-first. OSS-first rank-order:
 *   1. reachable OSS providers (rank asc, then cost asc)
 *   2. reachable closed providers (rank asc) — UNLESS IMAGE_OSS_ONLY=1
 * Unreachable providers are dropped. Image quality is subjective, so we use
 * rank-order (not capability-gating like the LLM registry).
 *
 * @param {string} taskType 'scene' | 'character'
 * @param {object} [opts] { ossOnly?:bool, includeUnreachable?:bool }
 * @returns {Array} provider entries, best-first (possibly empty)
 */
function resolveImageChain(taskType = "scene", opts = {}) {
  const ossOnly = typeof opts.ossOnly === "boolean" ? opts.ossOnly : process.env.IMAGE_OSS_ONLY === "1";
  const eligible = loadRegistry().filter(
    (e) => e.enabled && e.taskTypes.includes(taskType) && (opts.includeUnreachable || isReachable(e)),
  );
  const cmp = (a, b) => (a.rank - b.rank) || (a.cost - b.cost);
  const oss = eligible.filter((e) => e.oss).sort(cmp);
  const closed = ossOnly ? [] : eligible.filter((e) => !e.oss).sort(cmp);
  return [...oss, ...closed];
}

/** The single best provider for a task, or null when none is reachable. */
function resolveImageProvider(taskType = "scene", opts = {}) {
  return resolveImageChain(taskType, opts)[0] || null;
}

module.exports = {
  loadRegistry,
  getEntry,
  isReachable,
  probeReachable,
  warmReachability,
  resolveImageChain,
  resolveImageProvider,
  _endpointAllowed,
  _resetCache,
  DEFAULTS,
  REGISTRY_JSON_PATH,
};
