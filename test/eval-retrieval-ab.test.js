"use strict";
// eval-retrieval-ab.test.js — #2356. Asserts the retrieval A/B harness is honest and
// runnable WITHOUT Ollama/a reranker (the CI-safe path): it runs the deterministic
// lexical arms on the bundled fixture, reports sane metrics, isolates the
// low-lexical-overlap band (where dense/rerank must prove out for #2355), and — the
// key correctness guard — does NOT award a false hit when an arm has no signal.
//
// Run: node test/eval-retrieval-ab.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

(async () => {
  const harness = require("../scripts/eval_retrieval_ab");
  const { rankGold, lexicalOverlap, armBm25, buildBm25 } = harness;

  // ── unit: rankGold honesty ──────────────────────────────────────────────────
  await check("rankGold: unique top score → rank 1", () => {
    assert.strictEqual(rankGold(new Map([["g", 0.9], ["a", 0.1], ["b", 0.0]]), "g"), 1);
  });
  await check("rankGold: zero score is NOT a hit (Infinity) — no lucky top slot", () => {
    assert.strictEqual(rankGold(new Map([["g", 0], ["a", 0], ["b", 0]]), "g"), Infinity);
  });
  await check("rankGold: ties broken pessimistically (bottom of tie block)", () => {
    // gold tied with two others at the max, one doc strictly greater → worst-case rank 4.
    assert.strictEqual(rankGold(new Map([["x", 0.9], ["g", 0.5], ["a", 0.5], ["b", 0.5]]), "g"), 4);
  });

  await check("lexicalOverlap: query fully contained in gold → 1.0", () => {
    assert.strictEqual(lexicalOverlap("dev server port", "the dev server uses that port"), 1);
  });
  await check("lexicalOverlap: disjoint vocab → 0", () => {
    assert.strictEqual(lexicalOverlap("bananas orbit quietly", "the dev server port"), 0);
  });

  await check("armBm25: a doc with the distinctive query term ranks first", () => {
    const corpus = [
      { id: "d1", text: "the weather forecast for tomorrow looks mild and clear" },
      { id: "d2", text: "KXHIGHNY contract fade on the New York temperature ceiling" },
      { id: "d3", text: "general notes about coffee and morning routines" },
    ];
    const scores = armBm25(corpus, "KXHIGHNY fade", buildBm25(corpus));
    assert.strictEqual(rankGold(scores, "d2"), 1);
  });

  // ── end-to-end: run the harness on the fixture, isolated runs-log ────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retr-ab-"));
  process.env.RETRIEVAL_RUNS_LOG = path.join(tmp, "runs.jsonl");
  let row;
  await check("harness runs on the bundled fixture and returns a row", async () => {
    row = await harness.main();
    assert.ok(row && row.arms, "expected a run row with arms");
    assert.ok(row.arms["lexical-idf"] && row.arms["bm25-okapi"], "deterministic lexical arms must always run");
  });

  await check("overall lexical recall is sane (verbatim queries solved)", () => {
    assert.ok(row.arms["lexical-idf"]["R@5"] >= 0.8, `expected R@5>=0.8, got ${row.arms["lexical-idf"]["R@5"]}`);
  });

  await check("low-overlap band is isolated and HARDER than the high band", () => {
    const lo = row.byBandR5["lexical-idf"].low;
    const hi = row.byBandR5["lexical-idf"].high;
    assert.ok(lo !== null && hi !== null, "both bands should be populated by the fixture");
    assert.ok(hi > lo, `lexical should do better on verbatim (high=${hi}) than paraphrase (low=${lo})`);
    assert.ok(lo < 1.0, `low band should expose lexical's weakness (got ${lo}) — this is #2355's target`);
  });

  await check("dense + rerank arms are recorded as skipped, not silently dropped", () => {
    assert.ok(row.skipped.some((s) => /rerank/.test(s)), "rerank skip must be logged");
    assert.ok(row.ollama === false || row.arms["nomic-dense"], "either Ollama ran the dense arm or it was skipped");
  });

  await check("harness appended exactly one run row to the isolated log", () => {
    const lines = fs.readFileSync(process.env.RETRIEVAL_RUNS_LOG, "utf8").trim().split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1, `expected 1 appended row, got ${lines.length}`);
    JSON.parse(lines[0]); // must be valid JSONL
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env.RETRIEVAL_RUNS_LOG;
  console.log(failures ? `\n${failures} FAILED` : "\nall retrieval-ab harness checks passed");
  process.exit(failures ? 1 : 0);
})();
