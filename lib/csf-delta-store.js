/**
 * CSF Delta Store — JS layer for dream journal symbolic memory.
 *
 * Implements:
 *   1. Symbol dictionary  — frequency-sorted token table; recurring symbols
 *      get compact IDs (s:0, s:1, …) instead of full strings.
 *   2. Delta log  — each new dream entry writes only what changed vs the
 *      previous record (new tags, removed tags, mood delta, etc.) plus
 *      full text (text diffs aren't worth the complexity).
 *   3. Delta-aware context formatter  — enriches prompt context with
 *      trending symbols, emotional arc, and convergence score so Lantern
 *      sees patterns across sessions, not just the latest entry.
 *
 * Files written:
 *   data/csf_memory/symbolic-dict.json   — symbol dictionary (persisted)
 *   data/csf_memory/deltas.jsonl         — append-only delta log
 */

"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const CSF_DIR = path.join(repoRoot, "data", "csf_memory");
const DICT_PATH = path.join(CSF_DIR, "symbolic-dict.json");
const DELTA_PATH = path.join(CSF_DIR, "deltas.jsonl");

// ── Symbol Dictionary ────────────────────────────────────────────────────────

class SymDict {
  constructor() {
    this.tokenToId = {};   // token → "s:N"
    this.idToToken = {};   // "s:N" → token
    this.freq = {};        // token → count
    this._next = 0;
  }

  static load() {
    const d = new SymDict();
    try {
      if (fs.existsSync(DICT_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DICT_PATH, "utf8"));
        d.tokenToId = raw.tokenToId || {};
        d.idToToken = raw.idToToken || {};
        d.freq = raw.freq || {};
        d._next = raw._next || 0;
      }
    } catch { /* fresh dict */ }
    return d;
  }

  save() {
    _ensureDir(CSF_DIR);
    fs.writeFileSync(DICT_PATH, JSON.stringify({
      tokenToId: this.tokenToId,
      idToToken: this.idToToken,
      freq: this.freq,
      _next: this._next,
      updated_at: new Date().toISOString(),
    }, null, 2));
  }

  // Register tokens, return their IDs (new tokens are assigned IDs)
  encode(tokens) {
    const ids = [];
    for (const raw of tokens) {
      const t = String(raw || "").toLowerCase().trim();
      if (!t) continue;
      this.freq[t] = (this.freq[t] || 0) + 1;
      if (!this.tokenToId[t]) {
        const id = `s:${this._next++}`;
        this.tokenToId[t] = id;
        this.idToToken[id] = t;
      }
      ids.push(this.tokenToId[t]);
    }
    return ids;
  }

  decode(ids) {
    return ids.map(id => this.idToToken[id] || id);
  }

  // Top N by frequency — used for "recurring symbols" context
  topN(n = 10) {
    return Object.entries(this.freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([token, count]) => ({ token, count }));
  }

  // Symbols seen >= minCount times
  recurring(minCount = 2) {
    return Object.entries(this.freq)
      .filter(([, c]) => c >= minCount)
      .sort((a, b) => b[1] - a[1])
      .map(([token, count]) => ({ token, count }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _setDiff(a, b) {
  const setB = new Set(b);
  return a.filter(x => !setB.has(x));
}

function _arrEquals(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function _coerce(v, fallback = 0) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

// ── Delta computation ─────────────────────────────────────────────────────────

function computeDelta(entry, prevDelta, dict) {
  const prevTags = prevDelta ? dict.decode(prevDelta.tags_ids || []) : [];
  const prevSymbols = prevDelta ? dict.decode(prevDelta.symbols_ids || []) : [];
  const prevEmotions = prevDelta ? dict.decode(prevDelta.emotions_ids || []) : [];
  const prevMood = prevDelta ? _coerce(prevDelta.mood_abs) : null;
  const prevLucidity = prevDelta ? _coerce(prevDelta.lucidity_abs) : null;

  const curTags = Array.isArray(entry.tags) ? entry.tags.map(String) : [];
  const curSymbols = Array.isArray(entry.symbols) ? entry.symbols.map(String) : [];
  const curEmotions = Array.isArray(entry.emotions) ? entry.emotions.map(String) : [];
  const curMood = _coerce(entry.mood);
  const curLucidity = _coerce(entry.lucidity);

  // Register with dictionary
  const tagsIds = dict.encode(curTags);
  const symbolsIds = dict.encode(curSymbols);
  const emotionsIds = dict.encode(curEmotions);

  const tagsAdded = _setDiff(curTags, prevTags);
  const tagsRemoved = _setDiff(prevTags, curTags);
  const symbolsAdded = _setDiff(curSymbols, prevSymbols);
  const emotionsAdded = _setDiff(curEmotions, prevEmotions);

  // Convergence score: fraction of symbols shared with previous entry
  const allPrev = new Set([...prevTags, ...prevSymbols, ...prevEmotions]);
  const allCur = new Set([...curTags, ...curSymbols, ...curEmotions]);
  let convergence = 0;
  if (allPrev.size > 0 && allCur.size > 0) {
    const shared = [...allCur].filter(x => allPrev.has(x)).length;
    convergence = parseFloat((shared / Math.max(allPrev.size, allCur.size)).toFixed(3));
  }

  return {
    type: prevDelta ? "delta" : "full",
    id: `d:${Date.now()}`,
    base_id: prevDelta ? prevDelta.id : null,
    ts: entry.timestamp || new Date().toISOString(),
    source: "dream_journal",
    kind: entry.kind || "dream",

    // Full text always — diffs aren't readable enough to be useful
    text: String(entry.text || ""),

    // Dictionary-encoded symbol IDs (compact)
    tags_ids: tagsIds,
    symbols_ids: symbolsIds,
    emotions_ids: emotionsIds,

    // Human-readable deltas (for context rendering)
    tags_added: tagsAdded,
    tags_removed: tagsRemoved,
    symbols_added: symbolsAdded,
    emotions_added: emotionsAdded,

    // Numeric absolutes + deltas
    mood_abs: curMood,
    mood_delta: prevMood !== null ? parseFloat((curMood - prevMood).toFixed(3)) : null,
    lucidity_abs: curLucidity,
    lucidity_delta: prevLucidity !== null ? parseFloat((curLucidity - prevLucidity).toFixed(3)) : null,

    // Convergence with previous entry
    convergence,

    // Sparse flag: skip writing if nothing changed (tags same, text same)
    _sparse: prevDelta
      && entry.text === prevDelta.text
      && _arrEquals(curTags, prevTags)
      && _arrEquals(curSymbols, prevSymbols),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function readDeltas(limit = 50) {
  if (!fs.existsSync(DELTA_PATH)) return [];
  const lines = fs.readFileSync(DELTA_PATH, "utf8").trim().split("\n").filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records.slice(-limit);
}

/**
 * Ingest a new dream entry into the delta log.
 * Returns the written delta record, or null if skipped (sparse/no change).
 */
function ingestEntry(entry) {
  try {
    _ensureDir(CSF_DIR);
    const dict = SymDict.load();
    const existing = readDeltas(1);
    const prev = existing.length > 0 ? existing[existing.length - 1] : null;
    const delta = computeDelta(entry, prev, dict);

    if (delta._sparse) return null; // nothing changed — skip write

    delete delta._sparse;
    dict.save();
    fs.appendFileSync(DELTA_PATH, JSON.stringify(delta) + "\n");
    return delta;
  } catch (e) {
    console.error("[csf-delta] ingestEntry error:", e.message);
    return null;
  }
}

/**
 * Build delta-aware context string for prompt injection.
 *
 * Adds three layers on top of basic csf-memory context:
 *   1. Recurring symbols  — tokens appearing >= 2 times across all sessions
 *   2. Recent delta       — what changed in the last entry (new symbols, mood shift)
 *   3. Emotional arc      — mood trend over last 5 entries (rising / falling / stable)
 */
function formatDeltaContextForPrompt(message) {
  try {
    const dict = SymDict.load();
    const deltas = readDeltas(20);
    if (deltas.length === 0) return "";

    const parts = [];

    // 1. Recurring symbols
    const recurring = dict.recurring(2).slice(0, 8);
    if (recurring.length > 0) {
      const list = recurring.map(({ token, count }) => `${token}(×${count})`).join(", ");
      parts.push(`Recurring symbols: ${list}`);
    }

    // 2. Recent delta (last entry's changes)
    const last = deltas[deltas.length - 1];
    const deltaLines = [];
    if (last.symbols_added && last.symbols_added.length > 0)
      deltaLines.push(`new symbols: ${last.symbols_added.join(", ")}`);
    if (last.tags_added && last.tags_added.length > 0)
      deltaLines.push(`new tags: ${last.tags_added.join(", ")}`);
    if (last.tags_removed && last.tags_removed.length > 0)
      deltaLines.push(`dropped tags: ${last.tags_removed.join(", ")}`);
    if (last.mood_delta !== null && Math.abs(last.mood_delta) >= 0.05)
      deltaLines.push(`mood shift: ${last.mood_delta > 0 ? "+" : ""}${last.mood_delta}`);
    if (last.convergence > 0)
      deltaLines.push(`convergence: ${(last.convergence * 100).toFixed(0)}%`);
    if (deltaLines.length > 0)
      parts.push(`Last entry delta: ${deltaLines.join("; ")}`);

    // 3. Emotional arc over last 5 entries
    const moodSeries = deltas
      .filter(d => d.mood_abs !== undefined && d.mood_abs !== null)
      .slice(-5)
      .map(d => d.mood_abs);
    if (moodSeries.length >= 3) {
      const first = moodSeries[0], last5 = moodSeries[moodSeries.length - 1];
      const diff = last5 - first;
      const arc = Math.abs(diff) < 0.1 ? "stable" : diff > 0 ? "rising" : "falling";
      parts.push(`Mood arc (last ${moodSeries.length}): ${arc} (${first.toFixed(1)} → ${last5.toFixed(1)})`);
    }

    // 4. Convergence trend (are sessions getting more coherent?)
    const convSeries = deltas.filter(d => d.convergence > 0).slice(-5).map(d => d.convergence);
    if (convSeries.length >= 3) {
      const avg = convSeries.reduce((a, b) => a + b, 0) / convSeries.length;
      parts.push(`Symbolic convergence avg: ${(avg * 100).toFixed(0)}%`);
    }

    return parts.join("\n");
  } catch { return ""; }
}

/**
 * Return dict stats for debugging / status endpoint.
 */
function getDictStats() {
  try {
    const dict = SymDict.load();
    return {
      total_symbols: Object.keys(dict.tokenToId).length,
      top10: dict.topN(10),
      delta_count: readDeltas(1000).length,
    };
  } catch { return { total_symbols: 0, top10: [], delta_count: 0 }; }
}

module.exports = {
  ingestEntry,
  readDeltas,
  formatDeltaContextForPrompt,
  getDictStats,
  SymDict,
};
