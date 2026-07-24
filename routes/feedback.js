// Chat user-feedback ledger (#1965) — the Observe-stage preference signal.
//   POST /api/dream/feedback         append one 👍/👎 verdict for an assistant turn
//   GET  /api/dream/feedback/recent  read back rows (?sessionId= is self-service;
//                                    the global cross-session read is operator-only, #770 precedent)
//
// Anthropic-style human-preference testing scaled to this app's real users: every
// verdict is attributable to the provider/model that actually served the turn (the
// stream's `done` receipt), so per-provider win rates are measurable from the ledger
// instead of argued from vibes.
const { isOperatorRequest } = require("../lib/request-auth");

const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

module.exports = async function feedbackRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, appendJsonlQueued, readJsonl, path, repoRoot } = deps;

  if (url.pathname === "/api/dream/feedback" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const verdict = body.verdict === "up" || body.verdict === "down" ? body.verdict : null;
      if (!verdict) throw new Error("verdict_must_be_up_or_down");
      const turnIndex = Number(body.turnIndex);
      const record = {
        ts: new Date().toISOString(),
        verdict,
        sessionId: clip(body.sessionId, 64) || null,
        turnIndex: Number.isFinite(turnIndex) ? turnIndex : null,
        provider: clip(body.provider, 40),
        model: clip(body.model, 80),
        intent: clip(body.intent, 40),
        routeLabel: clip(body.routeLabel, 80),
        userPreview: clip(body.userPreview, 160),
        replyPreview: clip(body.replyPreview, 160),
        surface: clip(body.surface, 40) || "dream-chat",
      };
      await appendJsonlQueued(path.join(repoRoot, "data", "feedback", "chat-feedback.jsonl"), record, { rotate: true });
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 400);
    }
    return true;
  }

  if (url.pathname === "/api/dream/feedback/recent" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    const sessionId = clip(url.searchParams.get("sessionId"), 64) || null;
    // #770 precedent: rows carry conversation previews, so the un-scoped global read
    // is operator-only; per-session reads are self-service.
    if (!sessionId && !isOperatorRequest(req)) {
      sendJson(res, { rows: [], note: "cross-session read requires a sessionId or operator auth" });
      return true;
    }
    const rows = readJsonl("data/feedback/chat-feedback.jsonl", sessionId ? 2000 : limit)
      .filter((r) => r && !r.parseError && (!sessionId || r.sessionId === sessionId))
      .slice(-limit);
    sendJson(res, { rows });
    return true;
  }

  return false;
};
