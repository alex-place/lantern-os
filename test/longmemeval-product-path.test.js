// #2111 — product-path LongMemEval harness scoring.
// The end-to-end harness already ran on the real 500-instance longmemeval_s (recall@5 0.884);
// these unit tests pin the recall@k / MRR scoring logic that turns retrieved turns into a
// session-level hit, independent of a dataset being present.
//
// Run: node test/longmemeval-product-path.test.js
const assert = require("assert");
const path = require("path");
const { norm, scoreHits } = require(path.resolve(__dirname, "../scripts/eval_longmemeval_js.js"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// text -> Set(sessionId); gold session = "S_gold"
const map = new Map([
  [norm("I graduated with a Business Administration degree"), new Set(["S_gold"])],
  [norm("The weather was nice that day"), new Set(["S_noise"])],
]);
const inst = { answer_session_ids: ["S_gold"] };

check("gold turn at rank 1 → recall 1, mrr 1", () => {
  const hits = [{ text: "I graduated with a Business Administration degree" }];
  assert.deepStrictEqual(scoreHits(hits, inst, map), { recall: 1, mrr: 1 });
});

check("gold turn at rank 3 → recall 1, mrr 1/3", () => {
  const hits = [
    { text: "The weather was nice that day" },
    { text: "unrelated" },
    { text: "I graduated with a Business Administration degree" },
  ];
  const r = scoreHits(hits, inst, map);
  assert.strictEqual(r.recall, 1);
  assert.ok(Math.abs(r.mrr - 1 / 3) < 1e-9);
});

check("no gold-session turn in top-k → recall 0, mrr 0", () => {
  const hits = [{ text: "The weather was nice that day" }, { text: "unrelated" }];
  assert.deepStrictEqual(scoreHits(hits, inst, map), { recall: 0, mrr: 0 });
});

check("attribution is session-level: a different turn from the gold session still counts", () => {
  const m = new Map([[norm("Also, my major was Business Administration"), new Set(["S_gold"])]]);
  const hits = [{ text: "Also, my major was Business Administration" }];
  assert.strictEqual(scoreHits(hits, inst, m).recall, 1);
});

check("norm truncates + lowercases for stable keys", () => {
  assert.strictEqual(norm("  HeLLo World  "), "hello world");
  assert.strictEqual(norm("x".repeat(200)).length, 80);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall product-path LongMemEval scoring tests passed");
