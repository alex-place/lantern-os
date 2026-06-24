// Conversation-history compaction + provider message assembly for stream-chat.
// Tiered summarization keeps recent turns full-fidelity and progressively compacts
// older ones to cut provider token cost without re-compacting already-compacted text.
const path = require("path");

// Conversation history compaction thresholds.
// Tuned for richer RP context (issue #332 — journal/Three Doors felt flat).
const FULL_FIDELITY_RECENT_TURNS = 6;
const MID_FIDELITY_TURNS = 4;
const MID_FIDELITY_CHAR_LIMIT = 400;
const LOW_FIDELITY_WORD_LIMIT = 10;

// Log truncation metrics so information loss from compaction is measurable.
function logTruncationMetric(originalChars, truncatedChars, truncationType) {
  try {
    const metricsPath = path.resolve(__dirname, "../../../data/truncation-metrics.jsonl");
    const metric = {
      timestamp: new Date().toISOString(),
      originalChars,
      truncatedChars,
      charsSaved: originalChars - truncatedChars,
      truncationType, // "mid_fidelity" or "low_fidelity"
      compressionRatio: truncatedChars / originalChars,
    };
    const { appendJsonlQueued } = require("../file-queue");
    appendJsonlQueued(metricsPath, metric, { rotate: true }).catch(() => {}); // #872 per-message hot path
  } catch (e) {
    // Best-effort logging; never block on metric failure
  }
}

// Tiered summarization to reduce provider token costs. Only compacts turns older
// than the most recent FULL_FIDELITY_RECENT_TURNS exchanges; never re-compacts
// already-compacted text (FlowKV principle).
function compactHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return history.map((h, i) => {
    const text = String(h.text != null ? h.text : (h.content != null ? h.content : ""));
    const role = h.role || "user";
    if (i >= history.length - FULL_FIDELITY_RECENT_TURNS) {
      return { role, text }; // Full fidelity, no truncation
    }
    if (i >= history.length - FULL_FIDELITY_RECENT_TURNS - MID_FIDELITY_TURNS) {
      if (text.length > MID_FIDELITY_CHAR_LIMIT) {
        const truncated = text.slice(0, MID_FIDELITY_CHAR_LIMIT) + "…";
        logTruncationMetric(text.length, truncated.length, "mid_fidelity");
        return { role, text: truncated };
      }
      return { role, text };
    }
    // Low fidelity: first N words only
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, LOW_FIDELITY_WORD_LIMIT).join(" ");
    const roleLabel = role === "assistant" ? "Keystone" : "Dreamer";
    const summary = words.length > 0 ? `[${roleLabel}: ${words}…]` : `[${roleLabel}]`;
    logTruncationMetric(text.length, summary.length, "low_fidelity");
    return { role, text: summary };
  });
}

// Build the provider messages array from compacted history + current message.
// Single source of truth — all providers call this instead of inlining history.map.
function buildProviderMessages(systemPrompt, compacted, currentMessage) {
  return [
    { role: "system", content: systemPrompt },
    ...compacted.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: currentMessage },
  ];
}

module.exports = {
  FULL_FIDELITY_RECENT_TURNS,
  MID_FIDELITY_TURNS,
  MID_FIDELITY_CHAR_LIMIT,
  LOW_FIDELITY_WORD_LIMIT,
  logTruncationMetric,
  compactHistory,
  buildProviderMessages,
};
