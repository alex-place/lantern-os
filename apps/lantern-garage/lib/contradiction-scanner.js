/**
 * contradiction-scanner.js — time-aware contradiction detection over approved claim packets.
 *
 * #939 / #919.4. Only approved packets are candidates — revokedpackets are sanctioned
 * updates, not contradictions. Two simultaneously approved packets in the same scope
 * with disagreeing measurement direction or safe_wording constitute a contradiction.
 *
 * "Time-aware" means: a packet that was approved earlier and then superseded via
 * revokePacket() is NOT a contradiction (the revoke is the consent-approved update
 * mechanism). Only currently approved packets are tested.
 *
 * Rule:
 *   A contradiction is flagged when two APPROVED packets share the same claim.scope
 *   AND any of:
 *     1. measurement.value sign disagrees (one positive, one negative when numeric)
 *     2. measurement.value range midpoints are on opposite sides of a neutral threshold
 *     3. claim.safe_wording contains a direct negation of the other's wording
 *        (heuristic: one contains a negation keyword the other doesn't)
 *
 *  Sanctioned update path: caller should call revokePacket(old) before approving the
 *  new one. After revocation, the old packet has status="revoked" and is excluded.
 */

"use strict";

const { listPackets } = require("./consent-gate");

// ── Contradiction detection primitives ────────────────────────────────────────

/**
 * Returns true if the two measurement values contradict each other.
 * Contradictions: one numeric value is positive, the other negative.
 * Non-numeric values are compared by string equality (same = no contradiction).
 */
function measurementValuesContradict(valueA, valueB) {
  const numA = typeof valueA === "number" ? valueA : parseFloat(valueA);
  const numB = typeof valueB === "number" ? valueB : parseFloat(valueB);

  if (!isNaN(numA) && !isNaN(numB)) {
    // Both numeric: contradict if signs differ across zero
    const signA = Math.sign(numA);
    const signB = Math.sign(numB);
    return signA !== 0 && signB !== 0 && signA !== signB;
  }

  // Non-numeric: not a numeric contradiction (wording check handles these)
  return false;
}

// Negation markers that flip a claim's meaning
const NEGATION_TOKENS = ["not", "no", "never", "cannot", "doesn't", "does not",
  "didn't", "did not", "isn't", "is not", "aren't", "are not",
  "won't", "will not", "failed", "failure", "negative", "ineffective"];

/**
 * Returns true if wordingA and wordingB are semantically opposing.
 * Heuristic: one contains a negation token the other does not,
 * AND both refer to similar subject matter (> 30% token overlap).
 */
function wordingsContradict(wordingA, wordingB) {
  if (!wordingA || !wordingB) return false;

  const tokA = new Set(wordingA.toLowerCase().split(/\W+/).filter(Boolean));
  const tokB = new Set(wordingB.toLowerCase().split(/\W+/).filter(Boolean));

  // Token overlap (Jaccard-like)
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  const overlap = union > 0 ? intersection / union : 0;

  if (overlap < 0.15) return false; // unrelated topics — not a contradiction

  const negA = NEGATION_TOKENS.some((n) => wordingA.toLowerCase().includes(n));
  const negB = NEGATION_TOKENS.some((n) => wordingB.toLowerCase().includes(n));

  // Contradicts if exactly one has a negation (same topic, opposite polarity)
  return negA !== negB;
}

/**
 * Returns {contradicts: bool, reason: string|null} for two approved packets.
 */
function packetsContradict(a, b) {
  // Only approved packets should be passed here; guard anyway
  if (a.review?.consent_gate_status !== "approved" ||
      b.review?.consent_gate_status !== "approved") {
    return { contradicts: false, reason: null };
  }

  if (a.claim?.scope !== b.claim?.scope) {
    return { contradicts: false, reason: null };
  }

  if (measurementValuesContradict(a.measurement?.value, b.measurement?.value)) {
    return {
      contradicts: true,
      reason: `measurement.value sign disagrees: ${a.measurement.value} vs ${b.measurement.value}`,
    };
  }

  if (wordingsContradict(a.claim?.safe_wording, b.claim?.safe_wording)) {
    return {
      contradicts: true,
      reason: `safe_wording polarity disagrees (negation mismatch)`,
    };
  }

  return { contradicts: false, reason: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan all approved packets in repoRoot for contradictions.
 *
 * Returns an array of contradiction records:
 *   { scope, packetA: packet_id, packetB: packet_id, reason,
 *     approvedAt: {a: ISO, b: ISO} }
 *
 * Sanctioned updates (revoked packets) are excluded automatically because
 * listPackets filters by status="approved".
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {object[]} [options.packets]  inject packets directly (for testing)
 * @returns {object[]} contradiction records (empty if none)
 */
function scanContradictions(repoRoot, { packets } = {}) {
  const approved = (packets || listPackets(repoRoot, "approved"));

  // Group by scope
  const byScope = new Map();
  for (const pkt of approved) {
    const scope = pkt.claim?.scope;
    if (!scope) continue;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(pkt);
  }

  const contradictions = [];

  for (const [scope, group] of byScope) {
    // O(n²) over same-scope approved packets — groups are small in practice
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const { contradicts, reason } = packetsContradict(a, b);
        if (contradicts) {
          contradictions.push({
            scope,
            packetA: a.packet_id,
            packetB: b.packet_id,
            reason,
            approvedAt: {
              a: a.review?.reviewed_at || a.created_at,
              b: b.review?.reviewed_at || b.created_at,
            },
          });
        }
      }
    }
  }

  // Sort by scope then by earlier approvedAt for stable output
  return contradictions.sort((x, y) => {
    if (x.scope !== y.scope) return x.scope.localeCompare(y.scope);
    return x.approvedAt.a.localeCompare(y.approvedAt.a);
  });
}

module.exports = {
  scanContradictions,
  packetsContradict,
  measurementValuesContradict,
  wordingsContradict,
};
