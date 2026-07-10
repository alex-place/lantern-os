const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { appendJsonlQueued, readJsonl, rotateJsonlIfNeeded } = require("./file-queue");
const { redactPII } = require("./redact");

const { dataRoot, stateRoot } = require("./app-paths");
// #1946 G2: writable state roots at dataRoot() — <repoRoot>/data on servers
// (unchanged), %APPDATA%\unisona\data on the desktop app. readJsonl paths are made
// relative to stateRoot() (not repoRoot) so reads resolve through file-queue's
// data/-aware anchor in both profiles.
const repoRoot = path.resolve(__dirname, "..", "..", "..");
// Per-user conversation storage: a logged-in user's turns live in an isolated
// per-profile file so history follows the PROFILE (any device), not the client's
// localStorage sessionId, and one user's chats are never returned to another.
// Guests (no profile) + legacy untagged turns stay in this shared device-local
// log, always scoped by sessionId at read time (never dumped wholesale).
const conversationLogPath = path.join(dataRoot(), "conversations", "garage-conversations.jsonl");
const usersConversationsRoot = path.join(dataRoot(), "conversations", "users");
const operatorNotesPath = path.join(dataRoot(), "operator-notes", "notes.jsonl");
const maxConversationTextLength = 4000;

/**
 * Normalize a profile id into a filesystem-safe storage key. Profile ids are hex
 * / numeric / "local-owner" (session-identity.js), so the common path is a no-op;
 * anything that could escape the directory is hashed to a safe token. Returns null
 * for guests (no id) → the shared device-local log.
 */
function safeUserId(userId) {
  if (userId == null) return null;
  const s = String(userId).trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{1,80}$/.test(s)) return s;
  return "u_" + crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** Absolute path to the conversation log for a user (per-profile), or the shared
 *  guest/legacy log when userId is absent. */
function conversationFileFor(userId) {
  const uid = safeUserId(userId);
  return uid
    ? path.join(usersConversationsRoot, uid, "conversations.jsonl")
    : conversationLogPath;
}
// #771 — bound the append-only conversation log. Rotate to timestamped archives past the
// size cap and keep only the most recent N. Tunable via env.
const conversationLogMaxBytes = Math.max(64 * 1024, Number(process.env.CONV_LOG_MAX_BYTES) || 5 * 1024 * 1024);
const conversationLogKeepArchives = Math.max(0, Number(process.env.CONV_LOG_KEEP_ARCHIVES) || 5);

function normalizeConversationEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }

  const role = String(input.role || "operator").trim().toLowerCase();
  // "session-title" is a metadata overlay turn: a user-assigned chat name that
  // lives in the same append-only log (latest wins). It never renders as a chat
  // turn (loadConversationHistory filters to operator/lantern) and is excluded
  // from a session's turn count — see /api/conversations/sessions.
  const allowedRoles = new Set(["operator", "lantern", "system", "note", "session-title"]);
  const text = String(input.text || "").trim();
  const surface = String(input.surface || "garage").trim().slice(0, 80) || "garage";
  const sessionId = input.sessionId ? String(input.sessionId).trim().slice(0, 64) : null;
  // Owning profile id (per-user storage). Resolved server-side from the session —
  // callers must pass the authenticated id, never a client-supplied value. null =
  // guest (device-local, keyed by sessionId).
  const userId = safeUserId(input.userId);

  if (!allowedRoles.has(role)) {
    throw new Error("invalid_conversation_role");
  }
  if (!text) {
    throw new Error("conversation_text_required");
  }

  // #1268: optional PCSF signature (provider/model/agent) so a *replayed* turn can show
  // the same "unisona.ai · provider/model" signature the live SSE 'done' event carries.
  // Entirely additive — entries without it (the vast majority, today) replay exactly as
  // before; omitted/non-string fields are simply dropped rather than rejecting the entry.
  let meta;
  if (input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)) {
    const m = {};
    for (const k of ["provider", "model", "agent"]) {
      if (typeof input.meta[k] === "string" && input.meta[k].trim()) m[k] = input.meta[k].trim().slice(0, 120);
    }
    // #1270: a structured tool payload so a *replayed* tool turn rebuilds the same
    // rich element (generated image, YouTube embed, document download) instead of
    // showing only its plain-text description. Bounded + whitelisted by kind/field.
    const t = input.meta.tool;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const allowedKinds = new Set(["image", "youtube", "document"]);
      const kind = typeof t.kind === "string" ? t.kind.trim().toLowerCase() : "";
      if (allowedKinds.has(kind)) {
        const tool = { kind };
        for (const k of ["url", "label"]) {
          if (typeof t[k] === "string" && t[k].trim()) tool[k] = t[k].trim().slice(0, 2000);
        }
        for (const k of ["prompt", "query", "title", "filename", "format", "note"]) {
          if (typeof t[k] === "string" && t[k].trim()) tool[k] = t[k].trim().slice(0, 500);
        }
        if (typeof t.bytes === "number" && isFinite(t.bytes)) tool.bytes = Math.max(0, Math.floor(t.bytes));
        m.tool = tool;
      }
    }
    if (Object.keys(m).length) meta = m;
  }

  return {
    recordedAt: new Date().toISOString(),
    surface,
    role,
    // #770: redact high-confidence PII / secrets at rest so a log leak exposes far less.
    text: redactPII(text.slice(0, maxConversationTextLength)),
    sessionId,
    ...(userId ? { userId } : {}),
    ...(meta ? { meta } : {}),
  };
}

async function appendConversationEntry(entry) {
  // Route to the owning profile's file (per-user), or the shared guest/legacy log.
  const target = conversationFileFor(entry && entry.userId);
  await appendJsonlQueued(target, entry);
  // #771: keep the file bounded — rotate + prune once it exceeds the cap (serialized
  // behind the append in the same per-path write queue).
  return rotateJsonlIfNeeded(target, {
    maxBytes: conversationLogMaxBytes,
    keepArchives: conversationLogKeepArchives,
  });
}

function rotateConversationLogIfNeeded() {
  return rotateJsonlIfNeeded(conversationLogPath, {
    maxBytes: conversationLogMaxBytes,
    keepArchives: conversationLogKeepArchives,
  });
}

function readConversationLog(limit = 50, sessionId = null, userId = null) {
  // Read one identity's log: the per-user file when userId is given, else the
  // shared guest/legacy log. When scoped to a session, read a bounded larger
  // window then filter, so the last `limit` *session* turns survive interleaving.
  const target = conversationFileFor(userId);
  const window = sessionId ? 2000 : limit;
  const all = readJsonl(path.relative(stateRoot(), target), window)
    .filter((entry) => !entry.parseError);
  if (!sessionId) return all;
  return all.filter((entry) => entry.sessionId === sessionId).slice(-limit);
}

/** Every per-user conversation file plus the shared guest/legacy log. */
function allConversationFiles() {
  const files = [conversationLogPath];
  try {
    for (const uid of fs.readdirSync(usersConversationsRoot)) {
      const p = path.join(usersConversationsRoot, uid, "conversations.jsonl");
      if (fs.existsSync(p)) files.push(p);
    }
  } catch { /* no per-user dir yet */ }
  return files;
}

/**
 * Operator-only cross-user read: merge the guest/legacy log with every per-user
 * file, newest-last by recordedAt. NEVER expose to a non-operator caller — this is
 * the whole-instance view.
 */
function readAllConversations(limit = 2000) {
  const rows = [];
  for (const file of allConversationFiles()) {
    const part = readJsonl(path.relative(stateRoot(), file), limit).filter((e) => !e.parseError);
    for (const r of part) rows.push(r);
  }
  rows.sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")));
  return rows.slice(-limit);
}

/**
 * Clear conversation history, archiving the touched file(s) first.
 *   { userId, sessionId } → that user's file (one session, or all their sessions)
 *   { sessionId }         → the guest/legacy log, that session only
 *   { all: true }         → every file (operator admin reset)
 * Returns { removed, scope }.
 */
function clearConversations({ userId = null, sessionId = null, all = false } = {}) {
  const targets = all ? allConversationFiles() : [conversationFileFor(userId)];
  let removed = 0;
  for (const file of targets) {
    let lines = [];
    try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); }
    catch { continue; /* missing == already empty */ }
    if (!lines.length) continue;
    // Archive before mutating (matches the pre-per-user DELETE behaviour).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.copyFileSync(file, path.join(path.dirname(file), `garage-conversations.cleared-${stamp}.jsonl.bak`)); }
    catch { /* best-effort archive */ }
    if (sessionId && !all) {
      const kept = [];
      for (const line of lines) {
        let obj = null;
        try { obj = JSON.parse(line); } catch { kept.push(line); continue; }
        if (obj && obj.sessionId === sessionId) removed += 1;
        else kept.push(line);
      }
      fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
    } else {
      removed += lines.length;
      fs.writeFileSync(file, "");
    }
  }
  return { removed, scope: all ? "all" : sessionId ? "session" : "user" };
}

function normalizeRagCacheItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }
  const text = (value, fallback, maxLength) => String(value || fallback).trim().slice(0, maxLength);
  const allowedSourceTypes = new Set(["official_source", "web_secondary", "external_llm", "operator_asserted"]);
  const allowedDecisions = new Set(["promote", "candidate", "hold", "reject"]);
  const sourceType = text(input.sourceType, "operator_asserted", 80);
  const decision = text(input.decision, "candidate", 40);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0.5)));
  const claim = text(input.claim, "", 500);
  const compressedSummary = text(input.compressedSummary, claim, 1200);
  if (!claim) {
    throw new Error("rag_claim_required");
  }
  return {
    timestamp: new Date().toISOString(),
    topic: text(input.topic, "operator form intake", 160),
    claim,
    sourceUrl: text(input.sourceUrl, "", 500),
    sourceTitle: text(input.sourceTitle, "Lantern OS form intake", 220),
    sourceType: allowedSourceTypes.has(sourceType) ? sourceType : "operator_asserted",
    rightsState: "summary_only",
    evidenceClass: "operator_asserted",
    confidence,
    decision: allowedDecisions.has(decision) ? decision : "candidate",
    compressedSummary,
  };
}

async function appendExternalRagItem(input) {
  const record = normalizeRagCacheItem(input);
  const cachePath = path.join(dataRoot(), "rag-intake", "external-llm-web-cache", "cache.jsonl");
  await appendJsonlQueued(cachePath, record);
  return record;
}

function readOperatorQueue() {
  const items = [];
  const notes = readJsonl(path.relative(stateRoot(), operatorNotesPath), 50).filter(n => !n.parseError);
  for (const note of notes) {
    items.push({ type: "note", title: note.text, priority: note.priority || "P2", owner: "operator", source: "local", createdAt: note.createdAt });
  }
  items.sort((a, b) => {
    const pa = parseInt(a.priority?.replace("P", "") ?? "9");
    const pb = parseInt(b.priority?.replace("P", "") ?? "9");
    return pa - pb;
  });
  return items;
}

module.exports = {
  normalizeConversationEntry,
  appendConversationEntry,
  rotateConversationLogIfNeeded,
  readConversationLog,
  readAllConversations,
  clearConversations,
  conversationFileFor,
  safeUserId,
  normalizeRagCacheItem,
  appendExternalRagItem,
  readOperatorQueue,
};
