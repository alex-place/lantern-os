"use strict";

/**
 * test/leash-refine.test.js — #2871 surrogate-leash + #2870 verify-then-refine.
 *
 * The two invariants in unit form:
 *   - a cheap signal is DISTRUSTED by default and earns trust only through
 *     measured agreement with ground truth, losing it on drift or staleness;
 *   - a fix closes only when the metric provably recovered, and every outcome
 *     lands in the keyed playbook.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/leash-refine.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SurrogateLeash } = require("../lib/surrogate-leash");
const { openRemediation, assess, closeOrReopen, recordOutcome, playbookFor } = require("../lib/verify-then-refine");

// ── #2871 the leash ─────────────────────────────────────────────────────────

test("leash: distrust is the default state — no calibration, no trust", () => {
  const l = new SurrogateLeash({ name: "canary" });
  const o = l.observe(true);
  assert.equal(o.trusted, false);
  assert.equal(o.reason, "insufficient-calibration");
});

test("leash: trust is earned by measured agreement, lost on drift, restored by fresh truth", () => {
  const l = new SurrogateLeash({ minSamples: 10, minAgreement: 0.8, window: 20 });
  for (let i = 0; i < 10; i++) l.calibrate(true, true); // 10 agreeing pairs
  assert.equal(l.status().trusted, true);
  assert.equal(l.observe(true).trusted, true);
  // drift: surrogate says pass, reality says fail, repeatedly
  for (let i = 0; i < 6; i++) l.calibrate(true, false);
  const drifted = l.status();
  assert.equal(drifted.trusted, false);
  assert.equal(drifted.reason, "drift");
  assert.ok(drifted.agreement < 0.8);
  // fresh agreeing truth restores (window slides the disagreements out)
  for (let i = 0; i < 16; i++) l.calibrate(false, false);
  assert.equal(l.status().trusted, true, "re-fit against ground truth restores trust");
});

test("leash: staleness — trust expires after maxObsSinceFit consultations without a re-fit", () => {
  const l = new SurrogateLeash({ minSamples: 5, maxObsSinceFit: 10 });
  for (let i = 0; i < 5; i++) l.calibrate(true, true);
  for (let i = 0; i < 10; i++) assert.equal(l.observe(true).trusted, true);
  const stale = l.observe(true);
  assert.equal(stale.trusted, false);
  assert.equal(stale.reason, "stale");
  l.calibrate(true, true);
  assert.equal(l.observe(true).trusted, true, "one paired re-fit resets the clock");
});

test("leash: serialize/restore round-trips the whole state", () => {
  const l = new SurrogateLeash({ minSamples: 3 });
  for (let i = 0; i < 4; i++) l.calibrate(true, true);
  l.observe(true);
  const r = SurrogateLeash.restore(l.serialize());
  assert.deepEqual(r.status(), l.status());
  assert.equal(r.totalFits, 4);
});

// ── #2870 verify-then-refine ────────────────────────────────────────────────

test("refine: a fix without a before-reading is refused outright", () => {
  assert.throws(() => openRemediation({ failure: "x", metric: "acc" }), /unverifiable/);
});

test("refine: recovery is direction-aware and requires a REAL after-reading", () => {
  const up = openRemediation({ failure: "eval acc dropped", metric: "acc", baseline: 0.6, direction: "up" });
  assert.equal(assess(up, 0.7).recovered, true);
  assert.equal(assess(up, 0.5).reason, "did-not-improve");
  assert.equal(assess(up, NaN).reason, "no-after-reading");
  const down = openRemediation({ failure: "latency spiked", metric: "p95ms", baseline: 900, direction: "down" });
  assert.equal(assess(down, 400).recovered, true);
  assert.equal(assess(down, 950).recovered, false);
});

test("refine: improvement below a declared target keeps the loop open", () => {
  const r = openRemediation({ failure: "confab up", metric: "confab", baseline: 0.39, direction: "down", target: 0.14 });
  const partial = closeOrReopen(r, 0.3); // better, but not back to target
  assert.equal(partial.status, "kept-open-not-recovered");
  assert.equal(partial.reason, "target-not-met");
  assert.equal(closeOrReopen(r, 0.12).status, "closed-recovered");
});

test("refine: outcomes land in the keyed playbook and read back newest-first", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "playbook-")), "playbook.jsonl");
  const r = openRemediation({ failure: "V1 SFT raised confab", metric: "confab", baseline: 0.389, direction: "down", action: "fix anchor mix to >=0.60" });
  recordOutcome(r, closeOrReopen(r, 0.41), { file }); // first attempt failed
  recordOutcome(r, closeOrReopen(r, 0.12), { file }); // second recovered
  const hist = playbookFor("V1 SFT raised confab", { file });
  assert.equal(hist.length, 2);
  assert.equal(hist[0].recovered, true, "newest first");
  assert.equal(hist[1].recovered, false);
  assert.deepEqual(playbookFor("never seen", { file }), []);
  assert.deepEqual(playbookFor("anything", { file: path.join(os.tmpdir(), "absent", "x.jsonl") }), [], "absent file never throws");
});
