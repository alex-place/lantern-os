// coding-tool.test.js — #2185: the propose_coding_change chat tool. The assistant
// PROPOSES a code change through the accountable backend (held + verified); a human
// approves via the surface. Validates registration, operator policy, the held+verdict
// summary, and error handling. Run: node apps/lantern-garage/test/coding-tool.test.js
"use strict";

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { REGISTRY, TOOL_NAMES } = require("../lib/tool-runner");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.stack || e.message); }
}

(async () => {
  await check("registered in TOOL_NAMES with mutating (operator-only) policy", () => {
    assert(TOOL_NAMES.includes("propose_coding_change"), "tool is registered");
    const t = REGISTRY.propose_coding_change;
    assert.strictEqual(t.policy, "mutating", "mutating → operator-gated by the runner");
    assert(t.schema.required.includes("task"));
    assert(!t.guest_safe, "must NOT be guest-safe (it mutates a repo)");
  });

  await check("no task → explicit error (never a silent no-op)", async () => {
    const out = await REGISTRY.propose_coding_change.run({ task: "  " });
    assert(/error: task is required/.test(out));
  });

  await check("proposes via the backend → HELD, verified, with a pending id (not applied)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tool-"));
    const out = await REGISTRY.propose_coding_change.run({ task: "add a readme note", repo_path: repo, backend: "mock" });
    assert(/HELD for approval \(NOT applied\)/.test(out), "held, not applied");
    assert(/Verification:/.test(out), "reports the verifier verdict");
    assert(/Pending id: [0-9a-f-]{8,}/.test(out), "returns a pending id to approve against");
    // the proposal is HELD — nothing written into the repo yet
    assert.strictEqual(fs.readdirSync(repo).length, 0, "repo untouched until approval");
  });

  await check("unknown backend → graceful failure string (no throw)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tool2-"));
    const out = await REGISTRY.propose_coding_change.run({ task: "x", repo_path: repo, backend: "does-not-exist" });
    assert(/propose_coding_change failed/.test(out));
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall coding-tool (#2185) tests passed");
  process.exit(failures ? 1 : 0);
})();
