"use strict";
/**
 * Tests for contradiction-scanner.js (#939 / #919.4).
 *
 * Acceptance criteria from the issue:
 *   - Only APPROVED packets are scanned.
 *   - Sanctioned updates (revoked) are NOT flagged.
 *   - Two approved packets with the same scope and disagreeing values → contradiction.
 *   - Packets with different scopes are never contradictions.
 *   - Revoked + Approved pair in same scope → no contradiction (revoke is the update path).
 */

const assert = require("assert");
const {
  scanContradictions,
  packetsContradict,
  measurementValuesContradict,
  wordingsContradict,
} = require("../apps/lantern-garage/lib/contradiction-scanner");

// ── Packet factory ────────────────────────────────────────────────────────────

let seq = 0;
function makePacket({
  scope = "animal_health:sleep",
  value = 0.3,
  wording = "Animals sleep on average 8 hours per night",
  status = "approved",
  reviewedAt = null,
} = {}) {
  seq++;
  return {
    schema: "lantern.claim_packet.v1",
    packet_id: `claim:00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    created_at: new Date(Date.now() - seq * 1000).toISOString(),
    claim: { scope, safe_wording: wording, title: `Claim ${seq}`, kind: "measurement",
             flourishing_dimensions: ["animal_health"], domain: "test" },
    measurement: { value, uncertainty: 0.1, confidence_interval: [0.2, 0.4],
                   sample_size: 100, source: "test", methodology: "test",
                   temporal_range: ["2024-01-01", "2024-12-31"], scope: "global",
                   confounders: [], missing: [],
                   measurement_hash: `sha256:${"a".repeat(64)}` },
    evidence: { evidence_class: "local_pilot", certainty: "low",
                replication_status: "not_replicated", source_refs: [], status_cube_refs: [] },
    privacy: { raw_private_data_included: false, privacy_level: "aggregated",
               allowed_use: "aggregate_pattern_only", revocable: true },
    risk: { risk_class: "trivial", sensitive: false, automation_allowed: false,
            recommendation_allowed: false },
    review: { consent_gate_status: status, reviewer: "test", challenge_path: false,
              rollback_path: false, reviewed_at: reviewedAt || new Date().toISOString() },
    origin: { node_id: "node:test", software: "lantern-os", software_version: "1.0.0",
              operator_approved: true },
    signature: { algorithm: "ed25519", public_key: "ed25519:AAAA", signature: "BBBB" },
  };
}

// ── measurementValuesContradict ───────────────────────────────────────────────

function test_numeric_sign_disagree_contradicts() {
  assert.strictEqual(measurementValuesContradict(1.5, -0.3), true,
    "positive vs negative should contradict");
}

function test_numeric_same_sign_no_contradiction() {
  assert.strictEqual(measurementValuesContradict(1.5, 0.3), false,
    "same positive sign should not contradict");
}

function test_zero_values_no_contradiction() {
  assert.strictEqual(measurementValuesContradict(0, -0.3), false,
    "zero sign (neutral) should not contradict");
}

function test_string_numeric_parsed() {
  assert.strictEqual(measurementValuesContradict("2.0", "-1.0"), true,
    "string numerics are parsed before comparison");
}

function test_non_numeric_no_contradiction() {
  assert.strictEqual(measurementValuesContradict("high", "low"), false,
    "non-numeric strings defer to wording check");
}

// ── wordingsContradict ────────────────────────────────────────────────────────

function test_negation_flip_contradicts() {
  const a = "Animals sleep well in group housing";
  const b = "Animals do not sleep well in group housing";
  assert.strictEqual(wordingsContradict(a, b), true, "negated wording should contradict");
}

function test_same_polarity_no_contradiction() {
  const a = "Animals sleep well in group housing";
  const b = "Animals rest well in group environments";
  assert.strictEqual(wordingsContradict(a, b), false, "same polarity should not contradict");
}

function test_unrelated_topics_no_contradiction() {
  const a = "Cows produce milk efficiently";
  const b = "Fish do not use oxygen from air";
  assert.strictEqual(wordingsContradict(a, b), false,
    "unrelated topics should not contradict even if one is negated");
}

// ── packetsContradict ─────────────────────────────────────────────────────────

function test_approved_same_scope_different_value_sign_contradicts() {
  const a = makePacket({ value: 0.5, scope: "animal_health:sleep" });
  const b = makePacket({ value: -0.5, scope: "animal_health:sleep" });
  const { contradicts } = packetsContradict(a, b);
  assert.ok(contradicts, "same scope, opposite sign values should contradict");
}

function test_approved_different_scopes_no_contradiction() {
  const a = makePacket({ value: 0.5, scope: "animal_health:sleep" });
  const b = makePacket({ value: -0.5, scope: "animal_safety:handling" });
  const { contradicts } = packetsContradict(a, b);
  assert.ok(!contradicts, "different scopes should never contradict");
}

function test_revoked_and_approved_no_contradiction() {
  const a = makePacket({ value: 0.5, scope: "animal_health:sleep", status: "approved" });
  const b = makePacket({ value: -0.5, scope: "animal_health:sleep", status: "revoked" });
  const { contradicts } = packetsContradict(a, b);
  assert.ok(!contradicts, "revoked packet is a sanctioned update, not a contradiction");
}

function test_draft_and_approved_no_contradiction() {
  const a = makePacket({ value: 0.5, scope: "animal_health:sleep", status: "approved" });
  const b = makePacket({ value: -0.5, scope: "animal_health:sleep", status: "draft" });
  const { contradicts } = packetsContradict(a, b);
  assert.ok(!contradicts, "draft packet is not in scope for contradiction detection");
}

// ── scanContradictions ────────────────────────────────────────────────────────

function test_scan_finds_contradiction_in_same_scope() {
  const packets = [
    makePacket({ value: 0.8, scope: "animal_health:sleep", status: "approved" }),
    makePacket({ value: -0.8, scope: "animal_health:sleep", status: "approved" }),
    makePacket({ value: 0.3, scope: "ecosystem_stability:water", status: "approved" }),
  ];
  const findings = scanContradictions(null, { packets });
  assert.strictEqual(findings.length, 1, "should find exactly one contradiction");
  assert.strictEqual(findings[0].scope, "animal_health:sleep");
  assert.ok(findings[0].reason.includes("measurement.value"), "reason should name the field");
}

function test_scan_ignores_revoked_packet() {
  const packets = [
    makePacket({ value: 0.8, scope: "animal_health:sleep", status: "approved" }),
    makePacket({ value: -0.8, scope: "animal_health:sleep", status: "revoked" }),
  ];
  const findings = scanContradictions(null, { packets });
  assert.strictEqual(findings.length, 0, "revoked packet should be excluded by status filter");
}

function test_scan_empty_returns_no_contradictions() {
  const findings = scanContradictions(null, { packets: [] });
  assert.strictEqual(findings.length, 0);
}

function test_scan_wording_contradiction_detected() {
  const packets = [
    makePacket({ scope: "animal_health:exercise",
      wording: "Animals benefit from regular exercise", status: "approved" }),
    makePacket({ scope: "animal_health:exercise",
      wording: "Animals do not benefit from regular exercise", status: "approved" }),
  ];
  const findings = scanContradictions(null, { packets });
  assert.strictEqual(findings.length, 1, "wording contradiction detected");
  assert.ok(findings[0].reason.includes("safe_wording"));
}

// ── Runner ────────────────────────────────────────────────────────────────────

const tests = [
  test_numeric_sign_disagree_contradicts,
  test_numeric_same_sign_no_contradiction,
  test_zero_values_no_contradiction,
  test_string_numeric_parsed,
  test_non_numeric_no_contradiction,
  test_negation_flip_contradicts,
  test_same_polarity_no_contradiction,
  test_unrelated_topics_no_contradiction,
  test_approved_same_scope_different_value_sign_contradicts,
  test_approved_different_scopes_no_contradiction,
  test_revoked_and_approved_no_contradiction,
  test_draft_and_approved_no_contradiction,
  test_scan_finds_contradiction_in_same_scope,
  test_scan_ignores_revoked_packet,
  test_scan_empty_returns_no_contradictions,
  test_scan_wording_contradiction_detected,
];

let passed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${t.name}: ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\ntest_contradiction_scanner: ${passed}/${tests.length} passed`);
