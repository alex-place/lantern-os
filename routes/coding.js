"use strict";

// Coding control-plane surface (#2185) — makes the accountable coding backend
// (propose → HOLD → verify → route → approve/apply) reachable over HTTP. Until
// now nothing called it; this is the seam a chat turn, autowork, or a UI approves
// against. Reads are open; anything that proposes or applies a change is
// operator-gated (it mutates a repo). The verifier verdict rides on every held
// proposal so a caller can show "checked, safe to apply" before approving.

const path = require("path");
const { isOperatorRequest } = require("../lib/request-auth");
const cb = require("../lib/coding-backend");

let _repoRoot;
try {
  _repoRoot = require("../lib/app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..");
}

module.exports = async function codingRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const p = url.pathname;
  if (!p.startsWith("/api/coding/")) return false;

  // ── read-only ────────────────────────────────────────────────────────────
  if (req.method === "GET" && p === "/api/coding/backends") {
    sendJson(res, { backends: cb.listBackends(), localEngine: cb.defaultLocalEngine("coding") });
    return true;
  }
  if (req.method === "GET" && p === "/api/coding/pending") {
    // held proposals awaiting approval, each with its verification summary
    const pending = cb.listCodingPending().map((r) => ({
      pendingId: r.id,
      description: r.description,
      backend: r.input && r.input.backend,
      files: (r.input && r.input.files || []).map((f) => f.path),
      verification: r.verification || null,
      requestedAt: r.requestedAt,
    }));
    sendJson(res, { pending });
    return true;
  }
  if (req.method === "GET" && p === "/api/coding/receipts") {
    const receipts = cb.readReceipts().slice(-20).reverse();
    sendJson(res, { receipts });
    return true;
  }

  // ── mutating → operator only ─────────────────────────────────────────────
  const mutating = ["/api/coding/route", "/api/coding/approve", "/api/coding/reject"];
  if (req.method === "POST" && mutating.includes(p)) {
    if (!isOperatorRequest(req)) {
      sendJson(res, { error: "operator auth required" }, 403);
      return true;
    }
    let body;
    try {
      body = JSON.parse((await collectRequestBody(req)) || "{}");
    } catch {
      sendJson(res, { error: "invalid JSON body" }, 400);
      return true;
    }
    try {
      if (p === "/api/coding/route") {
        const task = String(body.task || "").trim();
        if (!task) return sendJson(res, { error: "task is required" }, 400) || true;
        const r = await cb.routeCodingTask({
          task,
          repoPath: body.repoPath || _repoRoot,
          candidates: Array.isArray(body.candidates) ? body.candidates : undefined,
          defaultBackend: body.defaultBackend || "mock",
          why: body.why || "chat/api",
        });
        sendJson(res, r, r.ok ? 200 : 400);
        return true;
      }
      if (p === "/api/coding/approve") {
        if (!body.pendingId) return sendJson(res, { error: "pendingId is required" }, 400) || true;
        const r = await cb.approveCodingPatch(body.pendingId, { overrideVerification: !!body.overrideVerification });
        sendJson(res, r, r.ok ? 200 : 409);
        return true;
      }
      if (p === "/api/coding/reject") {
        if (!body.pendingId) return sendJson(res, { error: "pendingId is required" }, 400) || true;
        const r = await cb.rejectCodingPatch(body.pendingId);
        sendJson(res, r, r.ok ? 200 : 409);
        return true;
      }
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
      return true;
    }
  }

  return false;
};
