/**
 * csf-memory relevance/recall tests (#1276).
 * Locks in the anti-confabulation properties of cross-session recall:
 *  - relevanceScore ignores ultra-common stopwords (no false overlap on "the/is/what").
 *  - distinctiveHitCount is the absolute gate queryConversationMemory uses: a turn that
 *    shares only ONE content word with the query must score < 2 and therefore NOT be
 *    recalled as authoritative memory.
 *
 * Run: node tests/test_csf_memory.js
 */
"use strict";
const assert = require("assert");
const path = require("path");
const { relevanceScore, distinctiveHitCount } =
  require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "csf-memory"));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); passed++; }
  catch (e) { console.log("  ✗ " + name + "\n    " + e.message); failed++; }
}

// ── relevanceScore ──────────────────────────────────────────────────────
test("relevanceScore: ignores stopwords (only content words count)", () => {
  // "what / is / the" are stopwords → query reduces to {system, status}; a text with
  // both content words scores 1, a text sharing only stopwords scores 0.
  assert.strictEqual(relevanceScore("system status looks healthy", "what is the system status"), 1);
  assert.strictEqual(relevanceScore("what is the answer", "what is the system status"), 0);
});

test("relevanceScore: bidirectional content-word overlap", () => {
  const s = relevanceScore("the convergence router is fast", "convergence router design");
  assert.ok(s > 0.6 && s <= 1, `expected ~0.67, got ${s}`);
  assert.strictEqual(relevanceScore("totally different subject here", "convergence router design"), 0);
});

test("relevanceScore: empty / falsy inputs → 0", () => {
  assert.strictEqual(relevanceScore("", "x"), 0);
  assert.strictEqual(relevanceScore("x", ""), 0);
  assert.strictEqual(relevanceScore(null, "x"), 0);
});

// ── distinctiveHitCount (the #1276 recall gate) ─────────────────────────
test("distinctiveHitCount: counts DISTINCT shared content words", () => {
  assert.strictEqual(distinctiveHitCount("the convergence router rocks", "convergence router design"), 2);
});

test("distinctiveHitCount: one coincidental common word → 1 (below the >=2 recall gate)", () => {
  // The #1276 confabulation case: a past turn sharing a single content word with the
  // query must NOT clear the recall bar (queryConversationMemory requires >= 2).
  assert.strictEqual(distinctiveHitCount("the dream journal system works", "how is the trading system"), 1);
  assert.ok(distinctiveHitCount("the dream journal system works", "how is the trading system") < 2);
});

test("distinctiveHitCount: no shared content words → 0", () => {
  assert.strictEqual(distinctiveHitCount("nothing in common at all", "convergence router design"), 0);
});

test("distinctiveHitCount: a genuinely on-topic turn clears the >=2 gate", () => {
  assert.ok(distinctiveHitCount("we discussed the convergence router cache design", "convergence router design") >= 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
