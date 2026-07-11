// #1922: the single unisona.ai persona must tell the model it can READ this project's
// repo and ground a resume / "describe my work here" ask on real files, instead of
// answering "I don't have direct access to its codebase" and emitting a placeholder.
//
// The over-restrictive job_application persona that produced the transcript ("every
// bullet must come from what the user told you") was removed in the single-keystone
// consolidation; this guards that the replacement carries an explicit repo-grounding
// directive so the regression can't creep back via a prompt edit.
//
// Run: node apps/lantern-garage/test/persona-repo-grounding.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const personasPath = path.resolve(__dirname, "../../../data/contexts/personas.json");
const data = JSON.parse(fs.readFileSync(personasPath, "utf8"));

check("personas.json is valid and has the keystone persona", () => {
  assert.ok(Array.isArray(data.personas) && data.personas.length >= 1);
  assert.ok(data.personas.find((p) => p.id === "keystone"));
});

const sp = (data.personas.find((p) => p.id === "keystone") || {}).systemPrompt || "";

check("does NOT reintroduce the removed job_application persona", () => {
  assert.ok(!data.personas.some((p) => p.id === "job_application"),
    "the restrictive job_application persona must stay removed (#1922 root cause)");
});

check("keystone persona instructs repo grounding for 'this project' asks", () => {
  assert.match(sp, /don't have access to the codebase/i, "must forbid the false no-access refusal");
  assert.match(sp, /README\.md/, "must name the canonical overview file");
  assert.match(sp, /CLAUDE\.md/);
  assert.match(sp, /ARCHITECTURE\.md/);
  assert.match(sp, /Read\/LS/, "must point at the repo-read tools");
  assert.match(sp, /grounding, not fabrication/i, "must frame reading the repo as grounding");
});

check("still forbids fabricating user facts (grounding rule intact)", () => {
  assert.match(sp, /[Nn]ever fabricate user facts/);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall persona repo-grounding checks passed");
