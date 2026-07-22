"use strict";

/**
 * test/convergence-oracle.test.js
 *
 * The Convergence Oracle grounds a chat question in its cosmic-time observer slice
 * ONLY when the question is actually anchored there. #1268 already made
 * formatGrounding() return "" for an un-anchored question (sliceFor → null), so
 * unrelated chat turns no longer get a cosmology block prepended.
 *
 * #1275 closes the residual gap: the NOW band keymap still carried the bare words
 * "now"/"today"/"current", which are NOT cosmology anchors and false-matched
 * everyday requests ("fix this bug now", "my schedule today") — grounding them in
 * dark energy. These are removed; the real anchors still ground.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/convergence-oracle.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sliceFor, formatGrounding, NOW } = require("../lib/convergence-oracle");

// Real cosmology questions that MUST still ground, with the band they anchor to.
const ANCHORED = [
  ["how old is the universe?", NOW],
  ["what is dark energy?", NOW],
  ["explain dark matter", NOW],
  ["what was there before the big bang?", "Planck epoch"],
  ["when did the CMB form?", "Recombination / CMB"],
  ["what is the ultimate fate of the universe?", "Dark era / heat death"],
  ["will black holes evaporate?", "Black hole era"],
];

// Everyday requests that must NOT be grounded in cosmology.
const UNANCHORED = [
  "help me fix my resume",
  "write a function that generates a pdf report",
  "what's a good pasta recipe?",
  "",
];

// The #1275 regression set: bare common words that previously matched the NOW band.
const FALSE_TRIGGERS = [
  "fix this bug now",
  "what's on my schedule today",
  "refactor the current module",
  "now",
  "today",
  "current",
];

test("anchored cosmology questions still produce a grounding block", () => {
  for (const [q, band] of ANCHORED) {
    const s = sliceFor(q);
    assert.ok(s, `"${q}" should resolve to a slice`);
    assert.equal(s.band, band, `"${q}" should anchor to ${band}`);
    const g = formatGrounding(q);
    assert.ok(g.length > 0 && /Convergence Oracle/.test(g), `"${q}" should ground`);
  }
});

test("un-anchored everyday questions ground to nothing (#1268)", () => {
  for (const q of UNANCHORED) {
    assert.equal(sliceFor(q), null, `"${q}" must not resolve to a slice`);
    assert.equal(formatGrounding(q), "", `"${q}" must produce an empty grounding block`);
  }
});

test("bare 'now'/'today'/'current' no longer false-trigger NOW-band grounding (#1275)", () => {
  for (const q of FALSE_TRIGGERS) {
    assert.equal(sliceFor(q), null, `"${q}" must not match the NOW band on a bare common word`);
    assert.equal(formatGrounding(q), "", `"${q}" must not ground`);
  }
  // …but a real anchor sitting next to those words still grounds.
  assert.ok(formatGrounding("how old is the universe right now?").length > 0);
});

// Third strike of the bare-word disease (2026-07-21 audit): cosmology terms that
// ALSO live in everyday/technical language matched alone. The matcher now splits
// STRONG phrases (unambiguous — match alone) from WEAK words (real anchors that
// need cosmology CONTEXT in the same question).
const WEAK_WORD_FALSE_POSITIVES = [
  "make this div transparent on hover",   // transparent → CMB
  "beginner guide to react hooks",        // begin → Planck epoch
  "where do I begin with the terminal?",  // begin
  "why is inflation at 3 percent",        // inflation → cosmic inflation
  "what is the final state of this reducer", // final state → heat death
  "my water bottle evaporated overnight", // evaporate → Hawking
  "an abundance mindset for founders",    // abundance → BBN
  "when will the AI singularity happen",  // singularity → Planck epoch
  "how old is this repository",           // how old → NOW
];

test("weak cosmology words don't fire without cosmology context (2026-07-21)", () => {
  for (const q of WEAK_WORD_FALSE_POSITIVES) {
    assert.equal(sliceFor(q), null, `"${q}" must not ground on a weak word alone`);
  }
});

test("weak words DO fire with cosmology context, strong phrases fire alone", () => {
  assert.equal(sliceFor("how did the universe begin")?.band, "Planck epoch");
  assert.equal(sliceFor("explain inflation in the early universe")?.band, "Inflation");
  assert.equal(sliceFor("when did the universe become transparent")?.band, "Recombination / CMB");
  assert.equal(sliceFor("what happens inside a black hole")?.band, "Black hole era"); // strong, no context word
  assert.equal(sliceFor("tell me about the heat death")?.band, "Dark era / heat death");
});
