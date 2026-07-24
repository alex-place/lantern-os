// #1429 — personal-fact detection (Remember stage). Pure, deterministic.
// This module has no store/route/page of its own — see csf-memory-writer.test.js for the
// persistence side (recordLifeFact writes through the ONE canonical CSF memory).
//
// Run: node test/life-memory.test.js
const assert = require("assert");
const lm = require("../lib/life-memory");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

check("extractFact parses possessive 'X's Y is Z'", () => {
  const f = lm.extractFact("my kid's shoe size is 7");
  assert.strictEqual(f.subject, "my kid");
  assert.strictEqual(f.attribute, "shoe size");
  assert.strictEqual(f.value, "7");
});

check("extractFact parses bare 'X is Y'", () => {
  const f = lm.extractFact("the landlord's name is Dana");
  assert.strictEqual(f.subject, "the landlord");
  assert.strictEqual(f.value, "Dana");
  const f2 = lm.extractFact("my favorite coffee order is an oat flat white");
  assert.strictEqual(f2.value, "an oat flat white");
});

check("extractFact strips a trailing period", () =>
  assert.strictEqual(lm.extractFact("Mom's birthday is March 3.").value, "March 3"));

// The critical correctness property: this now gates automatic capture on EVERY chat
// message, so questions must NEVER be treated as fact assertions.
check("extractFact rejects questions (wh-word, ends in '?', auxiliary-inversion)", () => {
  assert.strictEqual(lm.extractFact("what is my kid's shoe size?"), null);
  assert.strictEqual(lm.extractFact("what's my kid's shoe size"), null);  // no '?' but starts with wh-word
  assert.strictEqual(lm.extractFact("is my kid's shoe size 7?"), null);
  assert.strictEqual(lm.extractFact("do you know the landlord's name?"), null);
  assert.strictEqual(lm.extractFact("how is the weather"), null);
});

check("extractFact rejects non-assertions with no catch-all fallback", () => {
  assert.strictEqual(lm.extractFact("hey what's up"), null);
  assert.strictEqual(lm.extractFact("thanks for the help"), null);
  assert.strictEqual(lm.extractFact(""), null);
  assert.strictEqual(lm.extractFact("   "), null);
  assert.strictEqual(lm.extractFact("x".repeat(400)), null); // too long
});

// #1978 pollution regression: the loose bare "X is Y" regex used to capture ANY sentence
// containing is/are/was, so typed eval/trading/topic prompts landed in the personal-fact
// store. These examples are pulled straight from the polluted data/csf_memory/raw.jsonl —
// they must NOT match now that a bare subject requires a first-person anchor.
check("extractFact rejects eval/trading/topic prompts that merely contain 'is'", () => {
  assert.strictEqual(lm.extractFact("A Kalshi YES contract costs 37 cents and you believe the true probability is 45%"), null);
  assert.strictEqual(lm.extractFact("hey can you look into how heat pump adoption is trending for US homeowners in 2026? curious what the real numbers look like"), null);
  assert.strictEqual(lm.extractFact("hey can you look into what the best carbon capture technologies is looking like for 2026"), null);
  assert.strictEqual(lm.extractFact("the true probability is 45 percent"), null); // no first-person anchor
});

// Serialized Three Doors game state (subject carries parentheses + a pipe). Even if such a
// string were ever fed to extractFact, it is game progress, not a personal fact.
check("extractFact rejects serialized Three Doors game state (parenthesized/pipe subject)", () => {
  assert.strictEqual(lm.extractFact("Three Doors (kriskin, the Jester)'s xp-door is Chose the Little Warm Door; entered the XP dreamworld with Blinkbug | Chose: C · The Little Warm Door"), null);
});

// The anchor requirement must not throw the baby out: genuine first-person facts still parse.
check("extractFact still captures genuine first-person facts", () => {
  assert.strictEqual(lm.extractFact("my dog is named Rex").subject, "my dog");
  assert.strictEqual(lm.extractFact("our anniversary is June 5").value, "June 5");
});

check("categorize buckets by keyword", () => {
  assert.strictEqual(lm.categorize("the landlord's name is Dana"), "people");
  assert.strictEqual(lm.categorize("the project deadline is April 5"), "dates");
  assert.strictEqual(lm.categorize("my shoe size is 7"), "preferences");
  assert.strictEqual(lm.categorize("the gym address is 5th street"), "places");
  assert.strictEqual(lm.categorize("plain unrelated statement is true"), "other");
});

check("keywordsFromFact drops stopwords/short tokens, dedupes", () => {
  const kws = lm.keywordsFromFact({ subject: "my kid", attribute: "shoe size", value: "the size is 7" });
  assert.ok(kws.includes("kid") && kws.includes("shoe") && kws.includes("size"));
  assert.ok(!kws.includes("my") && !kws.includes("the") && !kws.includes("is"));
  assert.strictEqual(kws.filter((w) => w === "size").length, 1); // deduped
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall life-memory checks passed\n");
