/**
 * Regression: appendJsonlQueued can bound log growth via opt-in rotation (#872).
 * Run: node tests/test_file_queue_rotate.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { appendJsonlQueued, appendJsonlRotating } =
  require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "file-queue"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-fq-rot-"));
const archivesOf = (file) => {
  const base = path.basename(file);
  return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(base + ".") && n !== base);
};

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

(async () => {
  // (a) without rotate → never archives, even past the cap
  const a = path.join(TMP, "a.jsonl");
  for (let i = 0; i < 50; i++) await appendJsonlQueued(a, { i, pad: "x".repeat(50) });
  assert.strictEqual(archivesOf(a).length, 0, "no rotation without opts.rotate");
  ok("append without rotate → no archives (existing callers unchanged)");

  // (b) with a small cap → rotates; the next append recreates a fresh bounded base
  const b = path.join(TMP, "b.jsonl");
  for (let i = 0; i < 40; i++) {
    await appendJsonlQueued(b, { i, pad: "y".repeat(40) }, { rotate: { maxBytes: 256, keepArchives: 2 } });
  }
  assert.ok(archivesOf(b).length >= 1, "at least one archive created");
  // one more append recreates the live file (rotation renamed the previous one away)
  await appendJsonlQueued(b, { final: 1 }, { rotate: { maxBytes: 256, keepArchives: 2 } });
  assert.ok(fs.existsSync(b), "live base file recreated by the next append");
  assert.ok(fs.statSync(b).size < 256, "live file is bounded, not unbounded");
  ok("append with rotate → archives created, base file recreated + bounded");

  // (c) keepArchives prunes oldest
  assert.ok(archivesOf(b).length <= 2, `archives pruned to keepArchives=2 (have ${archivesOf(b).length})`);
  ok("keepArchives prunes oldest archives");

  // (d) appendJsonlRotating wrapper behaves the same
  const c = path.join(TMP, "c.jsonl");
  for (let i = 0; i < 40; i++) await appendJsonlRotating(c, { i, pad: "z".repeat(40) }, { maxBytes: 256, keepArchives: 3 });
  assert.ok(archivesOf(c).length >= 1, "wrapper rotates too");
  ok("appendJsonlRotating wrapper rotates with the given caps");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nAll ${passed} file-queue-rotation assertions passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
