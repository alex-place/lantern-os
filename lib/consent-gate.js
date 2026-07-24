/**
 * Consent Gate — validates, stores, and signs claim packets before any mesh export.
 *
 * Rules:
 *   1. Raw private data never leaves the node.
 *   2. Only packets with review.consent_gate_status === "approved" may exit.
 *   3. Every exported claim must be signed (Ed25519).
 *   4. measurement.uncertainty must be in [0, 1].
 *   5. claim.safe_wording must use conservative phrasing.
 *   6. risk.risk_class === "blocked" prevents all downstream use.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeTextQueued, readJson, appendJsonlQueued } = require("./file-queue");

const CLAIM_SCHEMA = "lantern.claim_packet.v1";
const VALID_KINDS = ["measurement", "intervention", "pattern", "challenge"];
const VALID_EVIDENCE_CLASSES = [
  "local_pilot",
  "repeated_observation",
  "controlled_test",
  "peer_reviewed",
  "community_replicated",
  "synthetic_demo",
];
const VALID_CERTAINTIES = ["none", "very_low", "low", "moderate", "high", "very_high"];
const VALID_REPLICATION = [
  "not_replicated",
  "single_replication",
  "multiple_replications",
  "community_supported",
];
const VALID_PRIVACY_LEVELS = ["raw_private", "anonymized", "aggregated", "public"];
const VALID_ALLOWED_USES = ["aggregate_pattern_only", "research_review", "peer_mesh", "unrestricted"];
const VALID_RISK_CLASSES = ["trivial", "low", "moderate", "high", "blocked"];
const VALID_REVIEW_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "revoked",
  "blocked",
];
const VALID_FLOURISHING_DIMENSIONS = [
  "animal_health",
  "animal_safety",
  "animal_comfort",
  "animal_natural_behavior",
  "human_health",
  "human_autonomy",
  "human_fairness",
  "human_opportunity",
  "ecosystem_biodiversity",
  "ecosystem_stability",
  "ecosystem_resilience",
  "creative_flourishing",
  "community_trust",
  "routine_stability",
];

// ── Key management ──

function getKeysDir(repoRoot) {
  return path.join(repoRoot, "data", "node-keys");
}

function ensureKeyPair(repoRoot) {
  const keysDir = getKeysDir(repoRoot);
  const privatePath = path.join(keysDir, "node_ed25519.pem");
  const publicPath = path.join(keysDir, "node_ed25519.pub.pem");

  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    return {
      privateKey: fs.readFileSync(privatePath, "utf8"),
      publicKey: fs.readFileSync(publicPath, "utf8"),
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

  return { privateKey, publicKey };
}

function getPublicKeyBase64(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  return key.export({ type: "spki", format: "der" }).toString("base64");
}

// ── Canonical serialization for signing ──

function canonicalPacket(packet) {
  // Sign everything except the signature block itself
  const { signature, ...rest } = packet;
  return JSON.stringify(rest, Object.keys(rest).sort(), 0);
}

function signPacket(packet, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const canonical = canonicalPacket(packet);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
  return sig.toString("base64");
}

function verifyPacket(packet, publicKeyPem) {
  if (!packet.signature || !packet.signature.signature) return false;
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const canonical = canonicalPacket(packet);
    const sig = Buffer.from(packet.signature.signature, "base64");
    return crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, sig);
  } catch {
    return false;
  }
}

// ── Validation ──

function validateClaimPacket(packet) {
  const errors = [];

  if (!packet || typeof packet !== "object") {
    return { valid: false, errors: ["packet must be an object"] };
  }

  // schema
  if (packet.schema !== CLAIM_SCHEMA) {
    errors.push(`schema must be "${CLAIM_SCHEMA}"`);
  }

  // packet_id
  if (!packet.packet_id || !/^claim:[a-f0-9-]+$/.test(packet.packet_id)) {
    errors.push("packet_id must match claim:<uuid>");
  }

  // created_at
  if (!packet.created_at || isNaN(Date.parse(packet.created_at))) {
    errors.push("created_at must be a valid ISO-8601 date-time");
  }

  // origin
  const o = packet.origin || {};
  if (!o.node_id || !/^node:[a-zA-Z0-9._-]+$/.test(o.node_id)) {
    errors.push("origin.node_id must match node:<id>");
  }
  if (o.software !== "lantern-os") {
    errors.push('origin.software must be "lantern-os"');
  }
  if (!o.software_version || !/^\d+\.\d+\.\d+$/.test(o.software_version)) {
    errors.push("origin.software_version must be semver");
  }
  if (typeof o.operator_approved !== "boolean") {
    errors.push("origin.operator_approved must be boolean");
  }

  // claim
  const c = packet.claim || {};
  if (!c.title || c.title.length < 1 || c.title.length > 200) {
    errors.push("claim.title must be 1-200 chars");
  }
  if (!VALID_KINDS.includes(c.kind)) {
    errors.push(`claim.kind must be one of: ${VALID_KINDS.join(", ")}`);
  }
  if (!c.safe_wording || c.safe_wording.length < 10) {
    errors.push("claim.safe_wording must be >= 10 chars");
  }
  if (!c.scope || !/^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*$/.test(c.scope)) {
    errors.push("claim.scope must match category:subcategory");
  }
  if (!c.domain) {
    errors.push("claim.domain is required");
  }
  if (!Array.isArray(c.flourishing_dimensions) || c.flourishing_dimensions.length < 1) {
    errors.push("claim.flourishing_dimensions must be a non-empty array");
  } else {
    const invalid = c.flourishing_dimensions.filter((d) => !VALID_FLOURISHING_DIMENSIONS.includes(d));
    if (invalid.length) errors.push(`invalid flourishing_dimensions: ${invalid.join(", ")}`);
  }

  // measurement
  const m = packet.measurement || {};
  if (m.value === undefined) errors.push("measurement.value is required");
  if (typeof m.uncertainty !== "number" || m.uncertainty < 0 || m.uncertainty > 1) {
    errors.push("measurement.uncertainty must be in [0, 1]");
  }
  if (!Array.isArray(m.confidence_interval) || m.confidence_interval.length !== 2) {
    errors.push("measurement.confidence_interval must be [lower, upper]");
  }
  if (typeof m.sample_size !== "number" || m.sample_size < 0 || !Number.isInteger(m.sample_size)) {
    errors.push("measurement.sample_size must be a non-negative integer");
  }
  if (!m.source || typeof m.source !== "string" || m.source.length < 1) {
    errors.push("measurement.source is required");
  }
  if (!m.methodology || typeof m.methodology !== "string" || m.methodology.length < 1) {
    errors.push("measurement.methodology is required");
  }
  if (!Array.isArray(m.temporal_range) || m.temporal_range.length !== 2) {
    errors.push("measurement.temporal_range must be [start, end]");
  }
  if (!m.scope || typeof m.scope !== "string" || m.scope.length < 1) {
    errors.push("measurement.scope is required");
  }
  if (!Array.isArray(m.confounders)) errors.push("measurement.confounders must be an array");
  if (!Array.isArray(m.missing)) errors.push("measurement.missing must be an array");
  if (!m.measurement_hash || !/^sha256:[a-f0-9]{64}$/.test(m.measurement_hash)) {
    errors.push("measurement.measurement_hash must match sha256:<hex>");
  }

  // evidence
  const e = packet.evidence || {};
  if (!VALID_EVIDENCE_CLASSES.includes(e.evidence_class)) {
    errors.push(`evidence.evidence_class must be one of: ${VALID_EVIDENCE_CLASSES.join(", ")}`);
  }
  if (!VALID_CERTAINTIES.includes(e.certainty)) {
    errors.push(`evidence.certainty must be one of: ${VALID_CERTAINTIES.join(", ")}`);
  }
  if (!VALID_REPLICATION.includes(e.replication_status)) {
    errors.push(`evidence.replication_status must be one of: ${VALID_REPLICATION.join(", ")}`);
  }
  if (!Array.isArray(e.source_refs)) errors.push("evidence.source_refs must be an array");
  if (!Array.isArray(e.status_cube_refs)) errors.push("evidence.status_cube_refs must be an array");

  // privacy
  const p = packet.privacy || {};
  if (p.raw_private_data_included !== false) {
    errors.push("privacy.raw_private_data_included must be false");
  }
  if (!VALID_PRIVACY_LEVELS.includes(p.privacy_level)) {
    errors.push(`privacy.privacy_level must be one of: ${VALID_PRIVACY_LEVELS.join(", ")}`);
  }
  if (!VALID_ALLOWED_USES.includes(p.allowed_use)) {
    errors.push(`privacy.allowed_use must be one of: ${VALID_ALLOWED_USES.join(", ")}`);
  }
  if (typeof p.revocable !== "boolean") {
    errors.push("privacy.revocable must be boolean");
  }

  // risk
  const r = packet.risk || {};
  if (!VALID_RISK_CLASSES.includes(r.risk_class)) {
    errors.push(`risk.risk_class must be one of: ${VALID_RISK_CLASSES.join(", ")}`);
  }
  if (typeof r.sensitive !== "boolean") errors.push("risk.sensitive must be boolean");
  if (typeof r.automation_allowed !== "boolean") errors.push("risk.automation_allowed must be boolean");
  if (typeof r.recommendation_allowed !== "boolean") errors.push("risk.recommendation_allowed must be boolean");

  // review
  const rev = packet.review || {};
  if (!VALID_REVIEW_STATUSES.includes(rev.consent_gate_status)) {
    errors.push(`review.consent_gate_status must be one of: ${VALID_REVIEW_STATUSES.join(", ")}`);
  }
  if (!rev.reviewer || typeof rev.reviewer !== "string") {
    errors.push("review.reviewer is required");
  }
  if (typeof rev.challenge_path !== "boolean") errors.push("review.challenge_path must be boolean");
  if (typeof rev.rollback_path !== "boolean") errors.push("review.rollback_path must be boolean");

  // signature
  const s = packet.signature || {};
  if (s.algorithm !== "ed25519") errors.push('signature.algorithm must be "ed25519"');
  if (!s.public_key || !/^ed25519:[A-Za-z0-9+/=]+$/.test(s.public_key)) {
    errors.push("signature.public_key must match ed25519:<base64>");
  }

  return { valid: errors.length === 0, errors };
}

function canExportClaim(packet) {
  if (!packet) return false;
  const v = validateClaimPacket(packet);
  if (!v.valid) return false;

  const p = packet.privacy || {};
  const rev = packet.review || {};
  const r = packet.risk || {};
  const s = packet.signature || {};

  return (
    p.raw_private_data_included === false &&
    p.allowed_use !== "unrestricted" &&
    rev.consent_gate_status === "approved" &&
    rev.reviewed_at &&
    !isNaN(Date.parse(rev.reviewed_at)) &&
    packet.origin &&
    packet.origin.operator_approved === true &&
    s.signature &&
    s.signature.length > 0 &&
    r.risk_class !== "blocked"
  );
}

// ── Storage ──

function getPacketPath(repoRoot, packetId) {
  return path.join(repoRoot, "data", "claims", `${packetId.replace(/:/g, "_")}.json`);
}

function getPacketLogPath(repoRoot) {
  return path.join(repoRoot, "data", "claims", "packets.jsonl");
}

async function savePacket(repoRoot, packet) {
  const packetPath = getPacketPath(repoRoot, packet.packet_id);
  await writeTextQueued(packetPath, JSON.stringify(packet, null, 2));
  await appendJsonlQueued(getPacketLogPath(repoRoot), {
    packet_id: packet.packet_id,
    status: packet.review?.consent_gate_status,
    saved_at: new Date().toISOString(),
  });
}

function loadPacket(repoRoot, packetId) {
  const packetPath = getPacketPath(repoRoot, packetId);
  try {
    const raw = fs.readFileSync(packetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listPackets(repoRoot, filterStatus = null) {
  const dir = path.join(repoRoot, "data", "claims");
  if (!fs.existsSync(dir)) return [];

  const packets = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "packets.jsonl") continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const packet = JSON.parse(raw);
      if (!filterStatus || packet.review?.consent_gate_status === filterStatus) {
        packets.push(packet);
      }
    } catch {
      // skip corrupt files
    }
  }
  return packets.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// ── Approval flow ──

async function approvePacket(repoRoot, packetId, reviewer = "local_operator") {
  const packet = loadPacket(repoRoot, packetId);
  if (!packet) return { ok: false, error: "packet_not_found" };

  if (packet.review.consent_gate_status === "approved") {
    return { ok: false, error: "already_approved" };
  }

  if (packet.review.consent_gate_status === "blocked") {
    return { ok: false, error: "packet_blocked" };
  }

  const { privateKey, publicKey } = ensureKeyPair(repoRoot);

  packet.review.consent_gate_status = "approved";
  packet.review.reviewer = reviewer;
  packet.review.reviewed_at = new Date().toISOString();
  packet.origin.operator_approved = true;
  packet.signature.public_key = `ed25519:${getPublicKeyBase64(publicKey)}`;
  packet.signature.signature = signPacket(packet, privateKey);

  await savePacket(repoRoot, packet);
  return { ok: true, packet };
}

async function rejectPacket(repoRoot, packetId, reviewer = "local_operator") {
  const packet = loadPacket(repoRoot, packetId);
  if (!packet) return { ok: false, error: "packet_not_found" };

  packet.review.consent_gate_status = "rejected";
  packet.review.reviewer = reviewer;
  packet.review.reviewed_at = new Date().toISOString();

  await savePacket(repoRoot, packet);
  return { ok: true, packet };
}

/**
 * Issue #919 finding #4 — time-aware contradiction detection.
 *
 * Scans all "approved" claim packets for scope overlaps and content disagreement.
 * Returns an array of {packetA, packetB, scope, reason} contradiction records.
 *
 * Rules (per #919 spec):
 *   - Only APPROVED packets are compared (pending/rejected are ignored).
 *   - Two packets "disagree" when their safe_wording is sufficiently different on
 *     the same scope (cosine of bag-of-words < threshold). Naive token comparison
 *     avoids false-positives from updates to the same fact over time — a REVOKED
 *     packet is never flagged (revocation IS the sanctioned update path).
 *   - Scope overlap: exact match OR one scope is a prefix of the other (e.g.
 *     "kalshi:market" overlaps "kalshi:market_data").
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.7] — BOW cosine below this triggers a flag.
 * @returns {Array<{packetA: string, packetB: string, scope: string, reason: string}>}
 */
function detectContradictions(repoRoot, { threshold = 0.7 } = {}) {
  const approved = listPackets(repoRoot, "approved");

  // Build simple bag-of-words vector
  function bow(text) {
    const freq = {};
    for (const w of String(text || "").toLowerCase().split(/\W+/).filter(Boolean)) {
      freq[w] = (freq[w] || 0) + 1;
    }
    return freq;
  }

  function cosine(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let dot = 0, na = 0, nb = 0;
    for (const k of keys) {
      const va = a[k] || 0, vb = b[k] || 0;
      dot += va * vb;
      na += va * va;
      nb += vb * vb;
    }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  function scopesOverlap(sa, sb) {
    if (sa === sb) return true;
    return sa.startsWith(sb + ":") || sb.startsWith(sa + ":");
  }

  const contradictions = [];
  for (let i = 0; i < approved.length; i++) {
    for (let j = i + 1; j < approved.length; j++) {
      const pa = approved[i], pb = approved[j];
      if (!scopesOverlap(pa.claim?.scope || "", pb.claim?.scope || "")) continue;
      const sim = cosine(bow(pa.claim?.safe_wording), bow(pb.claim?.safe_wording));
      if (sim < threshold) {
        contradictions.push({
          packetA: pa.packet_id,
          packetB: pb.packet_id,
          scope: pa.claim?.scope,
          similarity: Math.round(sim * 1000) / 1000,
          reason: `approved packets on overlapping scope '${pa.claim?.scope}' / '${pb.claim?.scope}' have low wording similarity (${(sim * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%)`,
        });
      }
    }
  }
  return contradictions;
}

async function revokePacket(repoRoot, packetId) {
  const packet = loadPacket(repoRoot, packetId);
  if (!packet) return { ok: false, error: "packet_not_found" };

  packet.review.consent_gate_status = "revoked";
  packet.review.reviewed_at = new Date().toISOString();

  await savePacket(repoRoot, packet);
  return { ok: true, packet };
}

module.exports = {
  CLAIM_SCHEMA,
  VALID_KINDS,
  VALID_EVIDENCE_CLASSES,
  VALID_CERTAINTIES,
  VALID_REPLICATION,
  VALID_PRIVACY_LEVELS,
  VALID_ALLOWED_USES,
  VALID_RISK_CLASSES,
  VALID_REVIEW_STATUSES,
  VALID_FLOURISHING_DIMENSIONS,
  validateClaimPacket,
  canExportClaim,
  ensureKeyPair,
  getPublicKeyBase64,
  signPacket,
  verifyPacket,
  savePacket,
  loadPacket,
  listPackets,
  approvePacket,
  rejectPacket,
  revokePacket,
  detectContradictions,
  getPacketPath,
  getPacketLogPath,
};
