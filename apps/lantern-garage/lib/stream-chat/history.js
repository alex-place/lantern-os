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

// Micro-compaction for the IN-TURN tool loop (REMEMBER stage). A long agentic turn
// pushes one "The <name> tool returned:\n<output>" user message per tool call
// (stream-chat.js local Ollama loop). Over several iterations these stale results
// crowd a small local context window (8K) and can derail a weak local model into
// repetition/timeout (the local-fallback crash class, #1369). This keeps the most
// recent `keepRecentResults` tool results verbatim (the model needs the latest to
// continue) and collapses older ones to a one-line stub. Pure + non-destructive
// (returns a new array); a NO-OP when there are <= keepRecentResults results, so a
// normal short tool turn is unchanged.
const TOOL_RESULT_PREFIX = /^The (.+?) tool returned:\n/;

function compactToolLoopMessages(messages, { keepRecentResults = 2 } = {}) {
  if (!Array.isArray(messages)) return messages;
  const resultIdx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string" && TOOL_RESULT_PREFIX.test(m.content)) {
      resultIdx.push(i);
    }
  }
  if (resultIdx.length <= keepRecentResults) return messages.slice();
  const toStub = new Set(resultIdx.slice(0, resultIdx.length - keepRecentResults));
  return messages.map((m, i) => {
    if (!toStub.has(i)) return m;
    const name = (m.content.match(TOOL_RESULT_PREFIX) || [])[1] || "tool";
    const body = m.content.replace(TOOL_RESULT_PREFIX, "");
    return { ...m, content: `The ${name} tool returned: [${body.length} chars elided to save context]` };
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
  compactToolLoopMessages,
  buildProviderMessages,
};
