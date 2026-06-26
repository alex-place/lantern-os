/**
 * Ouro Intent Router (Σ₀ Step 2)
 *
 * The local Ouro model (always-local, cheap, can't code — 0/5 HumanEval) is used
 * NOT as a coder but as the AUTO-MODE ROUTER: it classifies the user's message into
 * a task type, which feeds the existing provider selection (selectProvider → PCSF →
 * cloud-first coding chain). This replaces the keyword `detectTaskType` guess with a
 * tiny-model classification ONLY in Auto mode (no explicit model picked).
 *
 * On-thesis: routing on the compute/cost axis (which model is best for this task),
 * not diverting guessed intent to a divergent behavior. Ouro never generates the
 * answer — it only triages. Cloud coders still write the code.
 *
 * Graceful degradation is mandatory: any failure (Ouro/Ollama down, timeout, an
 * unparseable reply) returns null so the caller falls back to the keyword
 * `detectTaskType`. Gated by OURO_ROUTER=1 at the call site; off → never invoked.
 *
 * Output task types match task-detector.js exactly so it's a drop-in:
 *   "coding" | "reasoning" | "creative" | "trading" | "default"
 */

const http = require("http");

const TASK_TYPES = ["coding", "reasoning", "creative", "trading", "default"];

const CLASSIFY_PROMPT = (message) =>
  `You are an intent classifier. Read the user's message and output the single best category from this list:\n` +
  `- coding: writing, fixing, reviewing, or explaining code, software, APIs, repos, errors\n` +
  `- reasoning: analysis, explanation, research, comparison, planning, math, "why" questions\n` +
  `- trading: markets, prices, positions, portfolio, buy/sell, Kalshi/Alpaca\n` +
  `- creative: stories, poems, art, music, imaginative writing\n` +
  `- default: greetings, small talk, or anything that fits none of the above\n\n` +
  `Output ONLY the category word, nothing else.\n\nUser message: ${message}\n\nCategory:`;

/**
 * Classify a message into a task type using the local Ouro model.
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.ollamaBase] - defaults to OLLAMA_BASE_URL or 127.0.0.1:11434
 * @param {string} [opts.model]      - defaults to OURO_ROUTER_MODEL || OLLAMA_MODEL || "ouro:latest"
 * @param {number} [opts.timeoutMs]  - hard cap so a slow/hung router never blocks chat (default 4000)
 * @returns {Promise<{taskType:string,isCoding:boolean,confidence:number,raw:string}|null>}
 *          null on ANY failure → caller falls back to keyword detectTaskType.
 */
function classifyIntentOuro(message, opts = {}) {
  return new Promise((resolve) => {
    if (!message || typeof message !== "string") return resolve(null);

    const base = opts.ollamaBase || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    const model = opts.model || process.env.OURO_ROUTER_MODEL || process.env.OLLAMA_MODEL || "ouro:latest";
    const timeoutMs = opts.timeoutMs || Number(process.env.OURO_ROUTER_TIMEOUT_MS || 4000);

    let url;
    try { url = new URL(base); } catch { return resolve(null); }

    const payload = JSON.stringify({
      model,
      prompt: CLASSIFY_PROMPT(message.slice(0, 2000)),
      stream: false,
      // Keep the router model resident between turns. Without this, Ollama unloads it
      // after its default idle TTL (~5m), so on a low-traffic server the NEXT Auto turn
      // pays a cold model-load that blows the timeout -> keyword fallback every time.
      // 30m keeps it warm with light periodic traffic. Tunable via OURO_ROUTER_KEEP_ALIVE.
      keep_alive: process.env.OURO_ROUTER_KEEP_ALIVE || "30m",
      // Tiny, deterministic decode — we only need one label word.
      options: { temperature: 0, top_p: 1, num_predict: 8, stop: ["\n"] },
    });

    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 11434,
        path: "/api/generate",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let body = "";
        res.on("data", (c) => { body += c.toString(); });
        res.on("end", () => done(parseClassification(body)));
        res.on("error", () => done(null));
      }
    );
    req.on("error", () => done(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Parse the Ollama /api/generate JSON, extract the label, map to a task type.
 * Returns null if no known label is found (→ keyword fallback).
 * @private
 */
function parseClassification(body) {
  let text;
  try { text = String(JSON.parse(body).response || "").toLowerCase(); } catch { return null; }
  if (!text.trim()) return null;
  // First task type whose word appears in the reply wins (handles "Category: coding").
  const hit = TASK_TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(text));
  if (!hit) return null;
  // Confidence: clean (reply is essentially just the label) reads as high; noisy lower.
  const clean = text.trim().replace(/[^a-z]/g, "").length <= hit.length + 2;
  return {
    taskType: hit,
    isCoding: hit === "coding",
    confidence: clean ? 0.85 : 0.6,
    raw: text.trim().slice(0, 60),
  };
}

module.exports = { classifyIntentOuro, TASK_TYPES };
