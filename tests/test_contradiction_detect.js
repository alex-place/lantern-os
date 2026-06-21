/**
 * Regression for time-aware contradiction detection (#939 / #919.4).
 * Run: node tests/test_contradiction_detect.js
 */
"use strict";
const assert = require("assert");
const path = require("path");
const { findContradictions } =
  require(path.resolve(__dirname, "../apps/lantern-garage/lib/contradiction-detect"));

let passed = 0;
const ok = (n) => { passed++; console.log("  ✓ " + n); };

function packet(id, scope, ci, created_at) {
  return { packet_id: `claim:${id}`, created_at,
    claim: { scope }, measurement: { confidence_interval: ci } };
}

// Same scope, disjoint CIs → contradiction; newer is "current".
let r = findContradictions([
  packet("a", "trading:winrate", [0.6, 0.7], "2026-06-20T00:00:00Z"),
  packet("b", "trading:winrate", [0.3, 0.4], "2026-06-21T00:00:00Z"),
]);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].scope, "trading:winrate");
assert.strictEqual(r[0].current, "claim:b"); // newer
ok("disjoint CIs in same scope → one contradiction, newer flagged current");

// Overlapping CIs → not a contradiction.
r = findContradictions([
  packet("a", "trading:winrate", [0.5, 0.7], "2026-06-20T00:00:00Z"),
  packet("b", "trading:winrate", [0.6, 0.8], "2026-06-21T00:00:00Z"),
]);
assert.deepStrictEqual(r, []);
ok("overlapping CIs → no contradiction");

// Different scope → never compared even if disjoint.
r = findContradictions([
  packet("a", "trading:winrate", [0.6, 0.7], "2026-06-20T00:00:00Z"),
  packet("b", "weather:rain", [0.1, 0.2], "2026-06-21T00:00:00Z"),
]);
assert.deepStrictEqual(r, []);
ok("different scopes are never contradictions");

// Missing CI → skipped (can't numerically compare), no false positive.
r = findContradictions([
  packet("a", "x:y", [0.6, 0.7], "2026-06-20T00:00:00Z"),
  { packet_id: "claim:b", created_at: "2026-06-21T00:00:00Z", claim: { scope: "x:y" }, measurement: {} },
]);
assert.deepStrictEqual(r, []);
ok("packet without a confidence interval is skipped, not flagged");

// Revoked packets are excluded upstream (listPackets('approved')), so a stale revoked
// packet never appears — modeled here by simply not passing it in.
r = findContradictions([
  packet("old", "m:v", [0.6, 0.7], "2026-06-19T00:00:00Z"),
  // the contradicting newer packet was sanctioned: the old one would be revoked and
  // thus absent. Only one approved packet remains → no contradiction.
]);
assert.deepStrictEqual(r, []);
ok("a sanctioned update (other packet revoked → absent) is not a contradiction");

console.log(`\n#939 contradiction detection: ${passed} checks passed.`);
