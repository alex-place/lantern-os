// appdata-migration.test.js — #1946 G2 call-site migration (item 1). The chat-memory
// stores now root their writable state at app-paths.dataRoot() and read it back
// through file-queue's data/-aware anchor, so the desktop app (UNISONA_STATE_DIR /
// UNISONA_DESKTOP) keeps its memory under %APPDATA%\unisona\data. On servers
// (neither set) every path is byte-for-byte today's <repoRoot>/data.
// Run: node test/appdata-migration.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const appPaths = require("../lib/app-paths");
const REPO_DATA = path.join(appPaths.repoRoot, "data");

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
}

// Re-require a module fresh so its require-time path constants pick up the env.
function fresh(rel) {
  const abs = require.resolve(rel);
  delete require.cache[abs];
  return require(rel);
}

(async () => {
  // ── read anchor: data/ follows the state root; repo artifacts stay at repoRoot ──
  await check("file-queue.readAnchor sends data/ to stateRoot, manifests//reports/ to repoRoot", () => {
    const fq = require("../lib/file-queue");
    const saved = process.env.UNISONA_STATE_DIR;
    process.env.UNISONA_STATE_DIR = path.join(os.tmpdir(), "unisona-anchor-x");
    try {
      const stateRoot = appPaths.stateRoot();
      assert.strictEqual(fq.readAnchor("data/conversations/x.jsonl"), stateRoot, "data/ → stateRoot");
      assert.strictEqual(fq.readAnchor("manifests/x.md"), appPaths.repoRoot, "manifests/ → repoRoot");
      assert.strictEqual(fq.readAnchor("reports/x.json"), appPaths.repoRoot, "reports/ → repoRoot");
      assert.strictEqual(fq.readAnchor("/data/x"), stateRoot, "leading slash tolerated");
    } finally {
      if (saved === undefined) delete process.env.UNISONA_STATE_DIR; else process.env.UNISONA_STATE_DIR = saved;
    }
  });

  // ── no regression: default profile roots every store at <repoRoot>/data ──
  await check("DEFAULT profile: dataRoot() is byte-for-byte <repoRoot>/data", () => {
    const saved = process.env.UNISONA_STATE_DIR;
    delete process.env.UNISONA_STATE_DIR;
    try { assert.strictEqual(appPaths.dataRoot(), REPO_DATA); }
    finally { if (saved !== undefined) process.env.UNISONA_STATE_DIR = saved; }
  });

  // ── end-to-end: a relocated conversation store writes AND reads back coherently ──
  await check("conversation-store: append + read round-trips under a relocated state dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unisona-mig-"));
    const saved = process.env.UNISONA_STATE_DIR;
    process.env.UNISONA_STATE_DIR = dir;
    try {
      const store = fresh("../lib/conversation-store");
      const sessionId = "mig-test-session";
      const entry = { sessionId, role: "user", text: "relocation round-trip", ts: "2026-07-04T00:00:00Z" };
      await store.appendConversationEntry(entry);

      // WRITE relocated: the log file lives under the state dir, not the repo.
      const expected = path.join(dir, "data", "conversations", "garage-conversations.jsonl");
      assert.ok(fs.existsSync(expected), `log should be written under the state dir: ${expected}`);
      assert.ok(fs.readFileSync(expected, "utf8").includes("relocation round-trip"), "entry should be on disk under the state dir");

      // READ relocated: readConversationLog resolves through the data/-aware anchor.
      const rows = store.readConversationLog(10, sessionId);
      assert.ok(rows.some((r) => r.text === "relocation round-trip"), "appended entry should read back");
    } finally {
      if (saved === undefined) delete process.env.UNISONA_STATE_DIR; else process.env.UNISONA_STATE_DIR = saved;
      fresh("../lib/conversation-store"); // restore default-env module for any later requirer
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── step 2: the CSF memory archive relocates too ──────────────────────────────
  await check("csf-memory-writer: recordLifeFact writes the archive under a relocated state dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unisona-csf-"));
    const saved = process.env.UNISONA_STATE_DIR;
    process.env.UNISONA_STATE_DIR = dir;
    try {
      const writer = fresh("../lib/csf-memory-writer");
      const rec = await writer.recordLifeFact({ value: "csf relocation", attribute: "test", sessionId: "mig" });
      assert.ok(rec, "recordLifeFact should write a record");
      const csfDir = path.join(dir, "data", "csf_memory");
      assert.ok(fs.existsSync(csfDir), `CSF archive should live under the state dir: ${csfDir}`);
      assert.ok(fs.existsSync(path.join(csfDir, "raw.jsonl")), "raw.jsonl should be under the state dir");
    } finally {
      if (saved === undefined) delete process.env.UNISONA_STATE_DIR; else process.env.UNISONA_STATE_DIR = saved;
      fresh("../lib/csf-memory-writer");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failures) { console.error(`\nappdata-migration: ${failures} FAILED`); process.exit(1); }
  console.log("\nappdata-migration: all checks passed");
})();
