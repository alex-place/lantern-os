// #1429 — recordLifeFact() writes a personal fact through the ONE canonical CSF memory
// (same writer/shape as recordConvergance), so it's readable by the existing
// csf-memory.js::readMemoryRecords()/queryMemories() pipeline with no dedicated store.
//
// Run: node test/csf-memory-writer-lifefact.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { recordLifeFact, verifyRecord } = require("../lib/csf-memory-writer");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csf-lifefact-"));
}
function readRegistry(base) {
  const p = path.join(base, "raw.jsonl");
  return fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

(async () => {
  await check("writes a well-formed, self-verifying trace record", async () => {
    const base = tmpBase();
    const res = await recordLifeFact(
      { subject: "my kid", attribute: "shoe size", value: "7", category: "preferences", keywords: ["kid", "shoe", "size"], rawText: "my kid's shoe size is 7" },
      { basePath: base },
    );
    assert.ok(res && res.memory_id);
    const [rec] = readRegistry(base);
    assert.strictEqual(rec.tier, "trace");
    assert.strictEqual(rec.cube_partition, "raw");
    assert.ok(rec.tags.includes("life-memory") && rec.tags.includes("preferences"));
    assert.strictEqual(rec.content.subject, "my kid");
    assert.strictEqual(rec.content.value, "7");
    assert.strictEqual(rec.content.event, "life_fact");
    assert.deepStrictEqual(rec.keywords, ["kid", "shoe", "size"]);
    assert.strictEqual(rec.confidence, 1.0);      // an explicitly stated fact — ground truth
    assert.ok(verifyRecord(rec));                  // checksum round-trips (tamper-evident)
  });

  await check("summary text is readable prose (feeds the LLM context block directly)", async () => {
    const base = tmpBase();
    await recordLifeFact({ subject: "the landlord", attribute: "name", value: "Dana", rawText: "the landlord's name is Dana" }, { basePath: base });
    const [rec] = readRegistry(base);
    assert.strictEqual(rec.content.text, "the landlord's name: Dana");
  });

  await check("returns null on an empty value rather than writing a hollow record", async () => {
    const base = tmpBase();
    const res = await recordLifeFact({ subject: "x", attribute: "y", value: "" }, { basePath: base });
    assert.strictEqual(res, null);
    assert.ok(!fs.existsSync(path.join(base, "raw.jsonl")));
  });

  await check("multiple facts append to the same registry (no per-feature store)", async () => {
    const base = tmpBase();
    await recordLifeFact({ subject: "a", attribute: "a", value: "1", rawText: "a is 1" }, { basePath: base });
    await recordLifeFact({ subject: "b", attribute: "b", value: "2", rawText: "b is 2" }, { basePath: base });
    assert.strictEqual(readRegistry(base).length, 2);
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall csf-memory-writer life-fact checks passed\n");
})();
