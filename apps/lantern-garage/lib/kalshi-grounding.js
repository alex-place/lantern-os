"use strict";

/**
 * Kalshi grounding engine — the Reason stage for the grounded position-taker.
 *
 * Σ₀ External-Reality rule applied to trading: a position is an important claim, so
 * it needs evidence. Momentum on efficient markets has no edge after fees (proven in
 * PR #1765). The only durable edge is INFORMATION the thin market hasn't priced — so
 * for a groundable event market (weather, econ, near-term events) we estimate a
 * web-grounded P(YES) and only act when it diverges from the market price enough to
 * clear the fee hurdle.
 *
 * groundMarket(market) -> { p_yes, confidence, rationale, evidence[], sources[], model, ts }
 *
 * Grounding path (Vertex/Gemini is the funded provider — Vertex ADC preferred):
 *   1. webSearch() — keyless (MCP -> DuckDuckGo -> Wikipedia), for evidence snippets.
 *   2. Gemini + native googleSearch tool — live web grounding with cited sources.
 *      Routed through geminiTransport, which uses Vertex (funded GCP credits, no rate
 *      limit) when VERTEX_PROJECT is set, else the AI-Studio key with a 429 fallback.
 *   3. callLlm("auto") fallback (Vertex -> Gemini -> Ollama) if the direct call fails.
 *
 * Results are cached (TTL) and appended to data/kalshi/grounding-cache.jsonl as an
 * audit trail. NOTHING here places an order.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const { webSearch } = require("./web-search-client");
const { geminiTransport } = require("./gemini-transport");
let _callLlm = null;
try { _callLlm = require("./self-edit-engine").callLlm; } catch { /* optional */ }

const KALSHI_DIR = path.resolve(__dirname, "..", "..", "..", "data", "kalshi");
const CACHE_FILE = path.join(KALSHI_DIR, "grounding-cache.jsonl");

const TTL_MS = Number(process.env.KALSHI_GROUND_TTL_MS) || 2 * 60 * 60 * 1000; // 2h
const GROUND_MODEL = process.env.GEMINI_GROUND_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ── cache (in-memory, warmed + persisted to jsonl) ──────────────────────────────
const _cache = new Map(); // ticker -> { result, expires }

function _warm() {
  try {
    const lines = fs.readFileSync(CACHE_FILE, "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (!r.ticker || !r.ts) continue;
        const expires = Date.parse(r.ts) + TTL_MS;
        if (expires > Date.now()) _cache.set(r.ticker, { result: r, expires });
      } catch { /* skip */ }
    }
  } catch { /* no cache yet */ }
}
_warm();

function _persist(result) {
  try {
    fs.mkdirSync(KALSHI_DIR, { recursive: true });
    fs.appendFileSync(CACHE_FILE, JSON.stringify(result) + "\n");
  } catch { /* best-effort */ }
}

// ── helpers ─────────────────────────────────────────────────────────────────────
function _clamp01(x) { return Math.max(0, Math.min(1, x)); }

function _extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through to lenient */ } }
  // Lenient: a grounded reply can truncate mid-rationale (finishReason MAX_TOKENS),
  // leaving invalid JSON. p_yes is the one field we must recover — pull it directly.
  const py = text.match(/"p_yes"\s*:\s*(-?\d*\.?\d+)/i);
  if (!py) return null;
  const conf = text.match(/"confidence"\s*:\s*(-?\d*\.?\d+)/i);
  const rat = text.match(/"rationale"\s*:\s*"([^"]*)/i);
  return {
    p_yes: Number(py[1]),
    confidence: conf ? Number(conf[1]) : 0.5,
    rationale: rat ? rat[1] : "",
  };
}

function _researchQuery(market) {
  const title = market.title || market.ticker || "";
  // The resolution rule is the precise YES condition — the thing to research.
  const rule = (market.rules_primary || "").slice(0, 220);
  const close = market.close_time ? ` (resolves ${String(market.close_time).slice(0, 10)})` : "";
  return `${title}${close} — ${rule}`.trim();
}

// Gemini call with the native googleSearch tool (live web grounding), routed through
// geminiTransport — Vertex (funded GCP, no rate limit, reliable grounding) when
// VERTEX_PROJECT is set, else the AI-Studio free key with the proven 429 ->
// free-knowledge fallback (the free googleSearch tool is a paid feature → 429s).
// Returns { text, sources, grounded, model }.
async function _geminiGrounded(prompt) {
  let wire;
  try { wire = await geminiTransport({ model: GROUND_MODEL, method: "generateContent", streaming: false }); }
  catch { return null; } // no Vertex token AND no AI-Studio key
  const onVertex = !!wire.vertex;

  function call(useSearch) {
    const payload = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
      // Grounding spends output tokens on internal search reasoning, so the JSON can
      // truncate at a small cap (finishReason MAX_TOKENS). Give it ample room.
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: wire.hostname, path: wire.path, method: "POST",
        headers: { ...wire.headers, "Content-Length": Buffer.byteLength(payload) },
      }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); res.on("error", reject); });
      req.on("error", reject);
      req.setTimeout(28000, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload); req.end();
    });
  }

  try {
    let searched = true;
    let { status, body } = await call(true);
    // Only the AI-Studio free key 429s on the paid search tool; retry knowledge-only.
    if (status === 429 && !onVertex) { searched = false; ({ status, body } = await call(false)); }
    if (status !== 200) return null;
    const j = JSON.parse(body);
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("") || "";
    if (!text.trim()) return null;
    const meta = j.candidates?.[0]?.groundingMetadata;
    const sources = (meta?.groundingChunks || []).map(c => c.web?.uri).filter(Boolean);
    return {
      text, sources,
      grounded: searched && sources.length > 0,
      model: `${onVertex ? "vertex" : "gemini"}:${GROUND_MODEL}${searched ? "+search" : ""}`,
    };
  } catch { return null; }
}

function _systemPrompt() {
  return [
    "You are a calibrated forecaster pricing a binary prediction market.",
    "Estimate the TRUE probability the market resolves YES, using the resolution rule and any",
    "current real-world evidence (forecasts, data, reporting). Be well-calibrated and honest:",
    "if you lack information, say so with a probability near the market's implied price.",
    'Return ONLY JSON: {"p_yes": 0.0-1.0, "confidence": 0.0-1.0, "rationale": "one sentence"}.',
  ].join(" ");
}

// ── main: ground one market ─────────────────────────────────────────────────────
async function groundMarket(market, { force = false } = {}) {
  const ticker = market.ticker;
  if (!ticker) return { error: "no ticker" };

  const cached = _cache.get(ticker);
  if (!force && cached && cached.expires > Date.now()) {
    return { ...cached.result, cached: true };
  }

  const query = _researchQuery(market);
  const marketPct = market.yesPct != null ? market.yesPct
    : (market.yes_ask_dollars != null ? Math.round(Number(market.yes_ask_dollars) * 100) : null);

  // 1) keyless web evidence (snippets for the UI + context for the LLM fallback)
  let evidence = [];
  try {
    const ws = await webSearch(query, 5).catch(() => null);
    if (ws && ws.success) evidence = (ws.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
  } catch { /* non-fatal */ }

  const userPrompt =
    `Market: ${market.title || ticker}\n` +
    `Resolution rule (YES if true): ${(market.rules_primary || "n/a").slice(0, 400)}\n` +
    (market.close_time ? `Closes: ${market.close_time}\n` : "") +
    (marketPct != null ? `Market currently prices YES at ${marketPct}%.\n` : "") +
    (evidence.length ? `\nWeb evidence:\n${evidence.map((e, i) => `[${i + 1}] ${e.title}: ${e.snippet}`).join("\n").slice(0, 1500)}\n` : "") +
    `\nEstimate the true probability of YES.`;

  // 2) Gemini with live googleSearch grounding (best for current data)
  let p_yes = null, confidence = 0.5, rationale = "", sources = [], model = "none";
  // web_grounded = the estimate is backed by a LIVE web search (real sources), not
  // model-memory/climatology. The External-Reality rule: only a web-grounded estimate
  // may assert an edge over the market price; a knowledge-only guess defers to it.
  let webGrounded = false;
  const g = await _geminiGrounded(`${_systemPrompt()}\n\n${userPrompt}`);
  if (g) {
    const j = _extractJson(g.text);
    if (j && j.p_yes != null && isFinite(Number(j.p_yes))) {
      p_yes = _clamp01(Number(j.p_yes));
      confidence = _clamp01(Number(j.confidence != null ? j.confidence : 0.5));
      rationale = String(j.rationale || g.text.slice(0, 200)).slice(0, 280);
      sources = g.sources || [];
      model = g.model;
      // live only if the googleSearch tool actually ran AND returned sources
      webGrounded = !!g.grounded && sources.length > 0;
    }
  }

  // 3) fallback: auto-cascade LLM (Vertex -> Gemini -> Ollama) on the evidence block.
  // This has NO live web access — it is knowledge/climatology only, so web_grounded stays false.
  if (p_yes == null && _callLlm) {
    try {
      const out = await _callLlm(_systemPrompt(), userPrompt, "auto", 400);
      const j = _extractJson(out);
      if (j && j.p_yes != null && isFinite(Number(j.p_yes))) {
        p_yes = _clamp01(Number(j.p_yes));
        confidence = _clamp01(Number(j.confidence != null ? j.confidence : 0.5));
        rationale = String(j.rationale || "").slice(0, 280);
        model = "callLlm:auto(knowledge-only)";
      }
    } catch { /* fall through */ }
  }
  // A non-web-grounded estimate is weak evidence by construction — cap its confidence
  // so it can't masquerade as a high-conviction edge.
  if (!webGrounded) confidence = Math.min(confidence, 0.4);

  if (p_yes == null) {
    const result = {
      ticker, p_yes: null, confidence: 0, rationale: "grounding unavailable (no provider returned a probability)",
      evidence, sources, model: "none", query, ts: new Date().toISOString(), grounded: false,
    };
    return result; // not cached — retry next cycle
  }

  // merge web-evidence urls into sources for the audit trail
  const allSources = Array.from(new Set([...(sources || []), ...evidence.map(e => e.url).filter(Boolean)]));
  const result = {
    ticker, p_yes: Math.round(p_yes * 1000) / 1000,
    confidence: Math.round(confidence * 100) / 100,
    rationale, evidence, sources: allSources, model, query,
    ts: new Date().toISOString(), grounded: true, web_grounded: webGrounded,
  };
  _cache.set(ticker, { result, expires: Date.now() + TTL_MS });
  _persist(result);
  return result;
}

// Cache-only read — returns the cached grounding for a ticker or null, WITHOUT
// triggering a (slow) grounding call. The deck uses this to render instantly and
// kick off background grounding for the misses.
function peek(ticker) {
  const c = _cache.get(ticker);
  return (c && c.expires > Date.now()) ? c.result : null;
}

// ground many with a small concurrency cap (bounded LLM/search usage)
async function groundMany(markets, { concurrency = 4, force = false } = {}) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < markets.length) {
      const m = markets[i++];
      out.push(await groundMarket(m, { force }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, markets.length) }, worker));
  return out;
}

module.exports = { groundMarket, groundMany, peek, CACHE_FILE, TTL_MS };
