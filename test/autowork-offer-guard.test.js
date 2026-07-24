// #1925: the "Run as autowork → opens a draft PR" affordance must NOT appear on
// career/document turns that merely trip a code intent (via "repo"/"review"/"github").
// #1964 added the resume/cover-letter guard; this extends it to the job-search
// vocabulary the transcript called out ("fill out job applications", "review my job
// application", "apply for this GitHub job") while leaving genuine coding asks — where
// "apply" means apply-a-patch / a web "application" — still offering autowork.
//
// The predicate below MUST mirror `_looksLikeDocument` in
// public/js/dream-chat-ui.js; the final check asserts the source
// still carries the job-search clause so the two can't silently drift apart.
//
// Run: node test/autowork-offer-guard.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// Mirror of the client guard.
function looksLikeDocument(text) {
  return /\b(resume|cover letter|cover-letter|cv|docx|word (doc|document)|essay|memo|spreadsheet|presentation|slide deck|personal statement|letter of (intro|introduction|interest|recommendation))\b/i.test(text) ||
    /\b(job (application|applications|posting|postings|search|hunt|offer)|interview prep)/i.test(text) ||
    /\bapply(ing)? (for|to)\b.{0,40}?\b(job|position|role|internship|posting|opening|vacancy)\b/i.test(text);
}

const SUPPRESS = [
  "update my resume based on the lantern os repo",
  "review my job application",
  "help me apply for this GitHub job",
  "applying to a senior engineering role at Google",
  "i want to fill out job applications with it",
  "fix my cover letter for the role",
  "interview prep for my coding interview",
  "tailor my resume to this job posting",
];
const OFFER = [ // genuine coding — the autowork offer SHOULD still show
  "fix the bug in the api router",
  "apply the patch to stream-chat.js",
  "apply the migration to the database",
  "build a web application with express",
  "refactor the endpoint and add a test",
];

check("career/document turns suppress the autowork offer", () => {
  for (const t of SUPPRESS) assert.strictEqual(looksLikeDocument(t), true, `should suppress: "${t}"`);
});
check("genuine coding turns still offer autowork", () => {
  for (const t of OFFER) assert.strictEqual(looksLikeDocument(t), false, `should NOT suppress: "${t}"`);
});
check("source guard carries the #1925 job-search clause (no drift)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../public/js/dream-chat-ui.js"), "utf8");
  assert.match(src, /job \(application\|applications\|posting/, "job-search clause missing from dream-chat-ui.js");
  assert.match(src, /apply\(ing\)\? \(for\|to\)/, "apply-for-job clause missing from dream-chat-ui.js");
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall autowork-offer guard checks passed");
