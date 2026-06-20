// Unit tests for B1 — hook-first variant assembly. Every variant must open with
// a strong segment (intro retention is the #1 lever), while each strategy keeps
// its identity. Standalone: `node tests/test_variant_hookfirst.js`.

"use strict";

const assert = require("assert");
const {
  selectSegments, generateVariantsV10,
} = require("../src/creator-intelligence/scoring/variant-engine-v10");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// Highlights with distinct scores and chronological order. Strongest = h_0.95.
const H = [
  { start: 2,  end: 6,  duration: 4, score: 0.40, tags: ["motion"] },
  { start: 10, end: 14, duration: 4, score: 0.95, tags: ["motion", "audio"] }, // strongest
  { start: 20, end: 24, duration: 4, score: 0.55, tags: ["audio"] },
  { start: 30, end: 34, duration: 4, score: 0.80, tags: ["scene", "audio"] },  // 2nd strongest
  { start: 40, end: 44, duration: 4, score: 0.20, tags: ["motion"] },
];
const maxScore = Math.max(...H.map((h) => h.score));

test("story_arc opens with the strongest hook, then chronological", () => {
  const seg = selectSegments(H, "story_arc", 60);
  assert.strictEqual(seg[0].score, maxScore, "cold open with strongest");
  const rest = seg.slice(1);
  const starts = rest.map((s) => s.start);
  assert.deepStrictEqual(starts, [...starts].sort((a, b) => a - b), "rest is chronological");
});

test("maximum_rewatch opens strong AND ends on the single strongest (payoff)", () => {
  const seg = selectSegments(H, "maximum_rewatch", 60);
  assert.strictEqual(seg[seg.length - 1].score, maxScore, "peak last");
  assert.ok(seg[0].score >= 0.55, "opener is a strong hook, not the weakest");
  // The old behavior opened with the WEAKEST (ascending); guard against regression.
  const minScore = Math.min(...H.map((h) => h.score));
  assert.notStrictEqual(seg[0].score, minScore, "must not open with the weakest");
});

test("maximum_retention / excitement / balanced still open strong", () => {
  for (const strat of ["maximum_retention", "maximum_excitement", "balanced"]) {
    const seg = selectSegments(H, strat, 60);
    assert.ok(seg[0].score >= 0.8, `${strat} opens with a top segment (got ${seg[0].score})`);
  }
});

test("every generated variant opens strong and reports introStrength", () => {
  const res = generateVariantsV10({ duration: 50, highlights: H }, {});
  assert.strictEqual(res.variants.length, 5);
  for (const v of res.variants) {
    assert.ok(v.segments.length > 0, `${v.strategy} has segments`);
    assert.strictEqual(v.introStrength, v.segments[0].score, "introStrength = opener score");
    assert.ok(v.introStrength >= 0.5, `${v.strategy} opens strong (introStrength ${v.introStrength})`);
  }
});

test("degenerate input: 1 highlight still yields a valid opener", () => {
  const one = [{ start: 0, end: 5, duration: 5, score: 0.6, tags: [] }];
  for (const strat of ["maximum_rewatch", "story_arc", "balanced"]) {
    const seg = selectSegments(one, strat, 60);
    assert.strictEqual(seg.length, 1);
    assert.strictEqual(seg[0].score, 0.6);
  }
});

console.log(`\n${passed} checks passed.`);
