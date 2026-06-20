// Unit tests for A2 — unsupervised audio-visual recurrence novelty.
// Standalone: `node tests/test_recurrence_novelty.js`. Pure functions.

"use strict";

const assert = require("assert");
const {
  noveltyScores, recurrenceHighlights, framesToWindows, MIN_WINDOWS,
} = require("../apps/lantern-garage/lib/recurrence-novelty");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

const win = (t, motion, loudness, scene) => ({ t, vec: { motion, loudness, scene } });

test("too few windows → no scores (can't define 'typical')", () => {
  const out = noveltyScores([win(0, 5, 5, 1), win(2, 5, 5, 1)]);
  assert.strictEqual(out.length, 0);
  assert.ok(MIN_WINDOWS >= 4);
});

test("UNIFORM clip → zero novelty everywhere (no manufactured peaks)", () => {
  const ws = [0, 2, 4, 6, 8, 10].map((t) => win(t, 5, 5, 1));
  const out = noveltyScores(ws);
  assert.strictEqual(out.length, 6);
  assert.ok(out.every((o) => o.novelty === 0), "uniform input must not invent contrast");
});

test("a single salient outlier window scores highest, typical windows stay low", () => {
  const ws = [
    win(0, 3, 4, 0), win(2, 4, 5, 1), win(4, 5, 4, 0), win(6, 4, 5, 1),
    win(8, 3, 4, 0), win(10, 5, 5, 1), win(12, 4, 4, 0),
    win(14, 40, 50, 10), // clear standout
  ];
  const out = noveltyScores(ws);
  const peak = out[out.length - 1];
  const others = out.slice(0, -1);
  assert.strictEqual(Math.max(...out.map((o) => o.novelty)), peak.novelty, "outlier is the argmax");
  assert.ok(peak.novelty >= 0.9, `outlier novelty high (got ${peak.novelty})`);
  assert.ok(Math.max(...others.map((o) => o.novelty)) <= 0.4, "typical windows stay low");
});

test("a LOW/quiet window is NOT salient (directional: novelty 0)", () => {
  const ws = [
    win(0, 5, 5, 1), win(2, 6, 5, 1), win(4, 5, 6, 1), win(6, 6, 5, 1),
    win(8, 5, 6, 1), win(10, 6, 5, 1),
    win(12, 0, 0, 0), // far BELOW typical — a still, silent gap, not a highlight
  ];
  const out = noveltyScores(ws);
  const low = out[out.length - 1];
  assert.strictEqual(low.novelty, 0, "below-typical window must score 0");
  assert.notStrictEqual(Math.max(...out.map((o) => o.novelty)), low.novelty);
});

test("recurrenceHighlights: outlier → one span; uniform → none", () => {
  const outlier = [
    win(0, 3, 4, 0), win(2, 4, 5, 1), win(4, 5, 4, 0), win(6, 4, 5, 1),
    win(8, 3, 4, 0), win(10, 5, 5, 1), win(12, 40, 50, 10),
  ];
  const spans = recurrenceHighlights(outlier, 2, { threshold: 0.5 });
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].reason, "recurrence_novelty");
  assert.ok(spans[0].start <= 12 && spans[0].end >= 12);

  const uniform = [0, 2, 4, 6, 8, 10].map((t) => win(t, 5, 5, 1));
  assert.deepStrictEqual(recurrenceHighlights(uniform, 2), [], "nothing stands out → no spans");
});

test("framesToWindows bins per-frame series into salient feature vectors", () => {
  const series = {
    motion: [{ timestamp: 0.5, motion: 10 }, { timestamp: 2.5, motion: 20 }],
    audio: [{ timestamp: 0.5, loudness: 0.4 }],
    scene: [{ timestamp: 2.6, difference: 0.7 }, { timestamp: 2.9, difference: 0.8 }],
  };
  const ws = framesToWindows(series, 4, 2);
  assert.strictEqual(ws.length, 2);
  assert.strictEqual(ws[0].vec.motion, 10);
  assert.strictEqual(ws[1].vec.motion, 20);
  assert.strictEqual(ws[0].vec.scene, 0);
  assert.strictEqual(ws[1].vec.scene, 2); // two scene changes landed in window 1
});

console.log(`\n${passed} checks passed.`);
