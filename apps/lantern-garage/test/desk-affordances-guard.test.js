// #2804: the desk prompt must keep enumerating the deterministic chat affordances so
// the model routes natural-language autowork/review/PR-list requests to the matching
// bang-command instead of dead-ending in a "I need more specifics" clarification loop.
//
// The behaviour was delivered in PR #2795 (the KNOW YOUR OWN AFFORDANCES clause in
// ROUTER_PROMPT), but nothing guarded it: the clause is one fragment inside a single
// giant template literal, so a prompt edit could silently drop it and no test would
// fail. Live evidence for why this matters (2026-07-21): "run autowork on issue #2762"
// hit a clarification loop three times because the model had no knowledge of `!work #N`.
//
// This is a source-guard, mirroring the #1925 clause-drift check in
// autowork-offer-guard.test.js: it reads the server source and asserts the acceptance
// language is present, so it runs dependency-free (no server boot, no node_modules) and
// is safe in a bare worktree.
//
// Run: node apps/lantern-garage/test/desk-affordances-guard.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const src = fs.readFileSync(
  path.resolve(__dirname, "../lib/stream-chat.js"), "utf8");

// The three deterministic commands the server routes without the model. Each must be
// named in the prompt with its number placeholder so the model can restate it verbatim.
check("desk prompt enumerates all three deterministic commands", () => {
  assert.match(src, /!work #<issue>/, "missing !work #<issue> in ROUTER_PROMPT");
  assert.match(src, /!review #<PR>/, "missing !review #<PR> in ROUTER_PROMPT");
  assert.match(src, /!prs\b/, "missing !prs in ROUTER_PROMPT");
});

// The self-awareness anchor from the self-assessment (capability-knowledge grade D).
check("desk prompt carries the KNOW YOUR OWN AFFORDANCES anchor", () => {
  assert.match(src, /KNOW YOUR OWN AFFORDANCES/,
    "the affordance-enumeration clause (#2795/#2804) is missing from ROUTER_PROMPT");
});

// The acceptance behaviour: a NL "run autowork on issue #N" must be answered with the
// matching command filled in, not a clarification dead-end. Guard the two load-bearing
// halves of that instruction.
check("desk prompt forbids the clarification dead-end for known-intent requests", () => {
  assert.match(src, /do NOT ask for specifics you already have/,
    "the no-clarification instruction is missing from ROUTER_PROMPT");
});
check("desk prompt requires restating the matching command verbatim", () => {
  assert.match(src, /MUST state the matching command verbatim/,
    "the restate-the-command instruction is missing from ROUTER_PROMPT");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall desk-affordance guard checks passed");
