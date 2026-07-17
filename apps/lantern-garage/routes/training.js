// Convergence LoRA training management
// POST /api/dream/training/convergence-lora — collect + maybe train on convergence records
// GET  /api/dream/training/convergence-lora/state — convergence LoRA state
// (The Three Doors image-collect/status/start LoRA endpoints migrated with the
// game to the three-doors repo.)

const convergenceLora = require("../lib/convergence-lora");

module.exports = async function trainingRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  // ── Convergence LoRA collect + maybe train ───────────────────────
  if (url.pathname === "/api/dream/training/convergence-lora" && req.method === "POST") {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { sendJson(res, { error: "ANTHROPIC_API_KEY not set" }, 503); return true; }
      const result = await convergenceLora.collectAndMaybeTrainAsync({ apiKey });
      sendJson(res, result);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return true;
  }

  // ── Convergence LoRA state ───────────────────────────────────────
  if (url.pathname === "/api/dream/training/convergence-lora/state" && req.method === "GET") {
    sendJson(res, convergenceLora.getState());
    return true;
  }

  return false;
};
