// Unit tests for A1 — measured shot-boundary metrics and the scorer's use of them.
// Standalone: `node tests/test_shot_metrics.js`. Pure functions, no ffmpeg/video.

"use strict";

const assert = require("assert");
const { computeShotMetrics } = require("../apps/lantern-garage/lib/highlight-engine");
const { deriveSignals } = require("../src/creator-intelligence/scoring/viral-score-v10");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

const sc = (...ts) => ts.map((t) => ({ timestamp: t, difference: 0.5 }));

// ── computeShotMetrics ───────────────────────────────────────────────────────
test("even cuts → correct cut rate, mean shot length, zero CV", () => {
  const m = computeShotMetrics(sc(10, 20, 30, 40, 50), 60, 0.3);
  assert.strictEqual(m.measured, true);
  assert.strictEqual(m.count, 5);
  assert.strictEqual(m.cutsPerMin, 5); // 5 cuts / 60s * 60
  assert.strictEqual(m.avgShotLengthSec, 10); // six 10s shots
  assert.strictEqual(m.shotLengthCV, 0);
  assert.strictEqual(m.source, "ffmpeg_scene_hsv");
});

test("no cuts → one continuous shot (honest, not faked)", () => {
  const m = computeShotMetrics([], 30, 0.3);
  assert.strictEqual(m.measured, true);
  assert.strictEqual(m.count, 0);
  assert.strictEqual(m.cutsPerMin, 0);
  assert.strictEqual(m.avgShotLengthSec, 30);
  assert.strictEqual(m.shotLengthCV, 0);
});

test("uneven cut → CV reflects shot-length spread", () => {
  const m = computeShotMetrics(sc(10), 100, 0.3); // shots: 10s, 90s
  assert.strictEqual(m.count, 1);
  assert.strictEqual(m.avgShotLengthSec, 50);
  assert.strictEqual(m.shotLengthCV, 0.8); // std 40 / mean 50
});

test("out-of-range and duplicate boundaries are dropped", () => {
  // -1 (<0), 0 (not >0), 30 (not <dur), 35 (>dur), dup 5 → only one valid (5).
  const m = computeShotMetrics(sc(-1, 0, 5, 5, 30, 35), 30, 0.3);
  assert.strictEqual(m.count, 1);
});

test("unusable duration → measured:false, no invented numbers", () => {
  const m = computeShotMetrics(sc(1, 2), 0, 0.3);
  assert.strictEqual(m.measured, false);
  assert.strictEqual(m.cutsPerMin, null);
  assert.strictEqual(m.avgShotLengthSec, null);
});

// ── deriveSignals prefers measured cuts over the highlight-count proxy ────────
test("deriveSignals uses MEASURED cutsPerMin when shotBoundaries present", () => {
  const analysis = {
    duration: 60,
    highlights: [{ start: 1, end: 3, duration: 2, score: 0.6, tags: ["motion"] }],
    metadata: { shotBoundaries: { measured: true, cutsPerMin: 42, avgShotLengthSec: 1.4 } },
  };
  const s = deriveSignals(analysis);
  assert.strictEqual(s.cutsPerMin, 42);
  assert.strictEqual(s.cutsPerMinMeasured, true);
  assert.strictEqual(s.avgShotLengthSec, 1.4);
});

test("deriveSignals falls back to proxy (flagged) when no shotBoundaries", () => {
  const analysis = {
    duration: 60, // 1 min
    highlights: [
      { start: 1, end: 3, duration: 2, score: 0.6, tags: ["motion"] },
      { start: 10, end: 12, duration: 2, score: 0.6, tags: ["audio"] },
      { start: 20, end: 22, duration: 2, score: 0.6, tags: ["scene"] },
    ],
  };
  const s = deriveSignals(analysis);
  assert.strictEqual(s.cutsPerMin, 3); // 3 highlights / 1 min (proxy)
  assert.strictEqual(s.cutsPerMinMeasured, false);
  assert.strictEqual(s.avgShotLengthSec, null);
});

test("deriveSignals ignores shotBoundaries when measured:false", () => {
  const analysis = {
    duration: 60,
    highlights: [{ start: 1, end: 3, duration: 2, score: 0.6, tags: [] }],
    metadata: { shotBoundaries: { measured: false, cutsPerMin: null } },
  };
  const s = deriveSignals(analysis);
  assert.strictEqual(s.cutsPerMinMeasured, false);
  assert.strictEqual(s.cutsPerMin, 1); // proxy: 1 highlight / 1 min
});

console.log(`\n${passed} checks passed.`);
