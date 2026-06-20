/**
 * Unit tests for the Kalshi → Convergence Verify trigger (agent-spine note §6, step 3).
 *   - apps/lantern-garage/lib/kalshi-convergence-outcomes.js
 *
 * Pure unit tests + a temp-file batch test with a STUBBED market fetch — no network,
 * no Kalshi keys. Run: node tests/test_kalshi_outcomes.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mod = require(path.resolve(
  __dirname, "..", "apps", "lantern-garage", "lib", "kalshi-convergence-outcomes.js"));
const { parsePrediction, marketFromResponse, resolutionToOutcome, generateOutcomes } = mod;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// A realistic kalshi-suggest record, mirroring the emit in kalshi-suggest.js.
function rec(over = {}) {
  return {
    id: over.id || "cr-test-1",
    hypothesis: over.hypothesis !== undefined
      ? over.hypothesis
      : "buy YES (Above 30) @ 47¢ — BTC up next 15m? [KXBTC15M-26JUN-30]",
    evidence_ids: over.evidence_ids !== undefined ? over.evidence_ids : ["KXBTC15M-26JUN-30"],
    result: over.result !== undefined ? over.result : "entry yes Above 30 @ 47¢ · tight band",
    confidence: 0.62,
    reasoner: over.reasoner !== undefined ? over.reasoner : "kalshi-suggest",
  };
}

(async () => {
  console.log("parsePrediction()");
  await test("reads ticker (evidence_ids) + side from a real record", () => {
    assert.deepStrictEqual(parsePrediction(rec()), { ticker: "KXBTC15M-26JUN-30", side: "yes" });
  });
  await test("parses NO side", () => {
    assert.strictEqual(parsePrediction(rec({ hypothesis: "buy NO (Below) @ 51¢ — x [T-1]", evidence_ids: ["T-1"] })).side, "no");
  });
  await test("falls back to [TICKER] in hypothesis when evidence_ids empty", () => {
    assert.strictEqual(parsePrediction(rec({ evidence_ids: [] })).ticker, "KXBTC15M-26JUN-30");
  });
  await test("non-kalshi reasoner → null", () => {
    assert.strictEqual(parsePrediction(rec({ reasoner: "dream-chat" })), null);
  });
  await test("no side anywhere → null", () => {
    assert.strictEqual(parsePrediction(rec({ hypothesis: "hold [T-1]", result: "wait", evidence_ids: ["T-1"] })), null);
  });

  console.log("marketFromResponse()");
  await test("unwraps { data: { market } }", () => {
    assert.deepStrictEqual(marketFromResponse({ ok: true, data: { market: { result: "yes" } } }), { result: "yes" });
  });
  await test("failed response → null", () => {
    assert.strictEqual(marketFromResponse({ ok: false, status: 0 }), null);
  });

  console.log("resolutionToOutcome()");
  await test("predicted yes + settled yes → passed true", () => {
    assert.deepStrictEqual(
      resolutionToOutcome(rec(), { result: "yes" }),
      { record_id: "cr-test-1", passed: true, notes: "kalshi KXBTC15M-26JUN-30 settled yes; predicted yes" });
  });
  await test("predicted yes + settled no → passed false", () => {
    assert.strictEqual(resolutionToOutcome(rec(), { result: "no" }).passed, false);
  });
  await test("unsettled (empty result / active) → null", () => {
    assert.strictEqual(resolutionToOutcome(rec(), { result: "" }), null);
    assert.strictEqual(resolutionToOutcome(rec(), { status: "active" }), null);
  });
  await test("void/non-binary result → null (stays pending, never mis-graded)", () => {
    assert.strictEqual(resolutionToOutcome(rec(), { result: "void" }), null);
  });

  console.log("generateOutcomes() — temp files + stubbed market fetch");
  await test("writes one outcome for a settled market, leaves the unsettled pending; idempotent on re-run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kalshi-out-"));
    const recordsPath = path.join(dir, "records.jsonl");
    const outcomesPath = path.join(dir, "outcomes.jsonl");

    const lines = [
      rec({ id: "win", evidence_ids: ["T-WIN"], hypothesis: "buy YES (a) @ 40¢ — x [T-WIN]" }),
      rec({ id: "open", evidence_ids: ["T-OPEN"], hypothesis: "buy NO (b) @ 60¢ — x [T-OPEN]" }),
      { id: "chat", reasoner: "dream-chat", hypothesis: "unrelated", evidence_ids: [] }, // must be ignored
    ];
    fs.writeFileSync(recordsPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const settled = { "T-WIN": { result: "yes" }, "T-OPEN": { result: "" } };
    const getMarketFn = async (ticker) => ({ ok: true, data: { market: settled[ticker] || null } });

    const s1 = await generateOutcomes({ recordsPath, outcomesPath, getMarketFn });
    assert.strictEqual(s1.scanned, 2, "only kalshi-suggest records scanned");
    assert.strictEqual(s1.written, 1, "one settled market graded");
    assert.strictEqual(s1.pending, 1, "the open market stays pending");

    const written = fs.readFileSync(outcomesPath, "utf-8").trim().split("\n").map(JSON.parse);
    assert.strictEqual(written.length, 1);
    assert.deepStrictEqual(written[0], {
      record_id: "win", passed: true, notes: "kalshi T-WIN settled yes; predicted yes",
    });

    const s2 = await generateOutcomes({ recordsPath, outcomesPath, getMarketFn });
    assert.strictEqual(s2.alreadyGraded, 1, "re-run skips the already-graded record");
    assert.strictEqual(s2.written, 0, "idempotent: no duplicate outcome");
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
})();
