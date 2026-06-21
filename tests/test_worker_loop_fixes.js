/**
 * Regression for the fleet worker-loop fixes (#870 #871).
 * Run: node tests/test_worker_loop_fixes.js
 *
 * #871: the PR head owner must track the push remote (origin) / an env override —
 *       never the hardcoded `cdblasioli-gif` fork, which 422'd when origin differed.
 *
 * agent-worker-loop pulls in work-dispatcher → AgentSlotManager (which reads
 * ~/.claude/agent-slots.json), so we stub that chain to load the module in isolation.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const SRC = path.resolve(__dirname, "../src");

function stub(mod, exports) {
  const id = require.resolve(mod);
  require.cache[id] = { id, loaded: true, exports };
}
// Neutralize the slot/dispatch/worktree/queue chain so requiring the loop is side-effect free.
stub(`${SRC}/agent-slot-manager`, class { constructor() {} getEnabledSlots() { return []; } });
stub(`${SRC}/work-dispatcher`, { dispatchOne: async () => null });
stub(`${SRC}/worktree-manager`, { createWorktree() {}, removeWorktree() {}, listWorktrees() { return []; }, WORKTREE_BASE: "" });
stub(`${SRC}/queue-manager`, class { constructor() {} });

delete require.cache[require.resolve(`${SRC}/agent-worker-loop`)];
const wl = require(`${SRC}/agent-worker-loop`);

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

// originOwner honors AUTOWORK_FORK_OWNER first, so we can drive prHead deterministically.
const GH_REPO = process.env.GH_REPO || "alex-place/lantern-os";
const baseOwner = GH_REPO.split("/")[0]; // "alex-place"

// #871 (a): origin owner == base repo → bare branch head (same-repo PR)
process.env.AUTOWORK_FORK_OWNER = baseOwner;
assert.strictEqual(wl.prHead("claude/issue-100"), "claude/issue-100");
ok("#871 same-repo origin → --head <branch> (no owner prefix)");

// #871 (b): a fork owner → <owner>:<branch>
process.env.AUTOWORK_FORK_OWNER = "kriskin9-hash";
assert.strictEqual(wl.prHead("claude/issue-101"), "kriskin9-hash:claude/issue-101");
ok("#871 fork origin → --head <fork-owner>:<branch>");

// #871 (c): never the old hardcoded fork
assert.ok(!wl.prHead("claude/issue-102").includes("cdblasioli-gif"));
process.env.AUTOWORK_FORK_OWNER = "someone";
assert.ok(!wl.prHead("claude/x").includes("cdblasioli-gif"));
ok("#871 hardcoded cdblasioli-gif fork owner is gone");

delete process.env.AUTOWORK_FORK_OWNER;
console.log(`\nAll ${passed} worker-loop-fix assertions passed.`);
