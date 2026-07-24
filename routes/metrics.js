// Outcome metrics API (#1411) — verified-patch-rate, honesty-rate, route-quality.
// GET /api/metrics/outcomes → live metrics computed from append-only logs, plus the
// captured baseline for movement.
const { computeOutcomeMetrics, loadOrCaptureBaseline } = require("../lib/outcome-metrics");
const { getEffectiveUserId } = require("../lib/session-identity");

module.exports = async function metricsRoutes(req, res, url, deps) {
  const { sendJson, repoRoot, collectRequestBody, appendJsonlQueued, path } = deps;

  // POST /api/metrics/three-doors — record a Three Doors game event (#2507). The client
  // fired this best-effort but the server had no handler (404). Append-only to the
  // EXISTING metrics store (data/metrics/three-doors-events.jsonl, already gitignored) —
  // extends existing metrics infra, adds no new parallel store.
  if (url.pathname === "/api/metrics/three-doors" && req.method === "POST") {
    try {
      let body = {};
      try { body = JSON.parse((await collectRequestBody(req)) || "{}"); } catch { /* invalid → 400 below */ }
      const event = String(body.event || "").slice(0, 80);
      if (!event) { sendJson(res, { ok: false, error: "missing_event" }, 400); return true; }
      const rec = { event, payload: body.payload ?? null, ts: Number(body.timestamp) || Date.now(), user: getEffectiveUserId(req) || null };
      await appendJsonlQueued(path.join(repoRoot, "data", "metrics", "three-doors-events.jsonl"), rec);
      sendJson(res, { ok: true }, 200);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 500); }
    return true;
  }

  if (url.pathname === "/api/metrics/outcomes" && req.method === "GET") {
    try {
      const metrics = computeOutcomeMetrics(repoRoot);
      const baseline = loadOrCaptureBaseline(metrics, repoRoot);
      sendJson(res, { ok: true, metrics, baseline }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  return false;
};
