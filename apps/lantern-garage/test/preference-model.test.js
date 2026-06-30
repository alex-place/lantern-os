// #1426 — preference model: feature-weight learning + taste-based ranking. Pure, no I/O.
//
// Run: node apps/lantern-garage/test/preference-model.test.js
const assert = require("assert");
const pm = require("../lib/preference-model");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

check("normFeatures lowercases, trims, dedupes", () =>
  assert.deepStrictEqual(pm.normFeatures([" Sci-Fi ", "sci-fi", "Hardcover", ""]), ["sci-fi", "hardcover"]));

check("accepted feature → positive weight, rejected → negative", () => {
  const w = pm.learnWeights([
    { features: ["sci-fi"], accepted: true },
    { features: ["sci-fi"], accepted: true },
    { features: ["romance"], accepted: false },
  ]);
  assert.ok(w["sci-fi"].weight > 0);
  assert.ok(w["romance"].weight < 0);
});

check("Laplace smoothing keeps a single observation modest (|w| < 1)", () => {
  const w = pm.learnWeights([{ features: ["x"], accepted: true }]);
  assert.ok(Math.abs(w["x"].weight) < 1);          // 1/(1+0+1) = 0.5, not 1
  assert.strictEqual(w["x"].weight, 0.5);
});

check("mixed signals on one feature net out by support", () => {
  const w = pm.learnWeights([
    { features: ["a"], accepted: true }, { features: ["a"], accepted: true },
    { features: ["a"], accepted: false },
  ]);
  assert.strictEqual(w["a"].weight, (2 - 1) / (3 + 1));   // 0.25
  assert.strictEqual(w["a"].support, 3);
});

check("scoreItem sums known-feature weights; unknown features are neutral", () => {
  const w = pm.learnWeights([
    { features: ["sci-fi"], accepted: true }, { features: ["romance"], accepted: false },
  ]);
  const s = pm.scoreItem(["sci-fi", "romance", "unseen"], w);
  assert.strictEqual(s, Math.round((w["sci-fi"].weight + w["romance"].weight) * 1000) / 1000);
});

check("rankItems orders by predicted taste with explanations", () => {
  const w = pm.learnWeights([
    { features: ["sci-fi"], accepted: true }, { features: ["sci-fi"], accepted: true },
    { features: ["romance"], accepted: false }, { features: ["romance"], accepted: false },
  ]);
  const ranked = pm.rankItems([
    { id: "A", features: ["romance"] },
    { id: "B", features: ["sci-fi"] },
    { id: "C", features: ["sci-fi", "romance"] },
  ], w);
  assert.strictEqual(ranked[0].id, "B");          // most liked
  assert.strictEqual(ranked[ranked.length - 1].id, "A");   // most disliked
  assert.ok(ranked[0].reasons.length >= 1);
});

check("explain ranks features by contribution magnitude, drops zeros", () => {
  const w = pm.learnWeights([
    { features: ["strong"], accepted: true }, { features: ["strong"], accepted: true }, { features: ["strong"], accepted: true },
    { features: ["weak"], accepted: true },
  ]);
  const ex = pm.explain(["weak", "strong", "unknown"], w);
  assert.strictEqual(ex[0].feature, "strong");    // larger magnitude first
  assert.ok(!ex.some((e) => e.feature === "unknown"));
});

check("tasteProfile splits likes vs dislikes, sorted", () => {
  const w = pm.learnWeights([
    { features: ["love"], accepted: true }, { features: ["love"], accepted: true },
    { features: ["hate"], accepted: false }, { features: ["hate"], accepted: false },
  ]);
  const p = pm.tasteProfile(w);
  assert.strictEqual(p.likes[0].feature, "love");
  assert.strictEqual(p.dislikes[0].feature, "hate");
  assert.strictEqual(p.features, 2);
});

check("empty model: no weights, zero scores", () => {
  const w = pm.learnWeights([]);
  assert.deepStrictEqual(w, {});
  assert.strictEqual(pm.scoreItem(["anything"], w), 0);
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall preference-model checks passed\n");
