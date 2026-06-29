// Open-video research flywheel — read-only status for the Creator Dashboard.
const { getResearchStatus } = require("../lib/research-status");
const { wideSearch } = require("../lib/wide-search");
const { writeStreamHeaders, writeData } = require("../lib/stream-chat/sse");

module.exports = async function researchRoutes(req, res, url, deps) {
  if (url.pathname === "/api/research/status") {
    try {
      deps.sendJson(res, getResearchStatus(deps.repoRoot));
    } catch (e) {
      deps.sendJson(res, { ok: false, error: e.message }, 500);
    }
    return true;
  }

  // Wide web search — Σ₀ escalating-fidelity research loop, streamed over SSE so the
  // view can show the ladder rise (wide fan-out → cheap prune → strong synthesis).
  // GET /api/research/wide-search?q=...&breadth=6&perQuery=4
  if (url.pathname === "/api/research/wide-search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      deps.sendJson(res, { ok: false, error: "missing q" }, 400);
      return true;
    }
    const clampInt = (v, lo, hi, def) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    const breadth = clampInt(url.searchParams.get("breadth"), 2, 10, 6);
    const perQuery = clampInt(url.searchParams.get("perQuery"), 2, 8, 4);

    writeStreamHeaders(res);
    // Heartbeat so proxies don't drop a long fan-out connection.
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (_e) {} }, 15000);
    let closed = false;
    req.on("close", () => { closed = true; clearInterval(hb); });

    try {
      const result = await wideSearch({
        query: q,
        breadth,
        perQuery,
        onStep: (stage, status, extra) => {
          if (closed) return;
          writeData(res, { type: "step", stage, status, ...extra });
        },
      });
      if (!closed) writeData(res, { type: "result", ...result });
    } catch (e) {
      if (!closed) writeData(res, { type: "error", error: e.message });
    } finally {
      clearInterval(hb);
      if (!closed) { writeData(res, { type: "done" }); res.end(); }
    }
    return true;
  }
};
