const path = require("path");
const { appendJsonlQueued, readJsonl, rotateJsonlIfNeeded } = require("./file-queue");
const { redactPII } = require("./redact");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const conversationLogPath = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");
const operatorNotesPath = path.join(repoRoot, "data", "operator-notes", "notes.jsonl");
const maxConversationTextLength = 4000;
// #771 — bound the append-only conversation log. Rotate to timestamped archives past the
// size cap and keep only the most recent N. Tunable via env.
const conversationLogMaxBytes = Math.max(64 * 1024, Number(process.env.CONV_LOG_MAX_BYTES) || 5 * 1024 * 1024);
const conversationLogKeepArchives = Math.max(0, Number(process.env.CONV_LOG_KEEP_ARCHIVES) || 5);

function normalizeConversationEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("json_object_required");
  }

  const role = String(input.role || "operator").trim().toLowerCase();
  const allowedRoles = new Set(["operator", "lantern", "system", "note"]);
  const text = String(input.text || "").trim();
  const surface = String(input.surface || "garage").trim().slice(0, 80) || "garage";
  const sessionId = input.sessionId ? String(input.sessionId).trim().slice(0, 64) : null;

  if (!allowedRoles.has(role)) {
    throw new Error("invalid_conversation_role");
  }
  if (!text) {
    throw new Error("conversation_text_required");
  }

  return {
    recordedAt: new Date().toISOString(),
    surface,
    role,
    // #770: redact high-confidence PII / secrets at rest so a log leak exposes far less.
    text: redactPII(text.slice(0, maxConversationTextLength)),
    sessionId,
  };
}

async function appendConversationEntry(entry) {
  await appendJsonlQueued(conversationLogPath, entry);
  // #771: keep the file bounded — rotate + prune once it exceeds the cap (serialized
  // behind the append in the same per-path write queue).
  return rotateJsonlIfNeeded(conversationLogPath, {
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

function readConversationLog(limit = 50, sessionId = null) {
  // When scoped to a session, read a bounded larger window then filter,
  // so the last `limit` *session* turns survive interleaving from other sessions.
  const window = sessionId ? 2000 : limit;
  const all = readJsonl(path.relative(repoRoot, conversationLogPath), window)
    .filter((entry) => !entry.parseError);
  if (!sessionId) return all;
  return all.filter((entry) => entry.sessionId === sessionId).slice(-limit);
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
  const cachePath = path.join(repoRoot, "data", "rag-intake", "external-llm-web-cache", "cache.jsonl");
  await appendJsonlQueued(cachePath, record);
  return record;
}

function readOperatorQueue() {
  const items = [];
  const notes = readJsonl(path.relative(repoRoot, operatorNotesPath), 50).filter(n => !n.parseError);
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
  normalizeRagCacheItem,
  appendExternalRagItem,
  readOperatorQueue,
};
