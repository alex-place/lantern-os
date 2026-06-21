// claim-draft.js — the answer → claim-packet bridge (Convergence #919, finding #2).
//
// The Σ₀ verify pass (dream-chat.verifyResponse) already grounds each extracted
// claim into a record of [claim, evidence, confidence, source(s)] and appends it
// to data/convergence/records.jsonl. But those records never entered the
// consent-gate claim-packet system (routes/claims.js + consent-gate.js), so the
// EXTERNAL REALITY RULE was never enforced end-to-end: nothing a grounded chat
// answer asserted could be reviewed, signed, or exported as evidence.
//
// This module maps one grounding record to a VALID `lantern.claim_packet.v1`
// packet in `draft` status and persists it through the same savePacket() the API
// uses. Drafts are inert: not approved, not signed, never exportable — the
// operator still reviews/approves via the existing consent gate. We only draft
// for genuinely externally-grounded, non-refuted, confident records so the gate
// queue stays signal, not noise.

const crypto = require("crypto");
const { validateClaimPacket, savePacket, ensureKeyPair, getPublicKeyBase64 } = require("./consent-gate");

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// confidence (0..1) → consent-gate certainty enum
function certaintyFor(confidence) {
  if (confidence >= 0.9) return "very_high";
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "moderate";
  if (confidence >= 0.4) return "low";
  if (confidence >= 0.2) return "very_low";
  return "none";
}

// A grounding record is worth a packet only when an EXTERNAL/codebase source
// actually corroborated it (not "none"), it wasn't refuted, and confidence
// clears the floor. Mirrors the verify pass's own "don't hedge ungrounded" rule.
function isPacketWorthy(record, { minConfidence = 0.7 } = {}) {
  if (!record || typeof record !== "object") return false;
  if (record.refuted) return false;
  if (!record.source || record.source === "none") return false;
  return (record.confidence ?? 0) >= minConfidence;
}

function packetIdFromRecord() {
  return `claim:${crypto.randomUUID()}`;
}

function nodeId() {
  // Must match /^node:[a-zA-Z0-9._-]+$/. Use a stable, non-identifying token.
  const host = (process.env.LANTERN_NODE_ID || require("os").hostname() || "local")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 48) || "local";
  return `node:${host}`;
}

function semver(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version || "")) ? version : "0.0.0";
}

// Build a valid draft claim packet from a single Σ₀ grounding record.
function buildDraftPacket(record, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const confidence = clamp01(record.confidence ?? 0.6);
  const sources = Array.isArray(record.sources) ? record.sources.filter(Boolean) : [];
  const sourceRefs = sources.length ? sources : (record.evidence ? [record.evidence] : []);
  const agent = String(ctx.agent || record.agent || "lantern").toLowerCase().replace(/[^a-z0-9_]/g, "_") || "lantern";
  const claimText = String(record.claim || "").trim() || "(empty claim)";
  const title = claimText.slice(0, 200);

  const measurement = {
    value: claimText,
    uncertainty: clamp01(1 - confidence),
    confidence_interval: [clamp01(confidence - 0.15), clamp01(confidence + 0.15)],
    sample_size: sources.length,
    source: String(record.source || "sigma0-verify"),
    methodology: "Σ₀ verify pass: claim extraction + multi-source grounding (codebase / web search / Gemini grounding)",
    temporal_range: [now, now],
    scope: "chat_session",
    confounders: [],
    missing: [],
  };
  // Replicate routes/claims.js draft-route hashing so the packet validates.
  const canonical =
    JSON.stringify(measurement.value) +
    measurement.source +
    measurement.methodology +
    measurement.temporal_range.join(":") +
    measurement.scope;
  measurement.measurement_hash = "sha256:" + crypto.createHash("sha256").update(canonical, "utf8").digest("hex");

  let publicKey = "ed25519:unset";
  if (ctx.repoRoot) {
    try {
      publicKey = `ed25519:${getPublicKeyBase64(ensureKeyPair(ctx.repoRoot).publicKey)}`;
    } catch { /* keep placeholder; signature is only required at approval time */ }
  }

  return {
    schema: "lantern.claim_packet.v1",
    packet_id: packetIdFromRecord(),
    created_at: now,
    origin: {
      node_id: nodeId(),
      software: "lantern-os",
      software_version: semver(ctx.softwareVersion),
      operator_approved: false,
    },
    claim: {
      title,
      kind: "pattern",
      safe_wording: `According to ${measurement.source}, ${claimText}`.slice(0, 1000),
      scope: `chat:${agent}`.slice(0, 64),
      domain: "conversational_grounding",
      flourishing_dimensions: ["community_trust"],
    },
    measurement,
    evidence: {
      evidence_class: sourceRefs.length >= 2 ? "repeated_observation" : "local_pilot",
      certainty: certaintyFor(confidence),
      replication_status: sourceRefs.length >= 2 ? "single_replication" : "not_replicated",
      source_refs: sourceRefs.slice(0, 16),
      status_cube_refs: [],
    },
    privacy: {
      raw_private_data_included: false,
      privacy_level: "public",
      allowed_use: "research_review",
      revocable: true,
    },
    risk: {
      risk_class: "low",
      sensitive: false,
      automation_allowed: false,
      recommendation_allowed: false,
    },
    review: {
      consent_gate_status: "draft",
      reviewer: "sigma0_verify",
      challenge_path: true,
      rollback_path: true,
    },
    signature: {
      algorithm: "ed25519",
      public_key: publicKey,
    },
  };
}

// Draft + persist claim packets for the packet-worthy records of a verify pass.
// Returns { drafted: [packet_id...], skipped: n }. Never throws — callers treat
// it as best-effort so a packet hiccup can't break a chat reply.
async function draftClaimsFromRecords(repoRoot, records, ctx = {}) {
  const out = { drafted: [], skipped: 0, errors: [] };
  if (!repoRoot || !Array.isArray(records)) return out;
  let softwareVersion = ctx.softwareVersion;
  if (!softwareVersion) {
    try { softwareVersion = require(require("path").join(repoRoot, "package.json")).version; } catch { /* default */ }
  }
  for (const record of records) {
    if (!isPacketWorthy(record, ctx)) { out.skipped++; continue; }
    try {
      const packet = buildDraftPacket(record, { ...ctx, repoRoot, softwareVersion });
      const v = validateClaimPacket(packet);
      if (!v.valid) { out.skipped++; out.errors.push(v.errors[0]); continue; }
      await savePacket(repoRoot, packet);
      out.drafted.push(packet.packet_id);
    } catch (e) {
      out.skipped++;
      out.errors.push(e.message);
    }
  }
  return out;
}

module.exports = {
  buildDraftPacket,
  draftClaimsFromRecords,
  isPacketWorthy,
  certaintyFor,
};
