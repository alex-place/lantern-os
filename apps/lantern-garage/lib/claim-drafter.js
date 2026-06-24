/**
 * Issue #919 finding #2 — auto-draft claim packets from grounded answers.
 *
 * When stream-chat has grounding context AND a completed reply, call
 * draftClaimFromGrounding() to create a "pending" claim packet.
 * Drafts are NEVER auto-approved or signed — they sit in data/claims/
 * awaiting human review via /api/claims. This enforces the EXTERNAL REALITY
 * RULE (every factual claim must have [claim, evidence, confidence, source])
 * without bypassing the consent gate.
 *
 * The draft schema is a valid lantern.claim_packet.v1 object but with:
 *   review.consent_gate_status = "pending"   (cannot be exported)
 *   origin.operator_approved   = false        (blocks canExportClaim)
 *   signature.signature        = ""           (unsigned until approved)
 *
 * This module is fire-and-forget (never throws to callers).
 */
"use strict";

const crypto = require("crypto");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../../../");

// Lazy load savePacket to avoid circular requires at module load time.
let _savePacket;
function _gate() {
  if (!_savePacket) ({ savePacket: _savePacket } = require("./consent-gate"));
  return _savePacket;
}

// Read software version once (best-effort; falls back to "0.0.0").
let _version;
function _softwareVersion() {
  if (_version) return _version;
  try {
    _version = require("../package.json").version || "0.0.0";
  } catch {
    _version = "0.0.0";
  }
  return _version;
}

// Node id — stable per machine, derived from hostname.
function _nodeId() {
  try {
    return `node:${require("os").hostname().replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  } catch {
    return "node:local";
  }
}

/**
 * Extract a one-sentence factual claim title from the reply (first sentence
 * that contains a grounding source citation pattern, or first non-empty sentence).
 */
function _extractTitle(reply) {
  const sentences = reply.split(/[.!?]/);
  for (const s of sentences) {
    const t = s.trim();
    if (t.length >= 10 && t.length <= 180) return t;
  }
  return reply.slice(0, 120).trim() || "Grounded answer";
}

/**
 * Derive a scope string from the user message (<category>:<topic> format).
 * Scopes must match /^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*$/.
 */
function _deriveScope(message) {
  const raw = message.toLowerCase().replace(/[^a-z0-9 _-]/g, " ").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  const cat = words[0] || "chat";
  const topic = words[1] || "general";
  return `${cat.slice(0, 30)}:${topic.slice(0, 30)}`;
}

/**
 * Auto-draft a claim packet from a grounded chat reply.
 *
 * @param {object} opts
 * @param {string} opts.reply         — the completed LLM reply
 * @param {string} opts.message       — the user's message (used for scope)
 * @param {string} opts.groundingCtx  — grounding context text (the evidence)
 * @param {number} [opts.confidence]  — 0..1 confidence estimate (default 0.7)
 * @param {string} [opts.agentId]     — agent id string (default "keystone")
 */
async function draftClaimFromGrounding({
  reply, message, groundingCtx, confidence = 0.7, agentId = "keystone",
}) {
  const savePacket = _gate();
  const packetId = `claim:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const scope = _deriveScope(message || "");

  const packet = {
    schema: "lantern.claim_packet.v1",
    packet_id: packetId,
    created_at: now,
    origin: {
      node_id: _nodeId(),
      software: "lantern-os",
      software_version: _softwareVersion(),
      operator_approved: false,          // must be set true by human review
    },
    claim: {
      title: _extractTitle(reply),
      kind: "factual",
      safe_wording: reply.slice(0, 400),
      scope,
      context: `agent:${agentId}`,
    },
    evidence: {
      sources: groundingCtx ? [{ type: "grounding_context", excerpt: groundingCtx.slice(0, 600) }] : [],
      confidence: Math.min(1, Math.max(0, confidence)),
      grounded_at: now,
    },
    privacy: {
      raw_private_data_included: false,
      allowed_use: "local_only",
      retention: "session",
    },
    risk: {
      risk_class: "low",
      notes: "auto-drafted by grounding emitter; pending human review",
    },
    review: {
      consent_gate_status: "pending",
      reviewer: "",
      reviewed_at: null,
      challenge_path: false,
      rollback_path: false,
    },
    signature: {
      algorithm: "ed25519",
      public_key: "",
      signature: "",              // filled in by approvePacket()
    },
  };

  await savePacket(repoRoot, packet);
}

/**
 * Fire-and-forget wrapper for draftClaimFromGrounding.
 * Never throws; logs errors to console.warn (never breaks the reply).
 */
function emitClaimDraft(opts) {
  draftClaimFromGrounding(opts).catch((err) => {
    console.warn("[claim-drafter] draft failed:", err.message);
  });
}

module.exports = { emitClaimDraft };
