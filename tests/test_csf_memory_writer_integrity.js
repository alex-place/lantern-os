/**
 * CSF memory checksum-integrity regression tests (pure JS, no server/Python).
 *
 * Pins the fix for the bug where 0/373 records in data/csf_memory/raw.jsonl
 * passed MemoryRecord.verify(): trading-memory.js / trading-news.js computed
 * the checksum with `JSON.stringify(payload, Object.keys(payload).sort())` —
 * the array arg is a *property allowlist*, not a key sort, so nested content.*
 * (the real order/signal/news payload) was excluded from the hash.
 *
 * Guards:
 *  - the shared canonical _checksum covers nested content (tampering content.*
 *    changes the digest)
 *  - trading-memory.js writers isolate to CSF_MEMORY_PATH (no longer pollute
 *    the repo's data/ dir) and produce records that verifyRecord() accepts
 *  - neither trading writer reintroduces the broken replacer pattern, and both
 *    defer to the shared csf-memory-writer _checksum
 *
 * All writes go to a temp CSF_MEMORY_PATH; the repo's data/ dir is untouched.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function log(...args) {
  process.stdout.write(args.join(" ") + "\n");
}

async function ok(label, fn) {
  try {
    await fn();
    log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    log(`  ✗ ${label}`);
    log(`    ${e.message}`);
    failed++;
  }
}

function readLastRecord(registry) {
  const lines = fs.readFileSync(registry, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csf-mem-integrity-"));
  process.env.CSF_MEMORY_PATH = path.join(tmpRoot, "csf_memory");
  process.env.LANTERN_TRADING_DATA_PATH = path.join(tmpRoot, "trading");
  const registry = path.join(process.env.CSF_MEMORY_PATH, "raw.jsonl");

  const csfWriter = require("../apps/lantern-garage/lib/csf-memory-writer");
  const tradingMemory = require("../apps/lantern-garage/lib/trading-memory");

  log("\nCSF memory checksum integrity — regression tests");

  await ok("shared _checksum covers nested content (the exact bug)", () => {
    const rec = {
      memory_id: "t1",
      tier: "trace",
      content: { signal_id: "s1", action: "buy AAPL", nested: { qty: 1 } },
      tags: ["trading", "signal"],
      checksum: "",
    };
    const base = csfWriter._checksum(rec);
    const tampered = { ...rec, content: { ...rec.content, action: "SELL AAPL (tampered)" } };
    assert.notStrictEqual(
      csfWriter._checksum(tampered),
      base,
      "mutating content.* must change the checksum"
    );
    // deep tamper too
    const deep = { ...rec, content: { ...rec.content, nested: { qty: 999 } } };
    assert.notStrictEqual(csfWriter._checksum(deep), base, "deep content.* must be covered");
  });

  await ok("_checksum is deterministic and self-verifies", () => {
    const rec = { memory_id: "t2", content: { a: 1, b: [1, 2, 3] }, checksum: "" };
    rec.checksum = csfWriter._checksum(rec);
    assert.strictEqual(csfWriter._checksum(rec), rec.checksum);
    assert.ok(csfWriter.verifyRecord(rec));
  });

  await ok("trading-memory recordSignal() isolates to CSF_MEMORY_PATH", async () => {
    await tradingMemory.recordSignal({
      id: "sig-iso-1",
      agent: "ROTATION",
      action: "buy AAPL",
      symbol: "AAPL",
      confidence: 0.82,
    });
    assert.ok(fs.existsSync(registry), "record should land in the temp registry");
    assert.ok(
      fs.readFileSync(registry, "utf8").includes("sig-iso-1"),
      "the written signal should be in the temp registry"
    );
    // The repo's real registry must NOT have received the test write.
    const repoRegistry = path.join(repoRoot, "data", "csf_memory", "raw.jsonl");
    if (fs.existsSync(repoRegistry)) {
      assert.ok(
        !fs.readFileSync(repoRegistry, "utf8").includes("sig-iso-1"),
        "test write leaked into the repo's real data/csf_memory/raw.jsonl"
      );
    }
  });

  await ok("trading-memory records self-verify and cover content", async () => {
    await tradingMemory.recordOrder({ id: "ord-iso-1", symbol: "TSLA", side: "buy", qty: 2, status: "filled" });
    const rec = readLastRecord(registry);
    assert.ok(csfWriter.verifyRecord(rec), "record must self-verify under the sound scheme");
    const tampered = { ...rec, content: { ...rec.content, symbol: "GME" } };
    assert.notStrictEqual(
      csfWriter._checksum(tampered),
      rec.checksum,
      "tampering a trading record's content must break its checksum"
    );
  });

  await ok("trading writers do not reintroduce the broken replacer scheme", () => {
    // Strip comments so a comment *describing* the old bug isn't a false hit —
    // this guard is about live code, not documentation.
    const stripComments = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const brokenPattern = /JSON\.stringify\([^)]*Object\.keys\([^)]*\)\.sort\(\)/;
    for (const f of ["trading-memory.js", "trading-news.js"]) {
      const code = stripComments(
        fs.readFileSync(path.join(repoRoot, "apps", "lantern-garage", "lib", f), "utf8")
      );
      assert.ok(
        !brokenPattern.test(code),
        `${f} reintroduced the broken JSON.stringify replacer-allowlist checksum`
      );
      assert.ok(
        /csfWriter\._checksum\(/.test(code),
        `${f} must compute its checksum via the shared csfWriter._checksum`
      );
    }
  });

  log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  log(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
