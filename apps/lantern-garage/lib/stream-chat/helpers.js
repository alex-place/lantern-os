"use strict";
// Shared, provider-agnostic helpers for the streaming chat path.
//
// Extracted from stream-chat.js so the orchestrator stays lean and each concern
// is a small, focused file a 200k-context coding agent can load on its own.
// Nothing here depends on per-request closure state — pure-ish functions only.

const path = require("path");
const { saveDoorChoice } = require("../csf-memory");
const { generateDoorSceneImage } = require("../image-generation");

// Fallback doors when AI omits the marker or provider fails.
const FALLBACK_DOORS = ["Tell me more about that", "What happened next?", "How are you feeling about it?"];

// Conversation history compaction thresholds (richer RP context — issue #332).
const FULL_FIDELITY_RECENT_TURNS = 6;
const MID_FIDELITY_TURNS = 4;
const MID_FIDELITY_CHAR_LIMIT = 400;
const LOW_FIDELITY_WORD_LIMIT = 10;

// Log truncation metrics to track information loss.
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
    appendJsonlQueued(metricsPath, metric).catch(() => {});
  } catch (e) {
    // Best-effort logging; never block on metric failure
  }
}

// Conversation history compaction: tiered summarization to reduce provider token
// costs. Only compacts turns older than the most recent FULL_FIDELITY_RECENT_TURNS
// exchanges; never re-compacts already-compacted text (FlowKV principle).
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

// Parse [DOORS: A | B | C] out of the full reply and return cleaned text + doors.
// Local models (Ollama) sometimes use commas instead of pipes — fall back gracefully.
function extractDoors(text) {
  const match = text.match(/\[DOORS:\s*([^\]]+)\]?/i);
  if (!match) return { cleanText: text.trim(), doors: [] };
  let doors = match[1].split("|").map((d) => d.trim()).filter(Boolean).slice(0, 3);
  if (doors.length < 3) {
    const commaSplit = match[1].split(/,\s*(?=[A-Z])/).map((d) => d.trim()).filter(Boolean).slice(0, 3);
    if (commaSplit.length > doors.length) doors = commaSplit;
  }
  const cleanText = text.replace(/\[DOORS:[^\]]*\]?/i, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, doors };
}

function doorsOrFallback(text, skipDoors = false) {
  if (skipDoors) return { cleanText: text.trim(), suggestions: [] };
  const { cleanText, doors } = extractDoors(text);
  let finalDoors;
  if (doors.length >= 3) {
    finalDoors = doors.slice(0, 3);
  } else if (doors.length > 0) {
    finalDoors = [...doors, ...FALLBACK_DOORS].slice(0, 3);
  } else {
    finalDoors = FALLBACK_DOORS;
  }
  if (doors.length > 0) {
    try { saveDoorChoice(null, finalDoors); } catch {}
  }
  return { cleanText, suggestions: finalDoors };
}

// Extract key topics from user message and generate 3 web search suggestion links.
function generateWebSuggestions(userMessage) {
  const topicPatterns = {
    sports: /\b(basketball|football|baseball|soccer|hockey|tennis|golf|cricket|boxing)s?\b/i,
    trains: /\b(trains?|railways?|locomotives?|stations?|transit|rails?)\b/i,
    recipes: /\b(recipes?|cooking|cook|meals?|dishes?|foods?|ingredients?)\b/i,
    movies: /\b(movies?|films?|cinemas?|watch|actors?|actresses?|directors?)\b/i,
    music: /\b(musics?|songs?|albums?|artists?|concerts?|bands?|genres?)\b/i,
    tech: /\b(technology|software|hardware|ai|code|programming|apps?)\b/i,
    travel: /\b(travels?|trips?|destinations?|vacations?|hotels?|flights?|tours?)\b/i,
    science: /\b(science|research|studies?|discoveries?|experiments?|biology|physics)\b/i,
    news: /\b(news|current|todays?|today's|latest|breaking)\b/i,
    health: /\b(health|fitness|diets?|exercises?|wellness|nutrition)\b/i,
  };

  let matchedTopics = [];
  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(userMessage)) matchedTopics.push(topic);
  }

  if (matchedTopics.length === 0) {
    const words = userMessage.split(/\s+/).filter((w) => w.length > 4 && !/^(what|when|where|which|how|about)$/i.test(w));
    if (words.length > 0) matchedTopics.push(words[0].toLowerCase());
  }

  const topicLabel = matchedTopics[0] || "interesting topics";
  return [
    { label: "Explore on Google", url: `https://www.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "🔍" },
    { label: "Latest on Wikipedia", url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(topicLabel)}&title=Special:Search`, icon: "📖" },
    { label: "News & Articles", url: `https://news.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "📰" },
  ];
}

// Non-blocking image generation sidecar for Three Doors mode.
function triggerImageGeneration({ cleanText, suggestions, surfaceMode, symbolMesh }) {
  if (surfaceMode !== "three-doors") return null;
  const entryId = Date.now().toString();
  generateDoorSceneImage({ cleanText, doors: suggestions, symbolMesh, entryId })
    .then(() => { /* async; failure non-blocking */ })
    .catch(() => { /* non-blocking */ });
  return entryId;
}

module.exports = {
  FALLBACK_DOORS,
  FULL_FIDELITY_RECENT_TURNS,
  MID_FIDELITY_TURNS,
  MID_FIDELITY_CHAR_LIMIT,
  LOW_FIDELITY_WORD_LIMIT,
  logTruncationMetric,
  compactHistory,
  buildProviderMessages,
  extractDoors,
  doorsOrFallback,
  generateWebSuggestions,
  triggerImageGeneration,
};
