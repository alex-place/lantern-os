// Claim Packet API — draft, review, approve, and sign claim packets.
// All mesh export flows through this gate.

const crypto = require("crypto");

module.exports = async function claimsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  const {
    validateClaimPacket,
    canExportClaim,
    ensureKeyPair,
    getPublicKeyBase64,
    signPacket,
    savePacket,
    loadPacket,
    listPackets,
    approvePacket,
    rejectPacket,
    revokePacket,
    detectContradictions,
  } = require("../lib/consent-gate");

  // ── GET /api/claims — list packets ───────────────────────────────────
  if (url.pathname === "/api/claims" && req.method === "GET") {
    const status = url.searchParams.get("status");
    const packets = listPackets(repoRoot, status || null);
    sendJson(res, {
      schema: "lantern.claim_packet.v1",
      count: packets.length,
      packets: packets.map((p) => ({
        packet_id: p.packet_id,
        created_at: p.created_at,
        title: p.claim?.title,
        kind: p.claim?.kind,
        scope: p.claim?.scope,
        status: p.review?.consent_gate_status,
        reviewer: p.review?.reviewer,
        reviewed_at: p.review?.reviewed_at,
        signed: !!(p.signature?.signature),
        exportable: canExportClaim(p),
        // Evidence tuple surfaced for the Grounding Diff viewer (#1420) so the
        // [claim · evidence · source · confidence] grid renders in one call instead
        // of an N+1 fetch per packet. Additive — existing consumers ignore these.
        safe_wording: p.claim?.safe_wording || "",
        confidence: typeof p.evidence?.confidence === "number" ? p.evidence.confidence : null,
        grounded_at: p.evidence?.grounded_at || null,
        sources: Array.isArray(p.evidence?.sources)
          ? p.evidence.sources.map((s) => ({ type: s.type || "unknown", excerpt: String(s.excerpt || "").slice(0, 400) }))
          : [],
      })),
    });
    return true;
  }

  // ── GET /api/claims/export-ready — list packets ready for mesh export ─
  if (url.pathname === "/api/claims/export-ready" && req.method === "GET") {
    const all = listPackets(repoRoot);
    const ready = all.filter((p) => canExportClaim(p));
    sendJson(res, {
      count: ready.length,
      packets: ready.map((p) => ({
        packet_id: p.packet_id,
        title: p.claim?.title,
        scope: p.claim?.scope,
        signed_at: p.review?.reviewed_at,
      })),
    });
    return true;
  }

  // ── GET /api/claims/node-public-key — node's signing key ──────────────
  if (url.pathname === "/api/claims/node-public-key" && req.method === "GET") {
    try {
      const { publicKey } = ensureKeyPair(repoRoot);
      sendJson(res, {
        algorithm: "ed25519",
        public_key: `ed25519:${getPublicKeyBase64(publicKey)}`,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // ── GET /api/claims/contradictions — #919 finding #4 ─────────────────
  if (url.pathname === "/api/claims/contradictions" && req.method === "GET") {
    const threshold = parseFloat(url.searchParams.get("threshold") || "0.7");
    const results = detectContradictions(repoRoot, { threshold });
    sendJson(res, { count: results.length, threshold, contradictions: results });
    return true;
  }

  // ── GET /api/claims/:id — get single packet ──────────────────────────
  if (url.pathname.startsWith("/api/claims/") && req.method === "GET") {
    const id = url.pathname.slice("/api/claims/".length);
    const packet = loadPacket(repoRoot, id);
    if (!packet) {
      sendJson(res, { error: "packet_not_found" }, 404);
      return true;
    }
    sendJson(res, {
      packet,
      exportable: canExportClaim(packet),
    });
    return true;
  }

  // ── POST /api/claims/draft — create or update draft ──────────────────
  if (url.pathname === "/api/claims/draft" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);

      if (!body.packet_id) {
        sendJson(res, { error: "packet_id is required" }, 400);
        return true;
      }

      const existing = loadPacket(repoRoot, body.packet_id);

      // If packet exists and is already approved, block mutation
      if (existing && existing.review?.consent_gate_status === "approved") {
        sendJson(res, { error: "approved_packets_are_immutable" }, 409);
        return true;
      }

      // Merge with existing or create new
      const packet = existing
        ? {
            ...existing,
            ...body,
            origin: { ...existing.origin, ...body.origin },
            claim: { ...existing.claim, ...body.claim },
            measurement: { ...existing.measurement, ...body.measurement },
            evidence: { ...existing.evidence, ...body.evidence },
            privacy: { ...existing.privacy, ...body.privacy },
            risk: { ...existing.risk, ...body.risk },
            review: { ...existing.review, ...body.review },
            signature: { ...existing.signature, ...body.signature },
          }
        : body;

      // Enforce draft status on creation
      if (!existing) {
        packet.review = packet.review || {};
        packet.review.consent_gate_status = "draft";
        packet.review.reviewer = "local_operator";
        packet.review.challenge_path = true;
        packet.review.rollback_path = true;
      }

      // Ensure schema version on new packets only
      if (!existing) {
        packet.schema = packet.schema || "lantern.claim_packet.v1";
      }

      // Auto-generate measurement hash if missing
      if (packet.measurement && !packet.measurement.measurement_hash) {
        const canonical = JSON.stringify(packet.measurement.value) +
          packet.measurement.source +
          packet.measurement.methodology +
          packet.measurement.temporal_range?.join(":") +
          packet.measurement.scope;
        packet.measurement.measurement_hash = "sha256:" +
          crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
      }

      const validation = validateClaimPacket(packet);
      if (!validation.valid) {
        sendJson(res, { error: "validation_failed", details: validation.errors }, 400);
        return true;
      }

      await savePacket(repoRoot, packet);
      sendJson(res, { saved: true, packet_id: packet.packet_id, status: packet.review.consent_gate_status });
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // ── POST /api/claims/:id/approve — operator approves for export ─────
  if (url.pathname.match(/^\/api\/claims\/[^/]+\/approve$/) && req.method === "POST") {
    try {
      const id = url.pathname.match(/^\/api\/claims\/([^/]+)\/approve$/)[1];
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const reviewer = body.reviewer || "local_operator";

      const result = await approvePacket(repoRoot, id, reviewer);
      if (!result.ok) {
        sendJson(res, { error: result.error }, 400);
        return true;
      }

      sendJson(res, {
        approved: true,
        packet_id: result.packet.packet_id,
        status: result.packet.review.consent_gate_status,
        signed: true,
        exportable: canExportClaim(result.packet),
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // ── POST /api/claims/:id/reject — operator rejects ──────────────────
  if (url.pathname.match(/^\/api\/claims\/[^/]+\/reject$/) && req.method === "POST") {
    try {
      const id = url.pathname.match(/^\/api\/claims\/([^/]+)\/reject$/)[1];
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw || "{}");
      const reviewer = body.reviewer || "local_operator";

      const result = await rejectPacket(repoRoot, id, reviewer);
      if (!result.ok) {
        sendJson(res, { error: result.error }, 400);
        return true;
      }

      sendJson(res, {
        rejected: true,
        packet_id: result.packet.packet_id,
        status: result.packet.review.consent_gate_status,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // ── POST /api/claims/:id/revoke — operator revokes previous approval ─
  if (url.pathname.match(/^\/api\/claims\/[^/]+\/revoke$/) && req.method === "POST") {
    try {
      const id = url.pathname.match(/^\/api\/claims\/([^/]+)\/revoke$/)[1];
      const result = await revokePacket(repoRoot, id);
      if (!result.ok) {
        sendJson(res, { error: result.error }, 400);
        return true;
      }

      sendJson(res, {
        revoked: true,
        packet_id: result.packet.packet_id,
        status: result.packet.review.consent_gate_status,
      });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  return false;
};
