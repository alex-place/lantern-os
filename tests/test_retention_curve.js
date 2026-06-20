// Unit tests for A4 — audience-retention curve import, analysis, and alignment.
// Standalone: `node tests/test_retention_curve.js`. Pure functions, no network.

"use strict";

const assert = require("assert");
const { parseRetentionCsv } = require("../src/creator-intelligence/calibration/retention-curve-import");
const {
  curveMetrics, attributeCliffToSegments, retentionOutcomeMetrics, retentionAt,
} = require("../src/creator-intelligence/calibration/retention-analysis");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// ── parsing ──────────────────────────────────────────────────────────────────
test("parseRetentionCsv: ratio columns normalized to [0,1], sorted", () => {
  const csv = [
    "Elapsed video time ratio,Absolute audience retention",
    "0.00,1.00",
    "0.50,0.62",
    "0.25,0.80",
  ].join("\n");
  const r = parseRetentionCsv(csv);
  assert.strictEqual(r.recognized, true);
  assert.strictEqual(r.points.length, 3);
  assert.strictEqual(r.points[0].position, 0); // sorted ascending
  assert.strictEqual(r.points[1].position, 0.25);
  assert.strictEqual(r.points[2].retention, 0.62);
});

test("parseRetentionCsv: percentage columns auto-divided by 100", () => {
  const csv = [
    "Video position (%),Audience retention (%)",
    "0,100",
    "50,55",
    "100,30",
  ].join("\n");
  const r = parseRetentionCsv(csv);
  assert.strictEqual(r.points[0].position, 0);
  assert.strictEqual(r.points[1].position, 0.5);
  assert.strictEqual(r.points[2].retention, 0.3);
});

test("parseRetentionCsv: unrecognized headers → empty, not fabricated", () => {
  const r = parseRetentionCsv("foo,bar\n1,2\n");
  assert.strictEqual(r.recognized, false);
  assert.strictEqual(r.points.length, 0);
});

// ── analysis ─────────────────────────────────────────────────────────────────
const CURVE = [
  { position: 0.0, retention: 1.0 },
  { position: 0.1, retention: 0.9 },
  { position: 0.2, retention: 0.85 },
  { position: 0.5, retention: 0.4 }, // big cliff between 0.2 and 0.5
  { position: 1.0, retention: 0.35 },
];

test("retentionAt interpolates between samples", () => {
  assert.strictEqual(retentionAt(CURVE, 0.0), 1.0);
  assert.strictEqual(Number(retentionAt(CURVE, 0.05).toFixed(3)), 0.95); // midpoint of 1.0→0.9
});

test("curveMetrics: intro retention, mean, and the steepest cliff", () => {
  const m = curveMetrics(CURVE, { introRatio: 0.1 });
  assert.strictEqual(m.introRetention, 0.9);
  assert.ok(m.meanRetention > 0 && m.meanRetention < 1);
  assert.ok(m.maxCliff, "should find a cliff");
  assert.strictEqual(m.maxCliff.from, 0.85);
  assert.strictEqual(m.maxCliff.to, 0.4); // the 0.2→0.5 drop is steepest
  assert.strictEqual(m.maxCliff.drop, 0.45);
  assert.strictEqual(m.maxCliff.atPosition, 0.35); // midpoint of 0.2 and 0.5
});

test("intro window can be derived from seconds + duration", () => {
  // 3s into a 30s clip = ratio 0.1 → intro retention 0.9.
  const m = curveMetrics(CURVE, { introSeconds: 3, durationSec: 30 });
  assert.strictEqual(m.introRetention, 0.9);
});

test("curveMetrics on sparse data returns nulls, never guesses", () => {
  const m = curveMetrics([{ position: 0, retention: 1 }]);
  assert.strictEqual(m.introRetention, null);
  assert.strictEqual(m.maxCliff, null);
});

// ── alignment to the edit timeline ───────────────────────────────────────────
test("attributeCliffToSegments maps the cliff to the right edit", () => {
  // duration 60s → cliff at ratio 0.35 = 21s. Segment 2 spans 20–35s.
  const segments = [
    { start: 0, end: 10, label: "hook" },
    { start: 10, end: 20, label: "build" },
    { start: 20, end: 35, label: "talking head" },
    { start: 35, end: 60, label: "payoff" },
  ];
  const m = curveMetrics(CURVE, { introRatio: 0.1 });
  const hit = attributeCliffToSegments(m.maxCliff, segments, 60);
  assert.strictEqual(hit.cliffTimeSec, 21);
  assert.strictEqual(hit.segmentIndex, 2);
  assert.strictEqual(hit.segment.label, "talking head");
});

test("attributeCliffToSegments returns index -1 when cliff is outside segments", () => {
  const hit = attributeCliffToSegments({ atPosition: 0.9 }, [{ start: 0, end: 10 }], 60);
  assert.strictEqual(hit.segmentIndex, -1);
  assert.strictEqual(hit.segment, null);
});

// ── outcome metrics for calibration ──────────────────────────────────────────
test("retentionOutcomeMetrics yields numeric metrics for correlation", () => {
  const out = retentionOutcomeMetrics(CURVE, { introRatio: 0.1 });
  assert.strictEqual(out.introRetention, 0.9);
  assert.ok(typeof out.meanRetention === "number");
  assert.strictEqual(out.maxCliffDrop, 0.45);
});

console.log(`\n${passed} checks passed.`);
