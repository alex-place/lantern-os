// Creator Intelligence — calibration API routes
// Imports the operator's OWN first-party analytics (YouTube Studio CSV export)
// and exposes calibration readiness, feature↔outcome correlations, and
// calibrated recommendations — all kept strictly separate from structural
// estimates. Everything here is gated by the `calibration` feature flag and is
// honest by construction (see src/creator-intelligence/calibration/).

"use strict";

const ci = require("../../../src/creator-intelligence");

// Hard cap on uploaded CSV text. A real YouTube Studio table export is KBs;
// anything larger is almost certainly not an analytics export.
const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB

module.exports = async function creatorCalibrationRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const P = url.pathname;

  if (!P.startsWith("/api/creator/calibration")) return false;

  // Single flag gate for the whole namespace — clear, explicit 403 when off.
  if (!ci.calibration.enabled()) {
    sendJson(res, {
      status: "disabled",
      reason: "calibration_flag_off",
      hint: "set LANTERN_CI_CALIBRATION=1 to enable analytics calibration",
    }, 403);
    return true;
  }

  // GET /api/creator/calibration/status
  if (P === "/api/creator/calibration/status" && req.method === "GET") {
    sendJson(res, {
      status: "ok",
      enabled: true,
      labeledOutcomes: ci.calibration.count(),
      readiness: ci.calibration.readiness(),
      thresholds: ci.calibration.thresholds(),
    });
    return true;
  }

  // GET /api/creator/calibration/entries  (to help map manual links)
  if (P === "/api/creator/calibration/entries" && req.method === "GET") {
    const entries = ci.calibration.loadEntries().map((e) => ({
      id: e.id, title: e.title, featureCount: Object.keys(e.features || {}).length,
    }));
    sendJson(res, { status: "ok", entries });
    return true;
  }

  // GET /api/creator/calibration/correlations
  if (P === "/api/creator/calibration/correlations" && req.method === "GET") {
    sendJson(res, ci.calibration.correlations({}));
    return true;
  }

  // GET /api/creator/calibration/recommendations  (calibrated only)
  if (P === "/api/creator/calibration/recommendations" && req.method === "GET") {
    sendJson(res, ci.calibration.recommendations({}));
    return true;
  }

  // GET /api/creator/calibration/weights  (B4: proposed calibrated scoring weights;
  // insufficient_data with priors unchanged until readiness is ok)
  if (P === "/api/creator/calibration/weights" && req.method === "GET") {
    sendJson(res, ci.calibration.weights({}));
    return true;
  }

  // POST /api/creator/calibration/weights/commit  (#909: persist the calibrated-weights
  // artifact so viral-score-v10 flips calibrated:true. Honesty-gated end-to-end — a
  // no-op { written:false } until real labeled outcomes make readiness ok.)
  if (P === "/api/creator/calibration/weights/commit" && req.method === "POST") {
    sendJson(res, ci.calibration.commitWeights({}));
    return true;
  }

  // POST /api/creator/calibration/import
  // body: { csvText, manualLinks?: [{videoRef, entryId}], dryRun?: bool,
  //         retentionByEntryId?: { [entryId]: { curveText|points, segments, durationSec } } }
  if (P === "/api/creator/calibration/import" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      if (raw && Buffer.byteLength(raw, "utf8") > MAX_CSV_BYTES) {
        sendJson(res, { status: "error", reason: "payload too large" }, 413);
        return true;
      }
      let body;
      try { body = JSON.parse(raw); } catch {
        sendJson(res, { status: "error", reason: "invalid JSON body" }, 400);
        return true;
      }
      const csvText = body && body.csvText;
      if (typeof csvText !== "string" || csvText.trim() === "") {
        sendJson(res, { status: "error", reason: "csvText (string) required" }, 400);
        return true;
      }
      if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
        sendJson(res, { status: "error", reason: "csvText too large" }, 413);
        return true;
      }

      const result = ci.calibration.importCsvText(csvText, {
        manualLinks: Array.isArray(body.manualLinks) ? body.manualLinks : undefined,
        dryRun: body.dryRun === true,
        // #iii: optional retention curves + segment lists per entry. Parsed and
        // validated defensively inside importCsvText (rows without a curve are
        // unaffected), so a passthrough here is safe.
        retentionByEntryId: (body.retentionByEntryId && typeof body.retentionByEntryId === "object")
          ? body.retentionByEntryId : undefined,
      });
      const code = result.status === "error" ? 422 : 200;
      sendJson(res, result, code);
    } catch (error) {
      console.error("[creator-calibration] import error:", error.message);
      sendJson(res, { status: "error", reason: error.message }, 500);
    }
    return true;
  }

  return false;
};
