"use strict";
/**
 * Confidence-decay memory (#1422) — memory that forgets gracefully.
 *
 * A stored fact's confidence decays on a forgetting curve from the last time it was
 * grounded; the retriever down-ranks stale facts so old, never-reconfirmed claims stop
 * dominating recall (the recurring "backlog issues stale, verify first" pain). Grounding
 * a memory again (reinforce) resets the clock AND extends its half-life — spaced
 * repetition: facts you keep confirming stick longer.
 *
 * The decay math is pure and takes `now` explicitly, so it's deterministic + testable.
 * JSONL persistence is the thin I/O layer.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const DAY_MS = 86_400_000;
const BASE_HALF_LIFE_DAYS = 14;     // a never-reinforced fact loses half its confidence in 2 weeks
const REINFORCE_BONUS = 0.5;        // each re-grounding extends the half-life by 50% of the base

function clamp01(x) { const n = Number(x); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

// Spaced repetition: more reinforcements → longer retention.
function effectiveHalfLifeDays(memory) {
  const base = Number(memory.halfLifeDays) > 0 ? Number(memory.halfLifeDays) : BASE_HALF_LIFE_DAYS;
  const reinforcements = Math.max(0, Number(memory.reinforcements) || 0);
  return base * (1 + reinforcements * REINFORCE_BONUS);
}

// Confidence now = base * 2^(-ageDays / halfLife), measured from the last grounding.
function decayedConfidence(memory, nowMs) {
  const base = clamp01(memory.baseConfidence != null ? memory.baseConfidence : 0.8);
  const lastMs = Date.parse(memory.lastGroundedAt || memory.createdAt || "") || nowMs;
  const ageDays = Math.max(0, (nowMs - lastMs) / DAY_MS);
  const hl = effectiveHalfLifeDays(memory);
  return clamp01(base * Math.pow(2, -ageDays / hl));
}

function staleness(confidence) {
  if (confidence >= 0.66) return "fresh";
  if (confidence >= 0.33) return "aging";
  return "stale";
}

// Annotate a memory with its decayed confidence + staleness at `nowMs`.
function scoreMemory(memory, nowMs) {
  const confidence = decayedConfidence(memory, nowMs);
  return { ...memory, confidence, staleness: staleness(confidence), halfLifeDays: effectiveHalfLifeDays(memory) };
}

// Retriever ordering: highest current confidence first; stale facts sink. Optionally
// drop anything under a floor so the retriever can ignore effectively-forgotten facts.
function rankMemories(memories, nowMs, { floor = 0 } = {}) {
  return (memories || [])
    .map((m) => scoreMemory(m, nowMs))
    .filter((m) => m.confidence >= floor)
    .sort((a, b) => b.confidence - a.confidence);
}

// Reinforce (re-ground): reset the decay clock and add a reinforcement so the half-life
// grows. Optionally lift base confidence toward 1. Pure — returns the updated memory.
function reinforceMemory(memory, nowIso) {
  const reinforcements = (Math.max(0, Number(memory.reinforcements) || 0)) + 1;
  const base = clamp01(memory.baseConfidence != null ? memory.baseConfidence : 0.8);
  return { ...memory, lastGroundedAt: nowIso, reinforcements, baseConfidence: clamp01(base + (1 - base) * 0.34) };
}

// ── thin JSONL persistence ──────────────────────────────────────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "memory", "decay-memory.jsonl"); }

function readMemories(root) {
  try {
    return fs.readFileSync(_file(root), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function _writeAll(root, memories) {
  const f = _file(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, memories.map((m) => JSON.stringify(m)).join("\n") + (memories.length ? "\n" : ""));
}

function createMemory(root, input, nowIso) {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("text is required");
  const memory = {
    id: `mem:${crypto.randomUUID()}`,
    text: text.slice(0, 2000),
    source: String(input.source || "manual").slice(0, 120),
    baseConfidence: clamp01(input.baseConfidence != null ? input.baseConfidence : 0.8),
    halfLifeDays: Number(input.halfLifeDays) > 0 ? Number(input.halfLifeDays) : BASE_HALF_LIFE_DAYS,
    reinforcements: 0,
    createdAt: nowIso,
    lastGroundedAt: nowIso,
  };
  const all = readMemories(root); all.push(memory); _writeAll(root, all);
  return memory;
}

function reinforceById(root, id, nowIso) {
  const all = readMemories(root);
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  all[idx] = reinforceMemory(all[idx], nowIso);
  _writeAll(root, all);
  return all[idx];
}

module.exports = {
  DAY_MS, BASE_HALF_LIFE_DAYS,
  effectiveHalfLifeDays, decayedConfidence, staleness, scoreMemory, rankMemories, reinforceMemory,
  readMemories, createMemory, reinforceById,
};
