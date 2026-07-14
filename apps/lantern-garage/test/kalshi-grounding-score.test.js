"use strict";
// P1-5: unit test for scoreGrounded() — Brier/hit-rate on the grounded LLM P(YES),
// with an injected outcome resolver so it runs fully offline.
// Run: node apps/lantern-garage/test/kalshi-grounding-score.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scoreGrounded } = require("../lib/kalshi-grounding");

let failures = 0;
function check(name, fn) { return fn().then(() => console.log("  ok  -", name)).catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); }); }

// Write a throwaway grounding-cache file so we never touch the real one.
const tmp = path.join(os.tmpdir(), `grounding-score-${process.pid}.jsonl`);
function writeCache(rows) { fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }

(async () => {
  // Outcomes: A settles YES, B settles NO, C is unsettled (skip).
  const outcomes = { A: 1, B: 0, C: null };
  const resolveOutcome = async (t) => outcomes[t];

  await check("empty cache → honest n=0, null scores (never fabricates)", async () => {
    writeCache([]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.strictEqual(r.n, 0);
    assert.strictEqual(r.brier, null);
  });

  await check("unsettled predictions are skipped, not guessed", async () => {
    writeCache([{ ticker: "C", p_yes: 0.9, ts: "2026-07-13T00:00:00Z" }]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.strictEqual(r.n, 0);
  });

  await check("perfect predictions → Brier 0, hit-rate 1.0", async () => {
    writeCache([
      { ticker: "A", p_yes: 1.0, ts: "2026-07-13T00:00:00Z" },
      { ticker: "B", p_yes: 0.0, ts: "2026-07-13T00:00:00Z" },
    ]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.strictEqual(r.n, 2);
    assert.strictEqual(r.brier, 0);
    assert.strictEqual(r.hitRate, 1);
  });

  await check("coin-flip 0.5 predictions → Brier 0.25, hit-rate counts ties as YES-side", async () => {
    writeCache([
      { ticker: "A", p_yes: 0.5, ts: "2026-07-13T00:00:00Z" },
      { ticker: "B", p_yes: 0.5, ts: "2026-07-13T00:00:00Z" },
    ]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.strictEqual(r.brier, 0.25);
    // p>=0.5 predicts YES: correct on A (YES), wrong on B (NO) → 50%.
    assert.strictEqual(r.hitRate, 0.5);
  });

  await check("latestPerTicker keeps only the newest prediction per market", async () => {
    writeCache([
      { ticker: "A", p_yes: 0.1, ts: "2026-07-13T00:00:00Z" }, // stale, wrong
      { ticker: "A", p_yes: 1.0, ts: "2026-07-13T12:00:00Z" }, // newest, right
    ]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.strictEqual(r.n, 1);
    assert.strictEqual(r.brier, 0);    // only the newest (correct) prediction counts
  });

  await check("skillVsBase > 0 when the model beats the base rate", async () => {
    writeCache([
      { ticker: "A", p_yes: 0.8, ts: "2026-07-13T00:00:00Z" }, // YES, confident right
      { ticker: "B", p_yes: 0.2, ts: "2026-07-13T00:00:00Z" }, // NO, confident right
    ]);
    const r = await scoreGrounded({ file: tmp, resolveOutcome });
    assert.ok(r.skillVsBase > 0, `expected positive skill, got ${r.skillVsBase}`);
  });

  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nAll kalshi-grounding-score tests passed.");
})();
