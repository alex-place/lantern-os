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

  // GET /api/metrics/escalation — how often a live chat turn needs the expensive tier.
  // This is the number the in-house-model decision rests on: at our measured turn shape the
  // cheap tier is nearly free at 10k users, so the escalation premium IS the cost curve
  // (docs/research/2026-07-27-in-house-model-spec-grounded-in-the-product.md). The coding path
  // already reports its own rate via keystone-escalation.readRolloverShare(); this is the chat
  // equivalent. ?days=N windows the sample; ?turnsPerUserPerDay=N adjusts the projection.
  if (url.pathname === "/api/metrics/escalation" && req.method === "GET") {
    try {
      const meter = require("../lib/chat-escalation-meter");
      const days = Math.max(0, Number(url.searchParams.get("days")) || 0);
      const tpu = Math.max(1, Number(url.searchParams.get("turnsPerUserPerDay")) || 15);
      const stats = meter.summarize(meter.readRows(repoRoot), {
        sinceTs: days ? Date.now() - days * 86400000 : 0,
        turnsPerUserPerDay: tpu,
      });
      sendJson(res, { ok: true, windowDays: days || null, ...stats }, 200);
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
