// #1690 — IDF-weighted lexical ranking in the live JS chat read path (csf-memory.js).
// Ports the Python MemoryEngine #1689 fix. Pure functions only (no disk).
//
// Run: node apps/lantern-garage/test/csf-memory-idf.test.js
const assert = require("assert");
const { buildDocFreq, idfOf, relevanceScoreIdf, relevanceScore } = require("../lib/csf-memory");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// "meeting" is in many records; "pomegranate" in one → it's rarer/more discriminative.
const records = [];
for (let i = 0; i < 8; i++) records.push({ content: { text: `standup meeting number ${i}` }, tags: [] });
records.push({ content: { text: "the pomegranate harvest meeting" }, tags: [] });
const df = buildDocFreq(records);

check("idf is higher for a rare term than a common one", () => {
  assert.ok(idfOf(df, "pomegranate") > idfOf(df, "meeting"));
  assert.ok(idfOf(df, "meeting") > 0);                         // smoothed, always positive
  assert.ok(idfOf(df, "neverseen") > idfOf(df, "pomegranate")); // absent term → highest idf
});

check("relevanceScoreIdf: a rare-word match scores higher than a common-word match", () => {
  const q = "pomegranate meeting";
  const rareMatch = relevanceScoreIdf("notes about the pomegranate", q, df);   // matches rare only
  const commonMatch = relevanceScoreIdf("another meeting today", q, df);       // matches common only
  assert.ok(rareMatch > commonMatch, `rare ${rareMatch} should beat common ${commonMatch}`);
});

check("relevanceScoreIdf: matching both terms beats matching either alone", () => {
  const q = "pomegranate meeting";
  const both = relevanceScoreIdf("the pomegranate meeting", q, df);
  const one = relevanceScoreIdf("another meeting", q, df);
  assert.ok(both > one);
  assert.ok(both <= 1.0 && both > 0);                          // stays normalized 0..1
});

check("relevanceScoreIdf falls back to flat ratio when no df info (other callers unchanged)", () => {
  assert.strictEqual(relevanceScoreIdf("a meeting", "meeting", null), relevanceScore("a meeting", "meeting"));
});

check("empty query → 0", () =>
  assert.strictEqual(relevanceScoreIdf("anything", "", df), 0));

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall csf-memory-idf checks passed\n");
