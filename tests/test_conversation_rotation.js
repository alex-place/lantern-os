// test_conversation_rotation.js — #771 conversation-log rotation/retention.
// Uses a TEMP fixture only — never the live data/conversations/garage-conversations.jsonl
// (it is append-only and continuously written by the running server).
// Run: node tests/test_conversation_rotation.js
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appendJsonlQueued, rotateJsonlIfNeeded } = require("../apps/lantern-garage/lib/file-queue");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convrot-"));
const file = path.join(dir, "log.jsonl");
const base = "log.jsonl";
const archives = () => fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`) && n !== base);
let n = 0;
const ok = (name) => { n += 1; console.log("  ok -", name); };

(async () => {
  try {
    // below threshold → no-op
    await appendJsonlQueued(file, { text: "small" });
    let r = await rotateJsonlIfNeeded(file, { maxBytes: 10000, keepArchives: 3 });
    assert.strictEqual(r.rotated, null, "must not rotate under the cap");
    assert.ok(fs.existsSync(file) && archives().length === 0);
    ok("under cap is a no-op");

    // over threshold → rotate to a timestamped archive; original gone, archive present
    await appendJsonlQueued(file, { text: "x".repeat(120) });
    r = await rotateJsonlIfNeeded(file, { maxBytes: 50, keepArchives: 3 });
    assert.ok(r.rotated, "must rotate over the cap");
    assert.ok(!fs.existsSync(file), "current file renamed away");
    assert.strictEqual(archives().length, 1, "one archive after first rotation");
    ok("rotates past the cap");

    // appends recreate a fresh file
    await appendJsonlQueued(file, { text: "after" });
    assert.ok(fs.existsSync(file), "append recreates the active file");
    ok("append recreates the file post-rotation");

    // retention: many rotations keep only keepArchives newest
    const keep = 2;
    for (let i = 0; i < 5; i += 1) {
      await appendJsonlQueued(file, { text: `pad${i}-` + "y".repeat(120) });
      await rotateJsonlIfNeeded(file, { maxBytes: 50, keepArchives: keep });
    }
    assert.strictEqual(archives().length, keep, `prune keeps exactly ${keep} archives`);
    ok("prunes old archives to the retention window");

    // no data loss: the surviving archives + active file are all valid jsonl
    for (const a of archives()) {
      for (const line of fs.readFileSync(path.join(dir, a), "utf8").split(/\r?\n/).filter(Boolean)) {
        JSON.parse(line); // throws if rotation corrupted a record
      }
    }
    ok("archived records remain valid jsonl");

    console.log(`\nPASS — ${n} rotation checks`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
