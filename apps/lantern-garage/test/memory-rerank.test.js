"use strict";
// #2763 — the conversation-retrieval reranker: a turn covering MORE of the query's distinctive
// terms must be able to climb above a shallow high-first-pass-score match. Candidate scores are
// passed explicitly so the test is independent of relevanceScore's internals.
//
// Run: node apps/lantern-garage/test/memory-rerank.test.js
const assert = require("assert");
const { rerank } = require("../lib/memory-rerank");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const QUERY = "quantum entanglement teleportation fidelity experiment";

check("a buried turn covering all distinctive terms climbs above a shallow keyword repeat", () => {
  const cands = [
    // high first-pass score from repeating one common term, but covers little of the query
    { text: "quantum quantum quantum stuff", score: 10 },
    // lower first-pass score, but actually covers the distinctive terms — the turn that answers it
    { text: "we ran the entanglement teleportation experiment and measured high fidelity for quantum states", score: 4 },
  ];
  const out = rerank(QUERY, cands);
  assert.strictEqual(out[0].text.includes("teleportation experiment"), true, "the covering turn should rank first");
  assert.ok(out[0].coverage > out[1].coverage, "top result covers more distinctive terms");
});

check("with no reranking weight (w=0) the first-pass order is preserved", () => {
  const cands = [
    { text: "quantum quantum quantum stuff", score: 10 },
    { text: "entanglement teleportation experiment fidelity", score: 4 },
  ];
  const out = rerank(QUERY, cands, { weight: 0 });
  assert.strictEqual(out[0].score, 10, "w=0 → pure first-pass ordering");
});

check("a query with no distinctive terms is a no-op (order unchanged)", () => {
  const cands = [{ text: "a b c", score: 3 }, { text: "d e f", score: 2 }];
  const out = rerank("a an the of", cands);
  assert.deepStrictEqual(out.map((c) => c.score), [3, 2]);
});

check("ties are stable (original order kept)", () => {
  const cands = [
    { text: "entanglement teleportation fidelity experiment quantum", score: 5 },
    { text: "entanglement teleportation fidelity experiment quantum", score: 5 },
  ];
  const out = rerank(QUERY, cands);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].rerankScore, out[1].rerankScore);
});

check("single / empty candidate lists pass through unchanged", () => {
  assert.deepStrictEqual(rerank(QUERY, []), []);
  const one = [{ text: "x", score: 1 }];
  assert.deepStrictEqual(rerank(QUERY, one), one);
});

check("limit truncates after reranking", () => {
  const cands = [
    { text: "quantum only", score: 9 },
    { text: "entanglement teleportation fidelity experiment quantum", score: 3 },
    { text: "unrelated text about weather", score: 1 },
  ];
  const out = rerank(QUERY, cands, { limit: 1 });
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].text.includes("entanglement"), "the best-covering candidate survives the cut");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
