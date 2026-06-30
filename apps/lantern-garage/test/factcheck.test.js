// #1430 — personal fact-check core logic. The web-search + Ollama judge are I/O
// (verified live); the verdict parsing/derivation is pure and locked here, including
// the honesty contract (no sources / no judge → "unverified", never fabricated).
//
// Run: node apps/lantern-garage/test/factcheck.test.js
const assert = require("assert");
const fc = require("../lib/factcheck");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

async function run() {
  // normalizeVerdict
  await check("normalizeVerdict maps synonyms", () => {
    assert.strictEqual(fc.normalizeVerdict("This is TRUE and confirmed"), "supported");
    assert.strictEqual(fc.normalizeVerdict("clearly false / debunked"), "refuted");
    assert.strictEqual(fc.normalizeVerdict("partly true, missing context"), "misleading");
    assert.strictEqual(fc.normalizeVerdict("who knows"), "unverified");
  });

  // parseVerdict — JSON
  await check("parseVerdict reads JSON verdict + confidence + reasoning", () => {
    const v = fc.parseVerdict('noise {"verdict":"refuted","confidence":0.9,"reasoning":"Source [1] contradicts it."} tail');
    assert.strictEqual(v.verdict, "refuted");
    assert.strictEqual(v.confidence, 0.9);
    assert.ok(/Source \[1\]/.test(v.reasoning));
  });

  await check("parseVerdict accepts percent-style confidence", () => {
    const v = fc.parseVerdict('{"verdict":"supported","confidence":"85"}');
    assert.strictEqual(v.verdict, "supported");
    assert.ok(Math.abs(v.confidence - 0.85) < 1e-9);
  });

  await check("parseVerdict tolerates prose (no JSON)", () => {
    const v = fc.parseVerdict("Overall this looks false to me.");
    assert.strictEqual(v.verdict, "refuted");
  });

  await check("parseVerdict never throws on junk", () => {
    const v = fc.parseVerdict(null);
    assert.strictEqual(v.verdict, "unverified");
  });

  // deriveResult — honesty contract
  await check("no sources → unverified, confidence 0, no judge called", async () => {
    let called = false;
    const r = await fc.deriveResult("x", [], async () => { called = true; return { verdict: "supported" }; });
    assert.strictEqual(r.verdict, "unverified");
    assert.strictEqual(r.confidence, 0);
    assert.strictEqual(called, false);
  });

  await check("sources but judge returns null → unverified + sources retained", async () => {
    const sources = [{ title: "S", url: "u", snippet: "e" }];
    const r = await fc.deriveResult("x", sources, async () => null);
    assert.strictEqual(r.verdict, "unverified");
    assert.deepStrictEqual(r.sources, sources);
  });

  await check("judge verdict flows through with its confidence", async () => {
    const r = await fc.deriveResult("x", [{ title: "S" }], async () => ({ verdict: "refuted", confidence: 0.8, reasoning: "no" }));
    assert.strictEqual(r.verdict, "refuted");
    assert.strictEqual(r.confidence, 0.8);
  });

  await check("judge without confidence → honest default by verdict", async () => {
    const r = await fc.deriveResult("x", [{ a: 1 }, { b: 2 }], async () => ({ verdict: "supported" }));
    assert.strictEqual(r.verdict, "supported");
    assert.strictEqual(r.confidence, fc.defaultConfidence("supported", 2));
  });

  await check("a throwing judge degrades to unverified (never crashes)", async () => {
    const r = await fc.deriveResult("x", [{ a: 1 }], async () => { throw new Error("boom"); });
    assert.strictEqual(r.verdict, "unverified");
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall factcheck checks passed\n");
}

run();
