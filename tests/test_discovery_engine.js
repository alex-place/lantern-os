// Unit tests for the Editing Discovery Engine — segmentation, unsupervised
// pattern mining, gated performance, and playbook. Standalone:
// `node tests/test_discovery_engine.js`. Pure functions, no disk/network.

"use strict";

const assert = require("assert");
const { segmentClip, timeBucket, roleFor } = require("../src/creator-intelligence/discovery/segment");
const { minePatterns, nameSequence } = require("../src/creator-intelligence/discovery/pattern-mining");
const { buildPlaybook } = require("../src/creator-intelligence/discovery/playbook");
const { discoverFromClips } = require("../src/creator-intelligence/discovery");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

const hl = (start, end, score, tags) => ({ start, end, score, tags });

// A clip whose beats read hook → surprise → payoff.
const clipHSP = (id) => ({
  id,
  analysis: {
    duration: 30,
    highlights: [
      hl(0.5, 2, 0.7, ["motion"]),        // hook (early)
      hl(8, 11, 0.8, ["motion", "novel"]), // surprise (multi/novel)
      hl(25, 29, 0.9, ["motion", "audio"]),// payoff (late + strong)
    ],
    metadata: { speech: { measured: true, hookStyle: "question", ctaPresent: false } },
  },
});

// ── segmentation ─────────────────────────────────────────────────────────────
test("timeBucket maps seconds to the spec buckets", () => {
  assert.strictEqual(timeBucket(0.5), "0-1s");
  assert.strictEqual(timeBucket(2), "1-3s");
  assert.strictEqual(timeBucket(5), "3-7s");
  assert.strictEqual(timeBucket(12), "7-15s");
  assert.strictEqual(timeBucket(40), "15s+");
});

test("segmentClip labels roles from measured signals + collapses runs", () => {
  const s = segmentClip(clipHSP("c1"));
  assert.deepStrictEqual(s.roleSequence, ["hook", "surprise", "payoff"]);
  assert.strictEqual(s.beats[0].bucket, "0-1s");
});

test("CTA role comes only from a measured A3 call-to-action in-window", () => {
  const beat = { start: 20, end: 24, score: 0.9, tags: [] };
  const speech = { measured: true, ctaPresent: true, ctaTimeSec: 22 };
  assert.strictEqual(roleFor(beat, 30, speech), "cta");
  // No CTA detected → not labeled cta.
  assert.notStrictEqual(roleFor(beat, 30, { measured: true, ctaPresent: false }), "cta");
});

// ── pattern naming + mining ──────────────────────────────────────────────────
test("nameSequence uses friendly template names where known", () => {
  assert.strictEqual(nameSequence(["hook", "surprise", "payoff"]), "Quick Payoff");
  assert.strictEqual(nameSequence(["hook", "build", "surprise", "payoff"]), "Delayed Reveal");
  assert.strictEqual(nameSequence(["build", "cta"]), "Build → Cta"); // generic fallback
});

test("a sequence shared by >=3 clips becomes a discovered pattern", () => {
  const clips = ["a", "b", "c", "d"].map(clipHSP).map(segmentClip);
  const { patterns } = minePatterns(clips);
  const hsp = patterns.find((p) => p.sequence.join(">") === "hook>surprise>payoff");
  assert.ok(hsp, "the hook→surprise→payoff pattern is discovered");
  assert.strictEqual(hsp.frequency, 4);
  assert.strictEqual(hsp.label, "Quick Payoff");
});

test("a sequence in <3 clips is NOT promoted to a pattern", () => {
  const clips = [clipHSP("a"), clipHSP("b")].map(segmentClip); // only 2
  const { patterns } = minePatterns(clips);
  assert.strictEqual(patterns.length, 0, "below MIN_CLIPS_FOR_PATTERN");
});

// ── performance gating (the honesty contract) ────────────────────────────────
test("performance is insufficient_data without enough labeled outcomes", () => {
  const clips = ["a", "b", "c", "d"].map(clipHSP).map(segmentClip);
  const { patterns } = minePatterns(clips, { outcomesByClipId: { a: 60, b: 55 } }); // only 2 labeled
  const p = patterns[0];
  assert.strictEqual(p.performance.status, "insufficient_data");
  assert.strictEqual(p.performance.have, 2);
});

test("performance becomes directional once enough examples are labeled", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const clips = ids.map(clipHSP).map(segmentClip);
  const outcomesByClipId = {}; ids.forEach((id, i) => { outcomesByClipId[id] = 50 + i; });
  const { patterns, labeledClips } = minePatterns(clips, { outcomesByClipId, metricName: "avgPercentViewed" });
  assert.strictEqual(labeledClips, 6);
  const p = patterns.find((x) => x.sequence.join(">") === "hook>surprise>payoff");
  assert.strictEqual(p.performance.status, "ok");
  assert.strictEqual(p.performance.basis, "directional"); // 6 labeled: >=5 but <20
  assert.strictEqual(p.performance.calibrated, false);
  assert.strictEqual(p.performance.n, 6);
  assert.ok(typeof p.performance.avg === "number");
});

// ── playbook + end-to-end ────────────────────────────────────────────────────
test("buildPlaybook mirrors the gated status (never 'verified' without data)", () => {
  const clips = ["a", "b", "c"].map(clipHSP).map(segmentClip);
  const { patterns } = minePatterns(clips);
  const { techniques } = buildPlaybook(patterns);
  assert.ok(techniques.length >= 1);
  assert.strictEqual(techniques[0].status, "insufficient_data");
  assert.ok(Array.isArray(techniques[0].steps) && techniques[0].steps.length >= 2);
});

test("discoverFromClips end-to-end: structural-only when no outcomes", () => {
  const clips = ["a", "b", "c", "d"].map(clipHSP);
  const res = discoverFromClips(clips);
  assert.strictEqual(res.clips, 4);
  assert.strictEqual(res.labeledClips, 0);
  assert.ok(res.patterns.length >= 1);
  assert.ok(/Structural discovery only/.test(res.note));
  assert.ok(res.playbook.techniques.every((t) => t.status === "insufficient_data"));
});

console.log(`\n${passed} checks passed.`);
