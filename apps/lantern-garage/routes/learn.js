// Learn-anything tutor API (#1438) — spaced-repetition concepts + retention.
//   GET  /api/learn                 → { cards, due, stats }
//   POST /api/learn                 { front, back, topic?, source? } → card
//   POST /api/learn/:id/review      { grade: 0..5 } → updated card (SM-2 scheduled)
const lt = require("../lib/learn-tutor");

module.exports = async function learnRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/learn" && req.method === "GET") {
    const now = Date.now();
    const cards = lt.readCards(repoRoot);
    sendJson(res, { ok: true, cards, due: lt.dueCards(cards, now), stats: lt.retentionStats(cards, now) }, 200);
    return true;
  }

  if (url.pathname === "/api/learn" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const card = lt.createCard(repoRoot, body, new Date().toISOString());
      sendJson(res, { ok: true, card }, 201);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  const m = url.pathname.match(/^\/api\/learn\/([^/]+)\/review$/);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const card = lt.gradeCard(repoRoot, decodeURIComponent(m[1]), body.grade, Date.now());
      if (!card) { sendJson(res, { ok: false, error: "card_not_found" }, 404); return true; }
      sendJson(res, { ok: true, card }, 200);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  return false;
};
