// Σ₀ token-surprise primitive — model-agnostic per-token code-length signal.
// Run: node apps/lantern-garage/test/token-surprise.test.js
const assert = require("assert");
const {
  logprobToBits, fromOpenAILogprobs, fromOllamaLogprobs,
  surpriseField, fieldToUncertainty, toUncertainty,
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

check("toUncertainty: accepts scalar | field | array", () => {
  assert.strictEqual(toUncertainty(0.7), 0.7);
  assert.strictEqual(toUncertainty(null), 0);
  assert.strictEqual(toUncertainty(undefined), 0);
  const arr = Array(50).fill({ bits: 10 });
  assert.ok(toUncertainty(arr) > 0.8);
  assert.ok(toUncertainty(surpriseField(arr)) > 0.8);
  assert.strictEqual(toUncertainty(1.5), 1); // clamps
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall token-surprise checks passed");
