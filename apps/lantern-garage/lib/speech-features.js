// Lantern — speech features from a transcript (A3)
// Turns a Whisper transcript into MEASURED narrative features: hook style, CTA
// placement, caption density (words/sec), speech coverage, and the largest dead-air
// gap to cut. The transcription itself (Whisper) is a heavy external dependency and
// lives in a thin wrapper; the feature DERIVATION below is pure and unit-tested.
//
// HONESTY: every feature traces to real transcript segments. No transcript =>
// measured:false with nulls — never an inferred-from-audio-energy guess.
//
// See docs/creator-v10/editing-analysis-model-research.md (A3)

"use strict";

const { spawn } = require("child_process");

// Schema-aligned hook styles (src/creator-intelligence/dataset/schema.js HOOK_STYLES).
const QUESTION_STARTERS = ["who", "what", "when", "where", "why", "how", "which", "can", "do", "does", "is", "are", "should", "would"];
const SHOCK_WORDS = ["insane", "crazy", "unbelievable", "never", "stop", "wait", "shocking", "nobody", "secret"];
const REACTION_WORDS = ["oh my", "what the", "no way", "omg", "holy", "i can't believe"];
const CTA_PHRASES = ["subscribe", "follow", "comment", "like and", "smash the", "hit the", "link in bio", "check out", "turn on notifications", "share this", "drop a"];

function wordsIn(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Parse Whisper JSON (openai-whisper / faster-whisper --output_format json) into
 * a normalized segment list. Tolerant: accepts {segments:[...]} or a bare array.
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function parseWhisperJson(jsonText) {
  let obj;
  try { obj = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText; }
  catch { return []; }
  const segs = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.segments) ? obj.segments : null);
  if (!segs) return [];
  return segs
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || "").trim() }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start);
}

function classifyHook(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "unknown";
  if (t.includes("?") || QUESTION_STARTERS.includes(t.split(/\s+/)[0])) return "question";
  if (/^\s*\d/.test(t) || /\btop \d+\b/.test(t) || /\b\d+\s+(things|ways|tips|reasons|facts)\b/.test(t)) return "countdown";
  if (REACTION_WORDS.some((w) => t.includes(w))) return "reaction";
  if (t.includes("!") || SHOCK_WORDS.some((w) => t.includes(w))) return "shock";
  return "text";
}

/**
 * Derive measured speech features from transcript segments.
 * @param {Array<{start,end,text}>} segments
 * @param {number} durationSec
 * @param {Object} opts  { hookWindowSec=3 }
 */
function deriveSpeechFeatures(segments, durationSec, opts = {}) {
  const dur = Number(durationSec);
  const none = {
    measured: false, hasSpeech: false, hookStyle: "unknown",
    wordsPerSec: null, wordCount: 0, speechCoverage: null,
    ctaPresent: false, ctaTimeSec: null, ctaPosition: null, deadAirMaxSec: null,
  };
  if (!Array.isArray(segments) || segments.length === 0 || !Number.isFinite(dur) || dur <= 0) {
    return none;
  }
  const segs = [...segments].sort((a, b) => a.start - b.start);
  const hookWindow = opts.hookWindowSec ?? 3;

  const wordCount = segs.reduce((s, seg) => s + wordsIn(seg.text).length, 0);
  const speechSec = segs.reduce((s, seg) => s + Math.max(0, seg.end - seg.start), 0);

  // Hook = text spoken inside the opening window.
  const hookText = segs.filter((s) => s.start < hookWindow).map((s) => s.text).join(" ");

  // First CTA phrase and where it lands.
  let ctaTimeSec = null;
  for (const seg of segs) {
    const lt = seg.text.toLowerCase();
    if (CTA_PHRASES.some((p) => lt.includes(p))) { ctaTimeSec = Number(seg.start.toFixed(2)); break; }
  }
  const ctaPosition = ctaTimeSec === null ? null
    : (ctaTimeSec < dur / 3 ? "early" : ctaTimeSec > (2 * dur) / 3 ? "end" : "mid");

  // Largest dead-air gap (including lead-in and trail-out).
  let maxGap = segs[0].start; // silence before first words
  for (let i = 1; i < segs.length; i++) maxGap = Math.max(maxGap, segs[i].start - segs[i - 1].end);
  maxGap = Math.max(maxGap, dur - segs[segs.length - 1].end);

  return {
    measured: true,
    hasSpeech: wordCount > 0,
    hookStyle: classifyHook(hookText),
    wordsPerSec: Number((wordCount / dur).toFixed(3)),
    wordCount,
    speechCoverage: Number(Math.min(1, speechSec / dur).toFixed(3)),
    ctaPresent: ctaTimeSec !== null,
    ctaTimeSec,
    ctaPosition,
    deadAirMaxSec: Number(maxGap.toFixed(2)),
  };
}

/**
 * Thin best-effort transcription wrapper. Requires the `whisper` CLI on PATH and a
 * model; honestly returns {measured:false, reason} if unavailable rather than
 * fabricating. NOT unit-tested (external dependency). The analysis pipeline can
 * call this and store the result on timeline.metadata.speech.
 */
function transcribeToSpeechFeatures(videoPath, durationSec, opts = {}) {
  return new Promise((resolve) => {
    const args = ["--model", opts.model || "base", "--output_format", "json", "--output_dir", opts.outDir || ".", videoPath];
    let stdout = "";
    let proc;
    try { proc = spawn(opts.bin || "whisper", args); }
    catch { return resolve({ ...deriveSpeechFeatures([], durationSec), reason: "whisper_unavailable" }); }
    proc.stdout && proc.stdout.on("data", (d) => { stdout += d; });
    proc.on("error", () => resolve({ ...deriveSpeechFeatures([], durationSec), reason: "whisper_unavailable" }));
    proc.on("close", () => {
      const segments = parseWhisperJson(stdout);
      resolve(deriveSpeechFeatures(segments, durationSec, opts));
    });
  });
}

/**
 * Best-effort, flag-gated, NON-FATAL attachment of speech features onto an
 * analysis timeline's metadata. Designed for the analysis job-worker: when
 * disabled (default) or when transcription fails/yields nothing, it is a no-op
 * and the timeline is untouched — analysis never blocks on Whisper.
 *
 * @param {Object} timeline   HighlightTimeline (has .metadata)
 * @param {string} videoPath
 * @param {number} durationSec
 * @param {Object} opts  { enabled?, transcribe? (injectable for tests), ...whisperOpts }
 * @returns {Promise<Object|null>} the attached speech features, or null
 */
async function maybeAttachSpeech(timeline, videoPath, durationSec, opts = {}) {
  const enabled = opts.enabled !== undefined ? opts.enabled : process.env.LANTERN_CI_SPEECH === "1";
  if (!enabled) return null;
  const transcribe = opts.transcribe || transcribeToSpeechFeatures;
  try {
    const speech = await transcribe(videoPath, durationSec, opts);
    if (speech && speech.measured) {
      timeline.metadata = timeline.metadata || {};
      timeline.metadata.speech = speech;
      return speech;
    }
  } catch { /* non-fatal: analysis must never fail because of speech */ }
  return null;
}

module.exports = {
  parseWhisperJson, deriveSpeechFeatures, classifyHook, transcribeToSpeechFeatures,
  maybeAttachSpeech,
};
