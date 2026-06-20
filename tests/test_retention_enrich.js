// Tests for the A4→B2 ingest wiring: enrichFromCurve (pure) and ingest carrying
// retention metrics + cliffSegment onto outcome rows so the drop-off model gets
// real data. Standalone: `node tests/test_retention_enrich.js` (isolated tmp dir).

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.LANTERN_CI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ci-enrich-"));

const { enrichFromCurve } = require("../src/creator-intelligence/calibration/retention-analysis");
const engine = require("../src/creator-intelligence/calibration/calibration-engine");
const store = require("../src/creator-intelligence/calibration/outcome-store");
const { buildDropoffProfile } = require("../src/creator-intelligence/calibration/dropoff-model");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// Curve with a steep cliff between ratio 0.2 and 0.5 (→ ~21s of a 60s clip).
const CURVE = [
  { position: 0.0, retention: 1.0 },
  { position: 0.1, retention: 0.9 },
  { position: 0.2, retention: 0.85 },
  { position: 0.5, retention: 0.40 },
  { position: 1.0, retention: 0.35 },
];
const SEGMENTS = [
  { start: 0, end: 10, tags: ["hook"] },
  { start: 10, end: 20, tags: ["build"] },
  { start: 20, end: 35, tags: ["talking"] }, // the cliff at 21s lands here
  { start: 35, end: 60, tags: ["payoff"] },
];

test("enrichFromCurve yields retention metrics + cliffSegment with the right tags", () => {
  const e = enrichFromCurve(CURVE, SEGMENTS, 60, { introSeconds: 6 });
  assert.ok(typeof e.outcomeMetrics.introRetention === "number");
  assert.ok(typeof e.outcomeMetrics.meanRetention === "number");
  assert.strictEqual(e.outcomeMetrics.maxCliffDrop, 0.45);
  assert.ok(e.cliffSegment, "cliff attributed to a segment");
  assert.deepStrictEqual(e.cliffSegment.tags, ["talking"]);
  assert.strictEqual(e.cliffSegment.drop, 0.45);
});

test("enrichFromCurve is empty/null on a sparse curve (no guessing)", () => {
  const e = enrichFromCurve([{ position: 0, retention: 1 }], SEGMENTS, 60);
  assert.deepStrictEqual(e.outcomeMetrics, {});
  assert.strictEqual(e.cliffSegment, null);
});

test("ingest with retentionByEntryId stamps metrics + cliffSegment on the row", () => {
  const rows = [{ videoId: "v1", title: "clip", outcome: { views: 1000, avgPercentViewed: 55 } }];
  const links = [{ videoRef: "v1", method: "manual", status: "auto", entryId: "e1", confidence: 1 }];
  const res = engine.ingest({
    analyticsRows: rows, links,
    featuresByEntryId: { e1: { cutsPerMin: 12 } },
    retentionByEntryId: { e1: { points: CURVE, segments: SEGMENTS, durationSec: 60 } },
  });
  assert.strictEqual(res.written, 1);
  const saved = store.readAll().find((r) => r.videoRef === "v1");
  assert.strictEqual(saved.outcome.views, 1000, "original metrics preserved");
  assert.strictEqual(saved.outcome.maxCliffDrop, 0.45, "retention metric merged in");
  assert.ok(saved.outcome.introRetention !== undefined);
  assert.deepStrictEqual(saved.cliffSegment.tags, ["talking"], "cliffSegment attached for B2");
});

test("a row WITHOUT a curve is unaffected (additive)", () => {
  const rows = [{ videoId: "v2", title: "noCurve", outcome: { views: 500 } }];
  const links = [{ videoRef: "v2", method: "manual", status: "auto", entryId: "e2", confidence: 1 }];
  engine.ingest({ analyticsRows: rows, links, featuresByEntryId: { e2: { cutsPerMin: 9 } } });
  const saved = store.readAll().find((r) => r.videoRef === "v2");
  assert.strictEqual(saved.cliffSegment, undefined);
  assert.deepStrictEqual(Object.keys(saved.outcome), ["views"]);
});

test("ingested cliffSegment rows are consumable by the B2 drop-off model", () => {
  // The row written above (v1) carries cliffSegment{tags:['talking'],drop:0.45}.
  const profile = buildDropoffProfile(store.readAll(), { minRows: 1 });
  assert.strictEqual(profile.status, "ok");
  assert.ok(profile.tagPenalty.talking > 0, "talking accrues a drop-off penalty");
});

console.log(`\n${passed} checks passed.`);
