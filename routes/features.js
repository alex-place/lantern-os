/**
 * features.js — Feature Runtime API routes
 *
 * GET  /api/features/state   — PCSF-evaluated active feature set (JSON)
 * GET  /api/features/stream  — SSE stream: re-evaluates every 10s, pushes updates
 * POST /api/features/flag    — Toggle a feature flag at runtime (operator only)
 */

"use strict";

const { DEFAULT_FEATURES, buildSystemState, evaluateFeatures } = require("../lib/feature-graph");

// Runtime flag overrides (survive process but not restart — use .env for persistence)
const _runtimeFlags = {};

const SSE_INTERVAL_MS = 10_000;

module.exports = async function featuresRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  // ── GET /api/features/state ──────────────────────────────────────────────────
  if (url.pathname === "/api/features/state" && req.method === "GET") {
    const state = _buildState();
    const features = evaluateFeatures(DEFAULT_FEATURES, state);
    sendJson(res, {
      generatedAt: new Date().toISOString(),
      systemState: {
        health: state.health,
        latencyMs: state.latencyMs,
        isDev: state.isDev,
      },
      features,
      activeCount: features.filter((f) => f.state === "active").length,
      totalCount: features.length,
    });
    return true;
  }

  // ── GET /api/features/stream — SSE live update stream ─────────────────────
  if (url.pathname === "/api/features/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state immediately
    send(_featurePayload());

    const interval = setInterval(() => {
      try {
        send(_featurePayload());
      } catch {
        clearInterval(interval);
      }
    }, SSE_INTERVAL_MS);

    req.on("close", () => clearInterval(interval));
    req.on("error", () => clearInterval(interval));
    return true;
  }

  // ── POST /api/features/flag — runtime flag toggle ─────────────────────────
  if (url.pathname === "/api/features/flag" && req.method === "POST") {
    const { collectRequestBody } = deps;
    try {
      const body = JSON.parse(await collectRequestBody(req));
      const { flag, enabled } = body;
      if (!flag || typeof enabled !== "boolean") {
        sendJson(res, { error: "flag (string) and enabled (boolean) required" }, 400);
        return true;
      }
      _runtimeFlags[flag] = enabled;
      // Propagate to process.env so buildSystemState picks it up
      process.env[flag] = enabled ? "true" : "";
      const payload = _featurePayload();
      sendJson(res, { ok: true, flag, enabled, ...payload });
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
    }
    return true;
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildState() {
  const state = buildSystemState();
  // Merge runtime flag overrides
  Object.assign(state.flags, _runtimeFlags);
  return state;
}

function _featurePayload() {
  const state = _buildState();
  const features = evaluateFeatures(DEFAULT_FEATURES, state);
  return {
    generatedAt: new Date().toISOString(),
    systemState: { health: state.health, latencyMs: state.latencyMs, isDev: state.isDev },
    features,
    activeCount: features.filter((f) => f.state === "active").length,
    totalCount: features.length,
  };
}
