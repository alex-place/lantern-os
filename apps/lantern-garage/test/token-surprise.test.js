// Σ₀ token-surprise primitive — model-agnostic per-token code-length signal.
// Run: node apps/lantern-garage/test/token-surprise.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  logprobToBits, fromOpenAILogprobs, fromOllamaLogprobs,
  surpriseField, fieldToUncertainty, toUncertainty,
  calibrationFor, DEFAULT_CALIBRATION,
} = require("../lib/token-surprise");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

check("logprobToBits: ln-prob → bits (-ln(0.5) → 1 bit)", () => {
  assert.ok(approx(logprobToBits(Math.log(0.5)), 1));
  assert.ok(approx(logprobToBits(Math.log(0.25)), 2));
  assert.strictEqual(logprobToBits(null), null);
});

check("fromOpenAILogprobs: parses content[].logprob to bits", () => {
  const per = fromOpenAILogprobs([
    { token: "The", logprob: Math.log(0.5) },
    { token: "x", logprob: Math.log(1 / 64) }, // 6 bits
    { token: "?", logprob: undefined },        // skipped
  ]);
  assert.strictEqual(per.length, 2);
  assert.ok(approx(per[0].bits, 1));
  assert.ok(approx(per[1].bits, 6));
});

check("fromOllamaLogprobs: accepts logprob OR prob", () => {
  const per = fromOllamaLogprobs([{ token: "a", prob: 0.5 }, { token: "b", logprob: Math.log(0.125) }]);
  assert.ok(approx(per[0].bits, 1));
  assert.ok(approx(per[1].bits, 3));
});

check("surpriseField: aggregates mean/p90/tailMass", () => {
  // 10 confident tokens (1 bit) + 2 guessed tokens (8 bits) → tailMass = 2/12
  const per = [...Array(10).fill({ bits: 1 }), { bits: 8 }, { bits: 8 }];
  const f = surpriseField(per);
  assert.strictEqual(f.nTokens, 12);
  assert.ok(f.tailMass > 0.16 && f.tailMass < 0.17, `tailMass=${f.tailMass}`);
  assert.ok(f.maxBits === 8);
  assert.strictEqual(surpriseField([]), null);
});

check("fieldToUncertainty: fluent text → ~0, frequent guessing → high", () => {
  const confident = surpriseField(Array(50).fill({ bits: 1.5 }));
  const guessing = surpriseField(Array(50).fill({ bits: 10 }));
  assert.ok(fieldToUncertainty(confident) < 0.1, `confident=${fieldToUncertainty(confident)}`);
  assert.ok(fieldToUncertainty(guessing) > 0.8, `guessing=${fieldToUncertainty(guessing)}`);
  assert.strictEqual(fieldToUncertainty(null), 0);
});

// #1673: a confidently-wrong answer costs more bits/token than a right one EVEN when no
// single token trips the old 6-bit gate. The map must rank a low-but-elevated-perplexity
// field above a fluent one — the exact case the tailMass map was blind to.
check("fieldToUncertainty: ranks elevated low-bit perplexity above fluent (the #1673 gap)", () => {
  const fluent = surpriseField(Array(20).fill({ bits: 0.4 }));   // all confident, tailMass=0
  const elevated = surpriseField(Array(20).fill({ bits: 2.5 })); // higher perplexity, STILL tailMass=0
  assert.strictEqual(fluent.tailMass, 0);
  assert.strictEqual(elevated.tailMass, 0); // both invisible to the old 6-bit gate
  assert.ok(fieldToUncertainty(elevated) > fieldToUncertainty(fluent),
    `elevated=${fieldToUncertainty(elevated)} should exceed fluent=${fieldToUncertainty(fluent)}`);
});

// Data-driven regression lock against the committed #1673 labeled results. The new map
// must recover perplexity-grade separation (AUROC ≥ 0.70) where the old tailMass map sat
// at chance (≤ 0.55). No model needed — the per-token fields + labels are committed.
function auroc(scores, labels) { // label 1 = hallucination (positive)
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return NaN;
  let win = 0;
  for (const p of pos) for (const n of neg) win += p > n ? 1 : p === n ? 0.5 : 0;
  return win / (pos.length * neg.length);
}
const legacyTailMassMap = (f) => { // the pre-#1673 map, inlined to document what was wrong
  if (!f) return 0;
  const tail = Math.max(0, Math.min(1, f.tailMass));
  const p90 = Math.max(0, Math.min(1, (f.p90Bits - 4) / 8));
  return Math.max(0, Math.min(1, 0.7 * tail + 0.3 * p90));
};
const RESULTS = path.join(__dirname, "../../../experiments/results");
for (const fn of ["surprise_leak_qwen15b.jsonl", "surprise_leak_mistral7b.jsonl"]) {
  const p = path.join(RESULTS, fn);
  check(`fieldToUncertainty beats chance on real labeled data (${fn})`, () => {
    const rows = fs.readFileSync(p, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l)).filter((r) => r.field && typeof r.hallucination === "number");
    assert.ok(rows.length > 150, `expected ~199 rows, got ${rows.length}`);
    const y = rows.map((r) => r.hallucination);
    const aNew = auroc(rows.map((r) => fieldToUncertainty(r.field)), y);
    const aOld = auroc(rows.map((r) => legacyTailMassMap(r.field)), y);
    assert.ok(aNew >= 0.70, `new AUROC ${aNew.toFixed(4)} must be ≥ 0.70 (perplexity-grade)`);
    assert.ok(aOld <= 0.55, `old tailMass AUROC ${aOld.toFixed(4)} was chance (regression lock)`);
    console.log(`        ${fn}: new AUROC=${aNew.toFixed(4)}  old(tailMass)=${aOld.toFixed(4)}`);
  });
}

check("toUncertainty: accepts scalar | field | array", () => {
  assert.strictEqual(toUncertainty(0.7), 0.7);
  assert.strictEqual(toUncertainty(null), 0);
  assert.strictEqual(toUncertainty(undefined), 0);
  const arr = Array(50).fill({ bits: 10 });
  assert.ok(toUncertainty(arr) > 0.8);
  assert.ok(toUncertainty(surpriseField(arr)) > 0.8);
  assert.strictEqual(toUncertainty(1.5), 1); // clamps
});

// ── #1681 per-model calibration ─────────────────────────────────────────────
check("calibrationFor: known model → specific, unknown → default, family/tag match", () => {
  assert.strictEqual(calibrationFor("unknown-model"), DEFAULT_CALIBRATION);
  assert.strictEqual(calibrationFor(""), DEFAULT_CALIBRATION);
  assert.strictEqual(calibrationFor(null), DEFAULT_CALIBRATION);
  const q = calibrationFor("qwen2.5-coder:1.5b");
  assert.ok(q.center < 5 && q.gain > 1, `qwen calib should be tuned: ${JSON.stringify(q)}`);
  // family/tag resolution: a different tag of the same base resolves to the family calib
  assert.strictEqual(calibrationFor("mistral:latest"), calibrationFor("mistral"));
  assert.strictEqual(calibrationFor("qwen2.5-coder:latest"), calibrationFor("qwen2.5-coder:1.5b"));
});

check("default calibration leaves the uncalibrated mapping unchanged", () => {
  const f = surpriseField(Array(20).fill({ bits: 6 }));
  assert.strictEqual(fieldToUncertainty(f), fieldToUncertainty(f, DEFAULT_CALIBRATION));
});

// The point of #1681: calibration makes the MAGNITUDE meaningful (usable against a fixed
// ~0.5 threshold) where the default logistic collapses a low-bit model's replies to ~0.
const CALIB_MODEL = { "surprise_leak_qwen15b.jsonl": "qwen2.5-coder:1.5b", "surprise_leak_mistral7b.jsonl": "mistral" };
for (const [fn, modelId] of Object.entries(CALIB_MODEL)) {
  check(`per-model calibration separates magnitude on real data (${modelId})`, () => {
    const rows = fs.readFileSync(path.join(RESULTS, fn), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l)).filter((r) => r.field && typeof r.hallucination === "number");
    const calib = calibrationFor(modelId);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const uCorrect = mean(rows.filter((r) => !r.hallucination).map((r) => fieldToUncertainty(r.field, calib)));
    const uHalluc = mean(rows.filter((r) => r.hallucination).map((r) => fieldToUncertainty(r.field, calib)));
    // default-calibration magnitudes (the bug #1681 fixes): both collapse toward 0
    const dCorrect = mean(rows.filter((r) => !r.hallucination).map((r) => fieldToUncertainty(r.field)));
    const dHalluc = mean(rows.filter((r) => r.hallucination).map((r) => fieldToUncertainty(r.field)));
    assert.ok(uHalluc - uCorrect > 0.25, `calibrated separation too small: halluc=${uHalluc.toFixed(3)} correct=${uCorrect.toFixed(3)}`);
    assert.ok(uHalluc > 0.5 && uCorrect < 0.5, `classes should straddle 0.5: halluc=${uHalluc.toFixed(3)} correct=${uCorrect.toFixed(3)}`);
    assert.ok(dHalluc < 0.1 && dCorrect < 0.1, `default calibration should collapse to ~0 (the bug): halluc=${dHalluc.toFixed(3)} correct=${dCorrect.toFixed(3)}`);
    console.log(`        ${modelId}: calibrated correct=${uCorrect.toFixed(3)} halluc=${uHalluc.toFixed(3)}  (default ${dCorrect.toFixed(3)}/${dHalluc.toFixed(3)})`);
  });
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall token-surprise checks passed");
