// Provenance on CSF memory writes (lib/csf-memory-writer.js).
//
// Every record now says who produced it, using only the schema's existing fields (Python's
// MemoryRecord.from_dict takes exactly the dataclass fields): actor_type, actor_id and
// metadata.provenance. The council's answer and an agent's signal are unisona's own output
// ("self"); a life fact is the user's ("user"); an order is a system event ("system").
// isSelfAuthoredRecord() reads that, and falls back to content.role for older records.
//
// Run: node apps/lantern-garage/test/csf-memory-writer-provenance.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  recordConvergance, recordLifeFact, recordSignal, recordOrder,
  verifyRecord, isSelfAuthoredRecord, isSelfTurnRole, PROVENANCE,
} = require("../lib/csf-memory-writer");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csf-provenance-"));
}
function readRegistry(base) {
  return fs.readFileSync(path.join(base, "raw.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

(async () => {
  await check("a council answer is recorded as unisona's own claim", async () => {
    const base = tmpBase();
    await recordConvergance({ question: "is the deploy green?", answer: "yes, green at 16:23", synthesizer: "gemini/flash" }, { basePath: base });
    const [rec] = readRegistry(base);
    assert.strictEqual(rec.actor_type, "agent");
    assert.strictEqual(rec.actor_id, "gemini/flash");
    assert.deepStrictEqual(rec.metadata, { provenance: PROVENANCE.SELF });
    assert.strictEqual(isSelfAuthoredRecord(rec), true);
    assert.ok(verifyRecord(rec), "checksum covers the provenance fields");
  });

  await check("a council answer without a synthesizer is attributed to the council", async () => {
    const base = tmpBase();
    await recordConvergance({ question: "q", answer: "a" }, { basePath: base });
    assert.strictEqual(readRegistry(base)[0].actor_id, "council");
  });

  await check("a life fact is the user's statement, not self", async () => {
    const base = tmpBase();
    await recordLifeFact({ subject: "my kid", attribute: "shoe size", value: "7", userId: "u.123" }, { basePath: base });
    const [rec] = readRegistry(base);
    assert.strictEqual(rec.actor_type, "user");
    assert.strictEqual(rec.actor_id, "u.123");
    assert.deepStrictEqual(rec.metadata, { provenance: PROVENANCE.USER });
    assert.strictEqual(isSelfAuthoredRecord(rec), false);
    assert.ok(verifyRecord(rec));
  });

  await check("an agent signal is self; an order is a system event", async () => {
    const base = tmpBase();
    await recordSignal({ agent: "momentum", type: "BUY", body: "AAPL breakout" }, { basePath: base });
    await recordOrder({ id: "o1", symbol: "aapl", side: "BUY", qty: 1, status: "filled" }, { basePath: base });
    const [sig, ord] = readRegistry(base);
    assert.strictEqual(sig.actor_type, "agent");
    assert.strictEqual(sig.actor_id, "momentum");
    assert.strictEqual(isSelfAuthoredRecord(sig), true);
    assert.strictEqual(ord.actor_type, "system");
    assert.strictEqual(ord.actor_id, "trading-store");
    assert.strictEqual(ord.metadata.provenance, PROVENANCE.SYSTEM);
    assert.strictEqual(isSelfAuthoredRecord(ord), false);
    assert.ok(verifyRecord(sig) && verifyRecord(ord));
  });

  await check("records without provenance fall back to content.role", async () => {
    assert.strictEqual(isSelfAuthoredRecord({ actor_type: "system", content: { role: "convergance" } }), true);
    assert.strictEqual(isSelfAuthoredRecord({ actor_type: "system", content: { role: "user" } }), false);
    assert.strictEqual(isSelfAuthoredRecord({ actor_type: "system", content: { role: "system" } }), false);
    assert.strictEqual(isSelfAuthoredRecord({ actor_type: "agent", content: {} }), true);
    assert.strictEqual(isSelfAuthoredRecord(null), false);
  });

  await check("explicit provenance wins over a self-looking role", async () => {
    assert.strictEqual(isSelfAuthoredRecord({ metadata: { provenance: "user" }, content: { role: "lantern" } }), false);
    assert.strictEqual(isSelfAuthoredRecord({ metadata: { provenance: "self" }, content: { role: "user" } }), true);
  });

  await check("conversation roles: the assistant's voice is self, the user's is not", async () => {
    assert.strictEqual(isSelfTurnRole("lantern"), true);
    assert.strictEqual(isSelfTurnRole("assistant"), true);
    assert.strictEqual(isSelfTurnRole("Lantern"), true);
    assert.strictEqual(isSelfTurnRole("user"), false);
    assert.strictEqual(isSelfTurnRole(undefined), false);
  });

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall csf-memory-writer provenance checks passed\n");
})();
