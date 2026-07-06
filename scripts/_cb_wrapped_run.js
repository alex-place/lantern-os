"use strict";
// Helper for scripts/eval_coding_backend_ab.py — runs ONE coding task through the
// Keystone coding-backend control plane end-to-end (propose -> HOLD -> receipt ->
// approve -> apply) and prints JSON so the Python harness can grade the applied code.
// Usage: node scripts/_cb_wrapped_run.js "<task prompt>" [backend]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const cb = require("../apps/lantern-garage/lib/coding-backend");

(async () => {
  const task = process.argv[2] || "";
  const backend = process.argv[3] || "ollama";
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cbab-repo-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "cbab-data-"));
  // git-init the temp repo — the Aider/OpenHands adapters operate on git (status/checkout).
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@keystone.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "keystone"], { cwd: repo });
  } catch {}
  const out = { held: false, receiptId: null, model: null, localEngine: null, code: "", applied: false, error: null };
  try {
    const r = await cb.runCodingTask({ task, repoPath: repo, backend, why: "ab:wrapped" }, { dataDir: data });
    if (!r.ok) { out.error = r.error; console.log(JSON.stringify(out)); return; }
    out.held = r.status === "awaiting_approval";
    out.receiptId = r.receiptId;
    out.model = r.receipt && r.receipt.model;
    out.localEngine = r.localEngine;
    // file must NOT exist before approval (the HOLD)
    const rel = r.proposal.filesChanged[0];
    out.heldOnDisk = !fs.existsSync(path.join(repo, rel));
    const a = await cb.approveCodingPatch(r.pendingId, { dataDir: data });
    out.applied = a.ok;
    if (a.ok) out.code = fs.readFileSync(path.join(repo, rel), "utf8");
  } catch (e) {
    out.error = e.message;
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify(out));
})();
