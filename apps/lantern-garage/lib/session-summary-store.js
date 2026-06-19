// Per-session rolling-summary persistence + context orchestration (issue #772).
//
// This is the I/O layer that sits on top of the pure budgeter in
// stream-chat/context-budget.js. It:
//   1. sources the FULL set of prior turns for a session from the conversation
//      log (the client only ships the last 6 — the older turns live here),
//   2. runs the token-budgeted assembler, and
//   3. persists the resulting rolling summary alongside the conversation log so
//      it survives log rotation and can later feed a session list (#773).
//
// Everything is best-effort: a failure to read the log or persist the summary
// must never break a chat reply, so the orchestrator degrades to the client's
// own history (the pre-#772 behaviour).

const path = require("path");
const { appendJsonlQueued, readJsonl } = require("./file-queue");
const { assembleBudgetedContext, contextWindowFor } = require("./stream-chat/context-budget");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const summaryLogPath = path.join(repoRoot, "data", "conversations", "session-summaries.jsonl");

// How many global log rows to scan when reconstructing one session. The log is
// shared across sessions/surfaces, so we read a generous window then filter.
const SESSION_LOG_READ_LIMIT = 400;

// Last persisted summary per session — avoids re-appending an identical line on
// every turn (writes only happen when the rolling summary actually changes).
const summaryCache = new Map();

// The rolling summary is deterministic, so after a process restart the cache is
// cold and the same summary would be re-appended as a duplicate on resume. Seed
// the cache from disk once (lazily, on first use) so dedup survives restarts.
let cacheSeeded = false;
function seedCacheOnce() {
  if (cacheSeeded) return;
  cacheSeeded = true;
  try {
    const rows = readJsonl(path.relative(repoRoot, summaryLogPath), 2000).filter((r) => !r.parseError);
    for (const r of rows) {
      if (r && r.sessionId && typeof r.summary === "string") summaryCache.set(r.sessionId, r.summary);
    }
  } catch {
    /* no summaries yet */
  }
}

function normalizeClientHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => {
      if (!h) return null;
      const text = String(h.text != null ? h.text : h.content != null ? h.content : "");
      if (!text) return null;
      return { role: h.role === "assistant" ? "assistant" : "user", text };
    })
    .filter(Boolean);
}

// Reconstruct a session's prior turns (oldest → newest) from the conversation
// log. operator → user, lantern → assistant; system/note rows are skipped.
function sessionTurnsFromLog(sessionId) {
  if (!sessionId) return [];
  let rows = [];
  try {
    const { readConversationLog } = require("./conversation-store");
    rows = readConversationLog(SESSION_LOG_READ_LIMIT, sessionId) || [];
  } catch {
    return [];
  }
  const turns = [];
  for (const r of rows) {
    const role = r.role === "lantern" ? "assistant" : r.role === "operator" ? "user" : null;
    if (!role) continue;
    const text = String(r.text || "");
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

function persistSummary(sessionId, summary, meta) {
  if (!sessionId || !summary) return Promise.resolve();
  seedCacheOnce();
  if (summaryCache.get(sessionId) === summary) return Promise.resolve(); // unchanged
  summaryCache.set(sessionId, summary);
  return appendJsonlQueued(summaryLogPath, {
    updatedAt: new Date().toISOString(),
    sessionId,
    summary,
    summarizedTurns: meta && meta.summarized != null ? meta.summarized : null,
    keptVerbatim: meta && meta.keptVerbatim != null ? meta.keptVerbatim : null,
  }).catch(() => {});
}

// Latest persisted rolling summary for a session, or null. Cheap (cache-first);
// useful out-of-band (e.g. a session list synopsis for #773).
function readSessionSummary(sessionId) {
  if (!sessionId) return null;
  seedCacheOnce();
  if (summaryCache.has(sessionId)) {
    return { sessionId, summary: summaryCache.get(sessionId) };
  }
  try {
    const rows = readJsonl(path.relative(repoRoot, summaryLogPath), 2000).filter((r) => !r.parseError);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].sessionId === sessionId) {
        summaryCache.set(sessionId, rows[i].summary);
        return rows[i];
      }
    }
  } catch {
    /* no summaries yet */
  }
  return null;
}

// Assemble the provider-ready `compacted` context for a streamed chat turn.
// Returns { compacted, meta }. `compacted` is a drop-in for the old
// compactHistory(history) output. Synchronous: the log read is sync and the
// summary persist is fire-and-forget.
function assembleSessionContext({ sessionId, clientHistory, currentMessage, requestedProvider, surfaceMode } = {}) {
  const maxOutputTokens = surfaceMode === "three-doors" ? 1536 : 1024;
  const contextWindow = contextWindowFor({ requestedProvider });

  const logTurns = sessionTurnsFromLog(sessionId);
  const cliTurns = normalizeClientHistory(clientHistory);
  // Prefer whichever source carries more context. A freshly-migrated session has
  // untagged (unfindable) log rows → fall back to the client's recent turns;
  // an established session has the full tagged log → use it (the actual win).
  const usingLog = logTurns.length >= cliTurns.length && logTurns.length > 0;
  const turns = usingLog ? logTurns : cliTurns;

  const { compacted, summary, meta } = assembleBudgetedContext({
    turns,
    currentMessage,
    contextWindow,
    maxOutputTokens,
  });

  if (sessionId && summary) {
    persistSummary(sessionId, summary, meta);
  }

  return {
    compacted,
    meta: {
      window: meta.window,
      kept: meta.keptVerbatim,
      summarized: meta.summarized,
      source: usingLog ? "session-log" : "client",
    },
  };
}

module.exports = {
  assembleSessionContext,
  readSessionSummary,
  normalizeClientHistory,
  sessionTurnsFromLog,
  summaryLogPath,
};
