// #2193 — a bare entity/stats lookup ("Brandon Singer PGA", "LeBron James stats") carried
// no question word, so needsGrounding() returned false, no web search fired, and the model
// answered from memory — hedging or asking the user to clarify instead of looking it up.
// needsGrounding() now recognizes sports/stats/entity-lookup domains.
//
// Run: node test/needs-grounding-entity.test.js
const assert = require("assert");
const { needsGrounding } = require("../lib/web-search-client");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
}

check("#2193 bare sports-entity lookups now ground", () => {
  assert.ok(needsGrounding("Brandon Singer PGA"), "the exact reported query");
  assert.ok(needsGrounding("LeBron James stats"));
  assert.ok(needsGrounding("Scottie Scheffler world ranking"));
  assert.ok(needsGrounding("Lakers roster"));
  assert.ok(needsGrounding("Premier League standings"));
});

check("#2193 stats/ranking/schedule domain words ground", () => {
  assert.ok(needsGrounding("NFL scores this weekend"));
  assert.ok(needsGrounding("F1 schedule"));
  assert.ok(needsGrounding("batting average leaderboard"));
});

check("#2193 ordinary prose is NOT over-grounded (no false positives)", () => {
  assert.ok(!needsGrounding("I had a strange dream last night"));
  assert.ok(!needsGrounding("write me a poem about the ocean"));
  assert.ok(!needsGrounding("thanks, that helps"));
  assert.ok(!needsGrounding("help me plan my week"));
});

check("#2193 pre-existing grounding triggers still fire (no regression)", () => {
  assert.ok(needsGrounding("who is the president"));
  assert.ok(needsGrounding("latest news on the election"));
  assert.ok(needsGrounding("what is the capital of France?"));
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall needs-grounding entity checks passed");
