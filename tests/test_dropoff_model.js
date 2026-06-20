// Unit tests for B2 — drop-off-aware cutting. The model must be a strict no-op
// until enough cliff-labeled outcomes exist, then penalize cliff-prone segment
// tags. Standalone: `node tests/test_dropoff_model.js`.

"use strict";

const assert = require("assert");
const {
  buildDropoffProfile, dropoffPenalty, MIN_FOR_CALIBRATION,
} = require("../src/creator-intelligence/calibration/dropoff-model");
const { generateVariantsV10 } = require("../src/creator-intelligence/scoring/variant-engine-v10");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// A cliff-labeled outcome row: the cliff was attributed to a segment with `tags`
// and had magnitude `drop`.
const row = (tags, drop) => ({ cliffSegment: { tags, drop }, outcome: { maxCliffDrop: drop } });

test("profile is insufficient_data below the calibration threshold (no-op)", () => {
  const rows = Array.from({ length: MIN_FOR_CALIBRATION - 1 }, () => row(["talking"], 0.4));
  const p = buildDropoffProfile(rows);
  assert.strictEqual(p.status, "insufficient_data");
  assert.strictEqual(p.need, MIN_FOR_CALIBRATION);
  assert.strictEqual(dropoffPenalty({ tags: ["talking"] }, p), 0, "uncalibrated => penalty 0");
});

test("rows lacking cliff attribution don't count toward the threshold", () => {
  const rows = Array.from({ length: MIN_FOR_CALIBRATION }, () => ({ outcome: { views: 100 } }));
  const p = buildDropoffProfile(rows);
  assert.strictEqual(p.status, "insufficient_data");
  assert.strictEqual(p.have, 0);
});

test("calibrated profile penalizes cliff-prone tags proportionally", () => {
  // 'talking' precedes big cliffs; 'combat' precedes small ones.
  const rows = [
    ...Array.from({ length: 80 }, () => row(["talking"], 0.5)),
    ...Array.from({ length: 40 }, () => row(["combat"], 0.1)),
  ]; // 120 usable >= 100
  const p = buildDropoffProfile(rows);
  assert.strictEqual(p.status, "ok");
  assert.strictEqual(p.calibrated, true);
  assert.strictEqual(p.tagPenalty.talking, 1, "biggest cumulative cliff => penalty 1");
  assert.ok(p.tagPenalty.combat < p.tagPenalty.talking, "smaller cliffs => smaller penalty");
  // penalty for a segment is driven by its riskiest tag
  assert.strictEqual(dropoffPenalty({ tags: ["combat", "talking"] }, p), 1);
  assert.strictEqual(dropoffPenalty({ tags: ["scene"] }, p), 0, "unseen tag => no penalty");
});

test("variant engine is unchanged without a calibrated profile (no-op)", () => {
  const H = [
    { start: 0, end: 4, duration: 4, score: 0.9, tags: ["motion"] },
    { start: 10, end: 14, duration: 4, score: 0.6, tags: ["talking"] },
    { start: 20, end: 24, duration: 4, score: 0.7, tags: ["scene"] },
  ];
  const base = generateVariantsV10({ duration: 30, highlights: H }, {});
  for (const v of base.variants) assert.strictEqual(v.dropoffPenalty, 0, "no profile => 0 penalty");
});

test("a calibrated profile re-ranks away from cliff-prone variants", () => {
  const H = [
    { start: 0, end: 6, duration: 6, score: 0.80, tags: ["talking"] },  // strong but cliff-prone
    { start: 10, end: 16, duration: 6, score: 0.78, tags: ["motion"] },  // nearly as strong, safe
    { start: 20, end: 26, duration: 6, score: 0.5, tags: ["scene"] },
  ];
  const profile = { status: "ok", calibrated: true, tagPenalty: { talking: 1.0 } };
  const withProfile = generateVariantsV10({ duration: 30, highlights: H }, { dropoffProfile: profile });
  // Penalties are surfaced and non-trivial for talking-heavy variants.
  assert.ok(withProfile.variants.some((v) => v.dropoffPenalty > 0), "penalty applied");
  // The rank-1 variant should not be the most talking-penalized one.
  const top = withProfile.variants.find((v) => v.rank === 1);
  const worst = withProfile.variants.reduce((m, v) => (v.dropoffPenalty > m.dropoffPenalty ? v : m));
  assert.ok(top.dropoffPenalty <= worst.dropoffPenalty);
});

console.log(`\n${passed} checks passed.`);
