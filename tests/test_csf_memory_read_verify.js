// Read-path integrity verification (#1663 follow-up).
// Verifies that csf-memory._verifyRecords honors CSF_VERIFY_ON_READ modes:
//   off/warn keep everything; enforce drops checksum-mismatching records;
//   records without a checksum are always kept.
const assert = require("assert");

const writer = require("../apps/lantern-garage/lib/csf-memory-writer.js");
const mem = require("../apps/lantern-garage/lib/csf-memory.js");

function soundRecord(id, content) {
  const rec = { memory_id: id, tier: "trace", content, checksum: "" };
  rec.checksum = writer._checksum(rec);
  return rec;
}

const good = soundRecord("good-1", { text: "alpha" });
const tampered = soundRecord("bad-1", { text: "beta" });
tampered.content.text = "MUTATED"; // body changed after stamping -> checksum no longer matches
const noChecksum = { memory_id: "legacy-1", tier: "trace", content: { text: "gamma" } };

// sanity: writer agrees
assert.ok(writer.verifyRecord(good), "sound record should verify");
assert.ok(!writer.verifyRecord(tampered), "tampered record should fail verify");

const prev = process.env.CSF_VERIFY_ON_READ;

// off: keep everything, no verification
process.env.CSF_VERIFY_ON_READ = "off";
assert.strictEqual(mem._verifyRecords([good, tampered, noChecksum], "t").length, 3, "off keeps all");

// warn: verify + log, but keep everything (non-destructive default)
process.env.CSF_VERIFY_ON_READ = "warn";
assert.strictEqual(mem._verifyRecords([good, tampered, noChecksum], "t").length, 3, "warn keeps all");

// enforce: drop the tampered record, keep sound + unstamped
process.env.CSF_VERIFY_ON_READ = "enforce";
const enforced = mem._verifyRecords([good, tampered, noChecksum], "t");
assert.deepStrictEqual(
  enforced.map((r) => r.memory_id).sort(),
  ["good-1", "legacy-1"],
  "enforce drops only the tampered record, keeps unstamped"
);

// default (unset) behaves like warn -> keeps all
delete process.env.CSF_VERIFY_ON_READ;
assert.strictEqual(mem._verifyRecords([good, tampered], "t").length, 2, "default (warn) keeps all");

if (prev === undefined) delete process.env.CSF_VERIFY_ON_READ;
else process.env.CSF_VERIFY_ON_READ = prev;

console.log("test_csf_memory_read_verify: OK");
