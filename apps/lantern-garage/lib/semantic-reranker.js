/**
 * semantic-reranker.js — real semantic similarity via Ollama nomic-embed-text.
 *
 * Issue #919 finding #1: CSFCooccurrenceVectorizer is a keyword counter, not
 * semantic. This module adds a genuine semantic reranking layer on top of the
 * existing keyword-scored candidates.
 *
 * Model: nomic-embed-text (274 MB, 768-dim, pulled into local Ollama).
 * Endpoint: POST http://127.0.0.1:11434/api/embed  (supported without --embeddings flag).
 *
 * Usage:
 *   const { semanticRerank } = require("./semantic-reranker");
 *   const reranked = await semanticRerank(query, candidates, { topK: 3, fallback: true });
 *
 * Falls back silently to returning candidates in original order when Ollama is
 * unavailable or the embed model is not pulled — caller always gets results.
 */
"use strict";

const http = require("http");

const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || "11434", 10);
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const EMBED_TIMEOUT_MS = 3000;

/**
 * POST to /api/embed and return the embedding array, or null on failure.
 * Uses Node's built-in http so there's no fetch dependency.
 */
function _embed(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: text });
    const req = http.request(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: "/api/embed", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (d) => { raw += d; });
        res.on("end", () => {
          try {
            const d = JSON.parse(raw);
            const vec = (d.embeddings || [[]])[0];
            resolve(Array.isArray(vec) && vec.length > 0 ? vec : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(EMBED_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Cosine similarity between two same-length float arrays.
 */
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Rerank `candidates` by semantic similarity to `query`.
 *
 * @param {string}   query        — the user's message
 * @param {Array}    candidates   — array of objects with a `.text` string field
 * @param {object}   [opts]
 * @param {number}   [opts.topK=3]       — how many to return
 * @param {string}   [opts.textField="text"] — field on each candidate to embed
 * @param {boolean}  [opts.fallback=true] — return candidates unsorted on Ollama failure
 * @returns {Promise<Array>}  — same objects, reordered by semantic score
 */
async function semanticRerank(query, candidates, { topK = 3, textField = "text", fallback = true } = {}) {
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length <= 1) return candidates.slice(0, topK);

  try {
    const queryVec = await _embed(query);
    if (!queryVec) throw new Error("query embed failed");

    const scored = await Promise.all(
      candidates.map(async (c) => {
        const t = String(c[textField] || c.content?.text || c.content?.raw_input || "");
        const vec = await _embed(t.slice(0, 512));  // truncate to keep latency bounded
        const sim = vec ? _cosine(queryVec, vec) : 0;
        return { candidate: c, sim };
      })
    );

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, topK).map((s) => s.candidate);
  } catch {
    // Fallback: return candidates in original order
    return fallback ? candidates.slice(0, topK) : [];
  }
}

// Exposed for the retrieval A/B harness (#2356): the raw embedding + cosine, so the
// harness can measure the dense arm directly against the SAME nomic transport chat
// uses. Returns null when Ollama/the embed model is unavailable (harness skips the arm).
async function embedText(text) { return _embed(String(text || "").slice(0, 512)); }

module.exports = { semanticRerank, embedText, _cosine };
