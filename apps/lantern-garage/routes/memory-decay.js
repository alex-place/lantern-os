// Confidence-decay memory API (#1422) — memory that forgets gracefully.
//   GET  /api/decay-memory             → { memories (ranked, decayed), now }
//   POST /api/decay-memory             { text, source?, baseConfidence?, halfLifeDays? } → memory
//   POST /api/decay-memory/:id/reinforce → re-grounded memory (clock reset, half-life grown)
const md = require("../lib/memory-decay");

module.exports = async function memoryDecayRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;

  if (url.pathname === "/api/decay-memory" && req.method === "GET") {
    const now = Date.now();
    const floor = parseFloat(url.searchParams.get("floor") || "0") || 0;
    const memories = md.rankMemories(md.readMemories(repoRoot), now, { floor });
    sendJson(res, { ok: true, now: new Date(now).toISOString(), count: memories.length, memories }, 200);
    return true;
  }

  if (url.pathname === "/api/decay-memory" && req.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      const memory = md.createMemory(repoRoot, body, new Date().toISOString());
      sendJson(res, { ok: true, memory }, 201);
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 400); }
    return true;
  }

  const m = url.pathname.match(/^\/api\/decay-memory\/([^/]+)\/reinforce$/);
  if (m && req.method === "POST") {
    const memory = md.reinforceById(repoRoot, decodeURIComponent(m[1]), new Date().toISOString());
    if (!memory) { sendJson(res, { ok: false, error: "memory_not_found" }, 404); return true; }
    sendJson(res, { ok: true, memory: md.scoreMemory(memory, Date.now()) }, 200);
    return true;
  }

  return false;
};
