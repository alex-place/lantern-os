// coding-backend.test.js — the OSS-BASELINE first slice: a coding backend PROPOSES a
// change, the control plane HOLDS it for approval and emits a RECEIPT, and only an
// explicit approval applies it. Proves the accountability layer that no raw OSS coding
// agent (Aider/OpenHands/opencode) ships. See docs/OSS-BASELINE.md.
// Run: node apps/lantern-garage/test/coding-backend.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cb = require("../lib/coding-backend");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (e) {
    failures++;
    console.error("  FAIL-", name, "\n      ", e.message);
  }
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kb-cb-"));
}

(async () => {
  await check("listBackends includes mock and aider", () => {
    const b = cb.listBackends();
    assert(b.includes("mock") && b.includes("aider"), "expected mock+aider backends");
  });

  await check("mock: propose HOLDS the change (nothing applied) + emits receipt + pending", async () => {
    const repo = tmp(), data = tmp();
    const r = await cb.runCodingTask({ task: "Add a hello note", repoPath: repo, backend: "mock", why: "test" }, { dataDir: data });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, "awaiting_approval");
    assert(r.receiptId && r.pendingId, "receipt+pending ids expected");
    const rel = r.proposal.filesChanged[0];
    assert(!fs.existsSync(path.join(repo, rel)), "file must NOT be written before approval");
    const rc = cb.readReceipts({ dataDir: data }).find((x) => x.id === r.receiptId);
    assert(rc && rc.status === "proposed" && rc.patchSha256, "receipt persisted with hash");
    assert(cb.listCodingPending({ dataDir: data }).some((x) => x.id === r.pendingId), "pending listed");
  });

  await check("approve APPLIES the change + finalizes the receipt", async () => {
    const repo = tmp(), data = tmp();
    const r = await cb.runCodingTask({ task: "Write config", repoPath: repo, backend: "mock" }, { dataDir: data });
    const rel = r.proposal.filesChanged[0];
    const a = await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    assert.strictEqual(a.ok, true);
    assert(fs.existsSync(path.join(repo, rel)), "file must exist after approval");
    assert(fs.readFileSync(path.join(repo, rel), "utf8").includes("Write config"), "content applied");
    assert(!cb.listCodingPending({ dataDir: data }).some((x) => x.id === r.pendingId), "pending cleared");
    const rc = cb.readReceipts({ dataDir: data }).filter((x) => x.id === r.receiptId).pop();
    assert.strictEqual(rc.status, "applied");
  });

  await check("reject does NOT apply the change", async () => {
    const repo = tmp(), data = tmp();
    const r = await cb.runCodingTask({ task: "Delete prod", repoPath: repo, backend: "mock" }, { dataDir: data });
    const rel = r.proposal.filesChanged[0];
    const j = await cb.rejectCodingPatch(r.pendingId, { dataDir: data });
    assert.strictEqual(j.ok, true);
    assert(!fs.existsSync(path.join(repo, rel)), "rejected change must not be applied");
    assert(!cb.listCodingPending({ dataDir: data }).some((x) => x.id === r.pendingId), "pending cleared on reject");
  });

  await check("unknown backend is rejected", async () => {
    const r = await cb.runCodingTask({ task: "x", repoPath: tmp(), backend: "nope" }, { dataDir: tmp() });
    assert.strictEqual(r.ok, false);
  });

  await check("aider degrades gracefully when not installed", async () => {
    const avail = await require("../lib/coding-backend/adapters/aider").available();
    if (avail) {
      console.log("    (aider installed — skipping unavailability assertions)");
      return;
    }
    const r = await cb.runCodingTask({ task: "x", repoPath: tmp(), backend: "aider" }, { dataDir: tmp() });
    assert.strictEqual(r.ok, false);
    assert(/not available/.test(r.error), "should report unavailable");
    assert(r.hint && /aider/.test(r.hint), "should give an install hint");
    const ab = await cb.abCompare({ task: "x", repoPath: tmp(), backend: "aider" }, { dataDir: tmp() });
    assert.strictEqual(ab.measured, false);
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall coding-backend tests passed");
  process.exit(failures ? 1 : 0);
})();
