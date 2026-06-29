"use strict";
/**
 * Wide Web Search — Σ₀ escalating-fidelity research loop.
 *
 * One pass of the loop (Observe → Reason → Verify → Converge), made wide and
 * cheap-first:
 *
 *   1. OBSERVE  (wide fan-out) — expand the question into several angled
 *      sub-queries and run them ALL through the dependable web-search client
 *      (MCP → DuckDuckGo → Wikipedia), then dedupe into one source pool. Many
 *      narrow searches beat one broad search for recall.
 *
 *   2. REASON  (low fidelity FIRST) — the cheap/local model does the first pass:
 *      score the pool, drop the junk, keep the relevant sources, and rough out a
 *      draft. This is the "start low" half — most of the pruning is done by the
 *      model we can run for free.
 *
 *   3. REASON  (higher fidelity) — only the survivors are handed to a stronger
 *      model to synthesize the final grounded answer with inline [n] citations.
 *      We pay for the good model once, over a small clean context.
 *
 *   4. VERIFY / CONVERGE — every kept source is numbered and returned so the
 *      view can show [claim → source]; confidence falls out of how much of the
 *      pool survived + how many sources the answer actually cites.
 *
 * The escalation ladder (which providerHint runs each stage) is explicit and
 * injectable so this is testable and the view can show "ran on X, escalated to
 * Y". `callLlm` is the non-streaming multi-provider helper from
 * self-edit-engine; `webSearch` is the keyless-fallback search client.
 */

const { webSearch } = require("./web-search-client");
const { extractKeywords } = require("./autowork-research");

let callLlm = null;
try { ({ callLlm } = require("./self-edit-engine")); } catch (_e) { /* optional — runs degraded */ }

// Default fidelity ladder: cheap/local first, stronger model for synthesis only.
// "auto" cascades Vertex → Claude → Gemini → … (whatever has funded quota).
const LOW = process.env.WIDE_SEARCH_LOW_PROVIDER || "ollama";
const HIGH = process.env.WIDE_SEARCH_HIGH_PROVIDER || "auto";

// Try the LLM; on any failure (no key, quota, empty, bad JSON) return null so the
// caller can fall back to a deterministic path. The loop must never hard-fail just
// because a model is unavailable.
async function _tryLlm(system, user, providerHint, maxTokens) {
  if (typeof callLlm !== "function") return null;
  try {
    const out = await callLlm(system, user, providerHint, maxTokens);
    return out && String(out).trim() ? String(out) : null;
  } catch (_e) {
    return null;
  }
}

// Pull the first JSON array/object out of a model reply (they like to wrap it in
// prose or ```json fences). Returns null if nothing parses.
function _extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/**
 * Expand the question into angled sub-queries (low-fidelity model, deterministic
 * fallback). Wider angles = better recall before the cheap prune.
 */
async function expandQueries(query, { breadth = 6, lowProvider = LOW } = {}) {
  const q = String(query || "").trim();
  const want = Math.max(2, Math.min(10, breadth));

  const raw = await _tryLlm(
    "You expand a research question into distinct web-search queries that cover "
      + "different angles (definition, latest developments, criticism/limitations, "
      + "comparisons, real-world use). Reply with ONLY a JSON array of short query "
      + "strings, no prose.",
    `Question: ${q}\n\nReturn ${want} search queries as a JSON array of strings.`,
    lowProvider,
    512
  );
  const parsed = _extractJson(raw);
  let queries = Array.isArray(parsed)
    ? parsed.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

  // Deterministic fallback / top-up so we always have a wide-enough fan-out.
  if (queries.length < want) {
    const kw = extractKeywords(q, 4).join(" ");
    const seeds = [
      q,
      kw && `${kw} latest 2026`,
      kw && `${kw} explained`,
      kw && `${kw} criticism limitations`,
      kw && `${kw} comparison alternatives`,
      kw && `${kw} how it works`,
    ].filter(Boolean);
    for (const s of seeds) {
      if (queries.length >= want) break;
      if (!queries.some((x) => x.toLowerCase() === s.toLowerCase())) queries.push(s);
    }
  }
  // Dedupe case-insensitively, cap at breadth.
  const seen = new Set();
  return queries.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, want);
}

/** Run every sub-query in parallel and dedupe into one numbered source pool. */
async function fanOut(queries, { perQuery = 4, emit = () => {} } = {}) {
  const settled = await Promise.all(
    queries.map(async (sq) => {
      try {
        const r = await webSearch(sq, perQuery);
        const results = r && r.success && Array.isArray(r.results) ? r.results : [];
        emit("observe", "subquery_done", { query: sq, source: r && r.source, results: results.length });
        return results.map((x) => ({ ...x, via: sq }));
      } catch (e) {
        emit("observe", "subquery_failed", { query: sq, reason: e.message });
        return [];
      }
    })
  );

  const byUrl = new Map();
  for (const list of settled) {
    for (const item of list) {
      const url = String(item.url || "").trim();
      if (!url) continue;
      if (!byUrl.has(url)) {
        byUrl.set(url, { title: item.title || url, url, snippet: item.snippet || "", via: [item.via] });
      } else {
        byUrl.get(url).via.push(item.via);
      }
    }
  }
  return [...byUrl.values()];
}

/**
 * Low-fidelity first pass: ask the cheap model which pooled sources are actually
 * relevant + rough out a draft. Falls back to "keep the first N" if the model is
 * unavailable or returns junk.
 */
async function lowPass(query, pool, { lowProvider = LOW, keep = 8 } = {}) {
  const indexed = pool.map((s, i) => `[${i}] ${s.title} — ${s.snippet}`.slice(0, 240)).join("\n");
  const raw = await _tryLlm(
    "You are the cheap first-pass filter in a research loop. Given a question and a "
      + "numbered list of web sources, pick the indices of the sources genuinely "
      + "relevant to answering it (drop spam/off-topic). Reply with ONLY a JSON "
      + "object: {\"keep\":[indices], \"draft\":\"2-3 sentence rough answer\"}.",
    `Question: ${query}\n\nSources:\n${indexed}\n\nReturn JSON.`,
    lowProvider,
    1024
  );
  const parsed = _extractJson(raw);
  let keepIdx = parsed && Array.isArray(parsed.keep)
    ? parsed.keep.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < pool.length)
    : [];
  const draft = parsed && typeof parsed.draft === "string" ? parsed.draft.trim() : "";

  if (!keepIdx.length) keepIdx = pool.map((_s, i) => i); // model down → keep all, rank by fan-out hits
  // Prefer sources that surfaced under multiple sub-queries (broad agreement).
  keepIdx.sort((a, b) => (pool[b].via.length - pool[a].via.length));
  const kept = [...new Set(keepIdx)].slice(0, keep).map((i) => pool[i]);
  return { kept, draft, modelRan: !!parsed };
}

/**
 * Higher-fidelity synthesis over the small clean context. Numbered [n] citations
 * map back to `kept`. Falls back to the low-pass draft if no strong model answers.
 */
async function highPass(query, kept, draft, { highProvider = HIGH } = {}) {
  const cited = kept.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.url}\n    ${s.snippet}`.slice(0, 320)).join("\n\n");
  const raw = await _tryLlm(
    "You synthesize a grounded answer from numbered web sources. Use ONLY the "
      + "sources. Cite inline with [n] matching the source numbers. If the sources "
      + "do not support a claim, say so. Be concise and concrete.",
    `Question: ${query}\n\nSources:\n${cited}\n\n`
      + (draft ? `First-pass draft (improve & ground it): ${draft}\n\n` : "")
      + "Write the final grounded answer in Markdown with inline [n] citations.",
    highProvider,
    2048
  );
  if (raw && raw.trim()) return { answer: raw.trim(), modelRan: true };
  // No strong model available — return the cheap draft, honestly labelled.
  return {
    answer: draft
      ? `_(low-fidelity draft — no higher model available)_\n\n${draft}`
      : "_No model available to synthesize. Raw sources are listed below._",
    modelRan: false,
  };
}

/** Confidence from how much of the pool survived + how many sources got cited. */
function _confidence(poolSize, keptSize, answer, highRan) {
  if (!poolSize) return 0.1;
  const cited = new Set((String(answer).match(/\[(\d+)\]/g) || []).map((m) => m)).size;
  const coverage = Math.min(1, keptSize / Math.max(3, poolSize));
  const grounding = Math.min(1, cited / Math.max(2, keptSize));
  const base = 0.3 + 0.3 * coverage + 0.3 * grounding;
  return Math.round((highRan ? base : base * 0.7) * 100) / 100;
}

/**
 * Run the full wide-search escalation loop.
 * @param {object} o
 * @param {string} o.query
 * @param {function} [o.onStep]  (stage, status, extra) sink (wire to SSE)
 * @param {number}  [o.breadth=6]   number of sub-queries to fan out
 * @param {number}  [o.perQuery=4]  results per sub-query
 * @param {number}  [o.keep=8]      sources kept after the low pass
 * @param {string}  [o.lowProvider] fidelity-ladder bottom (default ollama)
 * @param {string}  [o.highProvider] fidelity-ladder top (default auto cascade)
 */
async function wideSearch(o) {
  const {
    query, onStep, breadth = 6, perQuery = 4, keep = 8,
    lowProvider = LOW, highProvider = HIGH,
  } = o || {};
  const emit = (stage, status, extra = {}) => {
    try { if (typeof onStep === "function") onStep(stage, status, extra); } catch (_e) { /* ignore */ }
  };
  const t0 = Date.now();
  const q = String(query || "").trim();
  if (!q) throw new Error("empty query");

  // 1) OBSERVE — expand + wide fan-out.
  emit("observe", "expanding", { provider: lowProvider });
  const subqueries = await expandQueries(q, { breadth, lowProvider });
  emit("observe", "subqueries", { subqueries });

  emit("observe", "fanning_out", { count: subqueries.length, perQuery });
  const pool = await fanOut(subqueries, { perQuery, emit });
  emit("observe", "pool", { totalSources: pool.length });

  if (!pool.length) {
    const out = { query: q, subqueries, sources: [], answer: "_No web sources found for this question._", confidence: 0.1, tiers: { low: lowProvider, high: highProvider }, ms: Date.now() - t0 };
    emit("converge", "done", out);
    return out;
  }

  // 2) REASON — low-fidelity first pass (cheap prune + draft).
  emit("reason", "low_pass_start", { provider: lowProvider, poolSize: pool.length });
  const { kept, draft, modelRan: lowRan } = await lowPass(q, pool, { lowProvider, keep });
  emit("reason", "low_pass_done", { provider: lowProvider, modelRan: lowRan, kept: kept.length, draft });

  // 3) REASON — escalate to higher fidelity for synthesis.
  emit("reason", "high_pass_start", { provider: highProvider, sources: kept.length });
  const { answer, modelRan: highRan } = await highPass(q, kept, draft, { highProvider });
  emit("reason", "high_pass_done", { provider: highProvider, modelRan: highRan });

  // 4) VERIFY / CONVERGE.
  const confidence = _confidence(pool.length, kept.length, answer, highRan);
  const out = {
    query: q,
    subqueries,
    sources: kept.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, snippet: s.snippet, via: s.via })),
    poolSize: pool.length,
    answer,
    confidence,
    tiers: { low: lowProvider, lowRan, high: highProvider, highRan },
    ms: Date.now() - t0,
  };
  emit("verify", "grounded", { sources: out.sources.length, confidence });
  emit("converge", "done", out);
  return out;
}

module.exports = { wideSearch, expandQueries, fanOut, lowPass, highPass };
