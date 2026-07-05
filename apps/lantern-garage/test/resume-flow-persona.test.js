// #1919: the Keystone persona must drive the resume-builder flow through the existing
// primitives (no scripted intake form): deliver a draft first, persist the resume
// profile to workspace/resume-profile.json and reload it on a return visit (Remember),
// tailor to a pasted posting with honest gaps, and export a real .docx via
// export_document (Act). The end-to-end persist→reload→docx tool chain is verified
// manually (needs node_modules); this guards that the directive stays wired.
//
// Run: node apps/lantern-garage/test/resume-flow-persona.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const data = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../data/contexts/personas.json"), "utf8"));
const sp = (data.personas.find((p) => p.id === "keystone") || {}).systemPrompt || "";

check("personas.json valid, keystone present", () => {
  assert.ok(sp.length > 0);
});
check("resume flow: no scripted form, draft-first", () => {
  assert.match(sp, /## Resume & job applications/);
  assert.match(sp, /never an intake form/i);
});
check("resume flow: persists + reloads the profile (Remember)", () => {
  assert.match(sp, /resume-profile\.json/);
  assert.match(sp, /workspace_write/);
  assert.match(sp, /workspace_read/);
  assert.match(sp, /re-enters answers|reuse the profile/i);
});
check("resume flow: exports a real .docx (Act)", () => {
  assert.match(sp, /export_document/);
  assert.match(sp, /docx/);
});
check("resume flow: tailors to posting + honest gaps, no fabrication", () => {
  assert.match(sp, /tailor bullet emphasis/i);
  assert.match(sp, /honest gaps/i);
  assert.match(sp, /[Nn]ever fabricate experience/);
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall resume-flow persona checks passed");
