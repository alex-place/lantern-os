"use strict";
/**
 * Personal fact-check (#1430) — paste any viral claim / headline / DM and get back
 * [verdict + confidence + reasoning + sources], grounded in real web sources.
 *
 * Pipeline: webSearch (keyless DDG/Wikipedia fallbacks, so it works offline) gathers
 * sources, then a reasoning model judges the claim against those sources. Honest by
 * contract: no sources → "unverified"; no judge available → sources returned with an
 * "unverified" verdict and a reason, never a fabricated verdict.
 *
 * The verdict parsing/derivation is pure and unit-tested; the model + web I/O is wired
 * in factCheck() and verified live.
 */
const http = require("http");

const VERDICTS = ["supported", "refuted", "misleading", "unverified"];

// Map a model's free-form verdict word onto our four canonical verdicts.
function normalizeVerdict(raw) {
  const s = String(raw == null ? "" : raw).toLowerCase().trim();
  // Misleading is checked first: "partly true" / "partly false" contain the true/false
  // tokens the other branches match, so order matters. No trailing \b — these are stems
  // that must match inflections ("support" → "supported", "refut" → "refuted").
  if (/\b(mislead|partly|partial|mixed|out of context|exaggerat|cherry)/.test(s)) return "misleading";
  if (/\b(refut|false|incorrect|debunk|wrong|fabricat|hoax)/.test(s)) return "refuted";
  if (/\b(support|true|correct|accurate|confirm|verif)/.test(s)) return "supported";
  return "unverified";
}

// Parse {verdict, confidence, reasoning} from a model reply (JSON preferred, prose
// tolerated). Always returns a well-formed object; never throws.
function parseVerdict(text) {
  const out = { verdict: "unverified", confidence: null, reasoning: "" };
  const raw = String(text == null ? "" : text);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      out.verdict = normalizeVerdict(j.verdict);
      if (typeof j.confidence === "number") out.confidence = Math.min(1, Math.max(0, j.confidence));
      else if (typeof j.confidence === "string" && /^\d+(\.\d+)?$/.test(j.confidence.trim())) {
        const n = parseFloat(j.confidence); out.confidence = n > 1 ? Math.min(1, n / 100) : n;
      }
      out.reasoning = String(j.reasoning || j.explanation || "").slice(0, 800);
      return out;
    } catch { /* fall through to prose parsing */ }
  }
  out.verdict = normalizeVerdict(raw);
  out.reasoning = raw.slice(0, 800).trim();
  return out;
}

// Confidence floor by verdict when the model didn't supply one — so a returned verdict
// still carries an honest, modest number rather than null.
function defaultConfidence(verdict, sourceCount) {
  if (verdict === "unverified") return sourceCount ? 0.2 : 0;
  return sourceCount >= 2 ? 0.6 : 0.4;
}

// Derive the final result from sources + an (async) judge. judge(claim, sources) →
// {verdict, confidence, reasoning} or null. Pure orchestration: testable with a stub.
async function deriveResult(claim, sources, judge) {
  if (!sources.length) {
    return { verdict: "unverified", confidence: 0,
      reasoning: "No web sources were found for this claim, so it can't be checked. Try rephrasing it.",
      sources: [] };
  }
  let judged = null;
  try { judged = judge ? await judge(claim, sources) : null; } catch { judged = null; }
  if (!judged) {
    return { verdict: "unverified", confidence: 0.2,
      reasoning: "Sources were found but no reasoning model was available to weigh them. Review the sources below yourself.",
      sources };
  }
  const verdict = normalizeVerdict(judged.verdict);
  const confidence = (typeof judged.confidence === "number")
    ? judged.confidence : defaultConfidence(verdict, sources.length);
  return { verdict, confidence, reasoning: String(judged.reasoning || "").slice(0, 800), sources };
}

// Local Ollama judge — reliable offline path (no API key). Returns parsed verdict or null.
function ollamaJudge(baseUrl, model) {
  return function judge(claim, sources) {
    const evidence = sources.slice(0, 6)
      .map((s, i) => `[${i + 1}] ${s.title || s.url || "source"}: ${(s.snippet || s.content || "").slice(0, 280)}`)
      .join("\n");
    const prompt =
      "You are a careful fact-checker. Judge the CLAIM strictly against the SOURCES below — " +
      "do not use outside knowledge. Respond with ONLY a JSON object: " +
      '{"verdict": "supported"|"refuted"|"misleading"|"unverified", "confidence": 0..1, "reasoning": "one or two sentences citing source numbers"}.\n\n' +
      `CLAIM: ${claim}\n\nSOURCES:\n${evidence}`;
    const payload = JSON.stringify({
      model, stream: false,
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.2, num_predict: 400 },
    });
    const u = new URL(baseUrl);
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port || 11434, path: "/api/chat", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            try {
              const content = JSON.parse(data).message?.content || "";
              resolve(content ? parseVerdict(content) : null);
            } catch { resolve(null); }
          });
        });
      req.on("error", () => resolve(null));
      req.setTimeout(45000, () => { req.destroy(); resolve(null); });
      req.write(payload); req.end();
    });
  };
}

async function factCheck(claim, opts = {}) {
  const text = String(claim || "").trim().slice(0, 1000);
  if (!text) return { ok: false, error: "empty_claim" };

  let sources = [];
  try {
    const { webSearch } = require("./web-search-client");
    const r = await webSearch(text, opts.maxResults || 6);
    if (r && r.success && Array.isArray(r.results)) {
      sources = r.results.slice(0, 6).map((s) => ({
        title: s.title || s.name || "", url: s.url || s.link || "",
        snippet: (s.snippet || s.content || s.description || "").slice(0, 400),
      }));
    }
  } catch { /* sources stay empty → unverified */ }

  const judge = opts.judge || ollamaJudge(
    process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    process.env.OLLAMA_MODEL || "qwen2.5-coder:14b-instruct-q5_k_m");
  const result = await deriveResult(text, sources, judge);
  return { ok: true, claim: text, checkedAt: new Date().toISOString(), ...result };
}

module.exports = { normalizeVerdict, parseVerdict, defaultConfidence, deriveResult, ollamaJudge, factCheck, VERDICTS };
