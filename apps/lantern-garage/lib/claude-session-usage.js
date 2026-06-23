"use strict";

/**
 * Claude session usage — reads the local Claude Code session transcripts and
 * aggregates how much the project actually leans on Claude.
 *
 * Claude Code stores per-project transcripts at:
 *   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 * where <cwd-slug> is the working dir with ":" and path separators each
 * replaced by a single dash (C:\dev\lantern-os -> C--dev-lantern-os).
 *
 * Every `type:"assistant"` record carries message.model + message.usage, so we
 * can count real Claude turns + output tokens by model and time band. This is
 * the only persisted source of cloud-Claude reliance — the chat path only ever
 * updated an in-memory health flag (see provider-router / model-leaderboard).
 *
 * Σ₀: every number here is evidence (a real transcript turn), not an estimate.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Cache the scan — reading dozens of multi-MB transcripts on every dashboard
// poll would be wasteful. Transcripts are append-only so a short TTL is safe.
let _cache = null;
let _cacheKey = "";
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function projectSlug(cwd) {
  // C:\dev\lantern-os -> C--dev-lantern-os (colon + each separator -> one dash)
  return String(cwd || "").replace(/[:\\/]/g, "-");
}

function sessionsDir(cwd) {
  const base = process.env.CLAUDE_PROJECTS_DIR
    || path.join(os.homedir(), ".claude", "projects");
  return path.join(base, projectSlug(cwd));
}

const BANDS = { "24h": 1, "7d": 7, "30d": 30 };

/**
 * Aggregate Claude reliance for the given working directory.
 * @returns {object|null} null when no transcript dir exists (e.g. cloud deploy).
 */
function loadClaudeSessionUsage(cwd) {
  const dir = sessionsDir(cwd);

  // Cache keyed on dir so a cwd change re-scans.
  if (_cache && _cacheKey === dir && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null; // No Claude Code transcripts on this machine.
  }

  const now = Date.now();
  const byModel = {};      // model -> { turns, outputTokens }
  const bandTurns = { "24h": 0, "7d": 0, "30d": 0, all: 0 };
  const sessions = new Set();
  let turns = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let firstTs = null;
  let lastTs = null;

  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== "assistant" || !rec.message) continue;

      const model = rec.message.model || "unknown";
      if (model === "<synthetic>" || model === "unknown") continue;

      const u = rec.message.usage || {};
      const out = u.output_tokens || 0;
      const inp = (u.input_tokens || 0)
        + (u.cache_read_input_tokens || 0)
        + (u.cache_creation_input_tokens || 0);

      turns += 1;
      outputTokens += out;
      inputTokens += inp;
      if (rec.sessionId) sessions.add(rec.sessionId);

      if (!byModel[model]) byModel[model] = { turns: 0, outputTokens: 0 };
      byModel[model].turns += 1;
      byModel[model].outputTokens += out;

      const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : null;
      if (ts) {
        if (firstTs == null || ts < firstTs) firstTs = ts;
        if (lastTs == null || ts > lastTs) lastTs = ts;
        const ageDays = (now - ts) / 86400000;
        bandTurns.all += 1;
        for (const [b, days] of Object.entries(BANDS)) {
          if (ageDays <= days) bandTurns[b] += 1;
        }
      } else {
        bandTurns.all += 1;
      }
    }
  }

  const result = {
    source: "claude-code-transcripts",
    dir,
    turns,
    outputTokens,
    inputTokens,
    sessions: sessions.size,
    firstTs: firstTs ? new Date(firstTs).toISOString() : null,
    lastTs: lastTs ? new Date(lastTs).toISOString() : null,
    byModel,
    bandTurns,
  };

  _cache = result;
  _cacheKey = dir;
  _cacheAt = Date.now();
  return result;
}

function clearCache() { _cache = null; _cacheAt = 0; }

module.exports = { loadClaudeSessionUsage, projectSlug, sessionsDir, clearCache };
