// Unit tests for A3 — measured speech features from a transcript, and the
// scorer's use of them. Standalone: `node tests/test_speech_features.js`.

"use strict";

const assert = require("assert");
const {
  parseWhisperJson, deriveSpeechFeatures, classifyHook,
} = require("../apps/lantern-garage/lib/speech-features");
const { deriveSignals } = require("../src/creator-intelligence/scoring/viral-score-v10");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// ── transcript parsing ───────────────────────────────────────────────────────
test("parseWhisperJson accepts {segments:[...]} and a bare array, sorts", () => {
  const a = parseWhisperJson(JSON.stringify({ segments: [
    { start: 2, end: 3, text: "later" }, { start: 0, end: 1, text: "first" },
  ] }));
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].text, "first"); // sorted by start
  const b = parseWhisperJson(JSON.stringify([{ start: 0, end: 1, text: "x" }]));
  assert.strictEqual(b.length, 1);
  assert.deepStrictEqual(parseWhisperJson("not json"), []);
});

// ── hook classification ──────────────────────────────────────────────────────
test("classifyHook recognizes question / countdown / shock / reaction / text", () => {
  assert.strictEqual(classifyHook("How do I get more views?"), "question");
  assert.strictEqual(classifyHook("Top 5 plays of the week"), "countdown");
  assert.strictEqual(classifyHook("3 tips for editing"), "countdown");
  assert.strictEqual(classifyHook("This is insane"), "shock");
  assert.strictEqual(classifyHook("oh my god watch this"), "reaction");
  assert.strictEqual(classifyHook("today we are cooking"), "text");
  assert.strictEqual(classifyHook(""), "unknown");
});

// ── feature derivation ───────────────────────────────────────────────────────
const SEGMENTS = [
  { start: 0.0, end: 2.0, text: "How did this even happen?" }, // 5 words, question hook
  { start: 2.0, end: 6.0, text: "Watch the whole clutch unfold here now" }, // 7 words
  { start: 10.0, end: 12.0, text: "Make sure to subscribe for more" }, // CTA at 10s, 6 words
];

test("deriveSpeechFeatures: words/sec, coverage, hook, CTA, dead air", () => {
  const f = deriveSpeechFeatures(SEGMENTS, 20);
  assert.strictEqual(f.measured, true);
  assert.strictEqual(f.hookStyle, "question");
  assert.strictEqual(f.wordCount, 18);
  assert.strictEqual(f.wordsPerSec, 0.9); // 18 / 20
  assert.strictEqual(f.speechCoverage, 0.4); // (2 + 4 + 2) / 20
  assert.strictEqual(f.ctaPresent, true);
  assert.strictEqual(f.ctaTimeSec, 10);
  assert.strictEqual(f.ctaPosition, "mid"); // 10s of 20s
  assert.strictEqual(f.deadAirMaxSec, 8); // gap 6s→10s is 4; trail 12s→20s is 8 (largest)
});

test("deriveSpeechFeatures: no transcript → measured:false, no guesses", () => {
  const f = deriveSpeechFeatures([], 20);
  assert.strictEqual(f.measured, false);
  assert.strictEqual(f.wordsPerSec, null);
  assert.strictEqual(f.hookStyle, "unknown");
  assert.strictEqual(f.ctaPresent, false);
});

// ── scorer integration ───────────────────────────────────────────────────────
test("deriveSignals surfaces measured speech features when present", () => {
  const speech = deriveSpeechFeatures(SEGMENTS, 20);
  const analysis = {
    duration: 20,
    highlights: [{ start: 1, end: 3, duration: 2, score: 0.6, tags: ["audio"] }],
    metadata: { speech },
  };
  const s = deriveSignals(analysis);
  assert.strictEqual(s.speechMeasured, true);
  assert.strictEqual(s.wordsPerSec, 0.9);
  assert.strictEqual(s.hookStyle, "question");
  assert.strictEqual(s.ctaPresent, true);
  assert.strictEqual(s.deadAirMaxSec, 8);
});

test("deriveSignals leaves speech null when no transcript present", () => {
  const s = deriveSignals({ duration: 20, highlights: [] });
  assert.strictEqual(s.speechMeasured, false);
  assert.strictEqual(s.wordsPerSec, null);
  assert.strictEqual(s.hookStyle, null);
});

console.log(`\n${passed} checks passed.`);
