"use strict";
/**
 * Time-aware contradiction detection over approved claim packets (#939 / #919.4).
 *
 * Flags ONLY when two APPROVED claim packets with the SAME scope
 * (`category:subcategory`) numerically disagree — their measurement confidence
 * intervals are disjoint (no overlap), i.e. they cannot both be true within their
 * stated uncertainty. Confidence intervals are the principled disagreement signal the
 * packet schema already carries; fuzzy NLI is intentionally out of scope.
 *
 * Time-aware / sanctioned updates: a sanctioned update revokes the superseded packet
 * (`revokePacket`), so a revoked packet is NOT "approved" and never appears here —
 * only two *concurrently approved* disagreeing packets are a contradiction. We report
 * the newer packet (by `created_at`) as `current` so the operator can revoke the stale
 * one to resolve it.
 */
const { listPackets } = require("./consent-gate");

function _ci(packet) {
  const ci = packet && packet.measurement && packet.measurement.confidence_interval;
  if (Array.isArray(ci) && ci.length === 2 &&
      typeof ci[0] === "number" && typeof ci[1] === "number") {
    return [Math.min(ci[0], ci[1]), Math.max(ci[0], ci[1])];
  }
  return null;
}

function _disjoint(a, b) {
  return a[1] < b[0] || b[1] < a[0];
}

/**
 * Pure: given approved packets, return contradiction pairs. No I/O.
 * @param packets array of approved claim packets
 * @returns [{ scope, packet_a, packet_b, a_ci, b_ci, current, reason }]
 */
function findContradictions(packets) {
  const byScope = new Map();
  for (const p of packets || []) {
    const scope = p && p.claim && p.claim.scope;
    if (!scope) continue;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(p);
  }

  const out = [];
  for (const [scope, group] of byScope) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const ca = _ci(a), cb = _ci(b);
        if (!ca || !cb) continue;                 // can't numerically compare — skip
        if (!_disjoint(ca, cb)) continue;          // intervals overlap → not a contradiction
        const ta = Date.parse(a.created_at) || 0;
        const tb = Date.parse(b.created_at) || 0;
        const current = tb >= ta ? b : a;          // newer approved packet is "current"
        out.push({
          scope,
          packet_a: a.packet_id,
          packet_b: b.packet_id,
          a_ci: ca, b_ci: cb,
          current: current.packet_id,
          reason: "approved same-scope claims have disjoint confidence intervals",
        });
      }
    }
  }
  return out;
}

/** Detect contradictions among the APPROVED packets under repoRoot. */
function detectContradictions(repoRoot) {
  const approved = listPackets(repoRoot, "approved");
  return findContradictions(approved);
}

module.exports = { detectContradictions, findContradictions };
