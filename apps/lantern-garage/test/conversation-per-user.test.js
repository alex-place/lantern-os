// conversation-per-user.test.js — per-user conversation persistence.
// A logged-in user's turns live in an isolated per-profile file (history follows
// the PROFILE, not the client sessionId) and are never returned to another user;
// guests fall back to the shared device-local log, scoped by sessionId.
// Run: node apps/lantern-garage/test/conversation-per-user.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
}
function fresh(rel) {
  const abs = require.resolve(rel);
  delete require.cache[abs];
  return require(rel);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unisona-peruser-"));
  const saved = process.env.UNISONA_STATE_DIR;
  process.env.UNISONA_STATE_DIR = dir;
  try {
    const store = fresh("../lib/conversation-store");
    const dataConv = path.join(dir, "data", "conversations");

    await check("per-user turns write to isolated per-profile files", async () => {
      await store.appendConversationEntry({ userId: "alice", sessionId: "s1", role: "operator", text: "alice secret" });
      await store.appendConversationEntry({ userId: "bob", sessionId: "s2", role: "operator", text: "bob secret" });
      const aliceFile = path.join(dataConv, "users", "alice", "conversations.jsonl");
      const bobFile = path.join(dataConv, "users", "bob", "conversations.jsonl");
      assert.ok(fs.existsSync(aliceFile), "alice file exists");
      assert.ok(fs.existsSync(bobFile), "bob file exists");
      assert.ok(fs.readFileSync(aliceFile, "utf8").includes("alice secret"));
      assert.ok(!fs.readFileSync(aliceFile, "utf8").includes("bob secret"), "no cross-write into alice");
    });

    await check("a user reads only their own turns (no cross-user leak)", () => {
      const aliceRows = store.readConversationLog(50, null, "alice");
      const bobRows = store.readConversationLog(50, null, "bob");
      assert.ok(aliceRows.some((r) => r.text === "alice secret"), "alice sees her turn");
      assert.ok(!aliceRows.some((r) => r.text === "bob secret"), "alice never sees bob's turn");
      assert.ok(bobRows.some((r) => r.text === "bob secret"), "bob sees his turn");
    });

    await check("guest turns go to the shared device-local log, scoped by session", async () => {
      await store.appendConversationEntry({ sessionId: "guestA", role: "operator", text: "guestA msg" });
      await store.appendConversationEntry({ sessionId: "guestB", role: "operator", text: "guestB msg" });
      const legacy = path.join(dataConv, "garage-conversations.jsonl");
      assert.ok(fs.existsSync(legacy), "guest/legacy log exists");
      const a = store.readConversationLog(50, "guestA", null);
      assert.ok(a.some((r) => r.text === "guestA msg"), "guestA sees own session");
      assert.ok(!a.some((r) => r.text === "guestB msg"), "guestA does not see guestB");
      // A logged-in user's isolated file must NOT contain guest turns.
      assert.ok(!store.readConversationLog(50, null, "alice").some((r) => r.text === "guestA msg"));
    });

    await check("operator merge-read sees every user + guest", () => {
      const all = store.readAllConversations(500).map((r) => r.text);
      for (const t of ["alice secret", "bob secret", "guestA msg", "guestB msg"]) {
        assert.ok(all.includes(t), `merge view includes ${t}`);
      }
    });

    await check("clearing one user leaves others intact", () => {
      const res = store.clearConversations({ userId: "alice" });
      assert.ok(res.removed >= 1, "removed alice's turns");
      assert.strictEqual(store.readConversationLog(50, null, "alice").length, 0, "alice log now empty");
      assert.ok(store.readConversationLog(50, null, "bob").some((r) => r.text === "bob secret"), "bob untouched");
    });

    await check("safeUserId neutralizes path-traversal ids", () => {
      const evil = store.safeUserId("../../etc/passwd");
      assert.ok(/^u_[a-f0-9]{32}$/.test(evil), `traversal id is hashed to a safe token, got ${evil}`);
      assert.strictEqual(store.safeUserId("local-owner"), "local-owner", "normal id passes through");
      assert.strictEqual(store.safeUserId(null), null, "guest → null");
    });
  } finally {
    if (saved === undefined) delete process.env.UNISONA_STATE_DIR; else process.env.UNISONA_STATE_DIR = saved;
    fresh("../lib/conversation-store"); // restore default-env module for later requirers
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) { console.error(`\nconversation-per-user: ${failures} FAILED`); process.exit(1); }
  console.log("\nconversation-per-user: all checks passed");
})();
