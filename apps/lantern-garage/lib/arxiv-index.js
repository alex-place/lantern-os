"use strict";

/**
 * arXiv recent-research retrieval for the unisona.ai chat assistant.
 *
 * Mirrors the existing `queryResearchLibrary()` seam in csf-memory.js, but backs it
 * with a precomputed BM25 index (built by scripts/arxiv_build_index.py) instead of a
 * linear scan, because the corpus is 60-80k papers. Surfaced through the same
 * chat-context assembler — one new doc source, not a new memory system.
 *
 * The index lives on the corpus drive:  $ARXIV_CORPUS_DIR\index\  (default F:\arxiv-corpus).
 *   postings.json  {term: [[docId, tf], ...]}
 *   docs.jsonl     line docId = {id,title,published,primary_category,snippet,url,len}
 *   meta.json      {count, avgdl, k1, b}
 *
 * Fail-safe by design: any missing index / parse error yields [] so chat is never
 * blocked. Gated so it only fires on AI/ML-research questions.
 *
 * IMPORTANT: the tokenizer below must match scripts/arxiv_build_index.py exactly, or
 * query terms won't line up with indexed terms.
 */

const fs = require("fs");
const path = require("path");

const CORPUS_ROOT = process.env.ARXIV_CORPUS_DIR || "F:\\arxiv-corpus";
const INDEX_DIR = path.join(CORPUS_ROOT, "index");

// Matched verbatim with the Python indexer's STOPWORDS.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "as",
  "by", "at", "from", "is", "are", "be", "been", "was", "were", "this", "that", "these",
  "those", "it", "its", "we", "our", "they", "their", "can", "which", "such", "using",
  "used", "use", "via", "into", "than", "then", "also", "more", "most", "have", "has",
  "not", "no", "do", "does", "how", "what", "when", "where", "why", "who",
]);

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(text) {
  const out = [];
  const m = String(text || "").toLowerCase().match(TOKEN_RE);
  if (!m) return out;
  for (const t of m) {
    if (t.length >= 2 && !STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

// --- AI/ML-research gate -------------------------------------------------------
// Cheap keyword gate so retrieval only fires on questions where recent papers help,
// avoiding per-message cost and noise on unrelated chats.
const AI_GATE_TERMS = [
  "llm", "llms", "language model", "language models", "transformer", "transformers",
  "gpt", "claude", "gemini", "llama", "mistral", "qwen", "deepseek", "diffusion",
  "fine-tune", "fine-tuning", "finetune", "finetuning", "pretrain", "pretraining",
  "rlhf", "rlaif", "dpo", "reward model", "instruction tuning", "in-context",
  "retrieval-augmented", "rag", "embedding", "embeddings", "tokenizer", "tokenization",
  "attention", "mixture of experts", "moe", "quantization", "quantize", "distillation",
  "distill", "hallucination", "benchmark", "humaneval", "mmlu", "gsm8k", "swe-bench",
  "agent", "agents", "agentic", "chain-of-thought", "chain of thought", "reasoning model",
  "context window", "long context", "scaling law", "scaling laws", "neural network",
  "machine learning", "deep learning", "reinforcement learning", "arxiv", "state space",
  "mamba", "inference", "alignment", "prompt", "prompting", "multimodal", "vision-language",
  "model", "models",
];

function looksLikeAIResearchQuestion(message) {
  const m = String(message || "").toLowerCase();
  if (m.length < 3) return false;
  return AI_GATE_TERMS.some((t) => m.includes(t));
}

// --- Index load + cache --------------------------------------------------------
let _cache = { ts: 0, mtime: 0, postings: null, docs: null, meta: null };
const CACHE_TTL_MS = 60_000;

function loadIndex() {
  const now = Date.now();
  const postingsPath = path.join(INDEX_DIR, "postings.json");
  const docsPath = path.join(INDEX_DIR, "docs.jsonl");
  const metaPath = path.join(INDEX_DIR, "meta.json");

  if (_cache.postings && now - _cache.ts < CACHE_TTL_MS) return _cache;

  if (!fs.existsSync(postingsPath) || !fs.existsSync(docsPath) || !fs.existsSync(metaPath)) {
    _cache = { ts: now, mtime: 0, postings: null, docs: null, meta: null };
    return _cache;
  }

  // Reuse the cached parse if the index hasn't been rebuilt since.
  const mtime = fs.statSync(postingsPath).mtimeMs;
  if (_cache.postings && mtime === _cache.mtime) {
    _cache.ts = now;
    return _cache;
  }

  const postings = JSON.parse(fs.readFileSync(postingsPath, "utf8"));
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const docs = [];
  const docsRaw = fs.readFileSync(docsPath, "utf8").split("\n");
  for (const line of docsRaw) {
    if (!line.trim()) continue;
    try {
      docs.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  _cache = { ts: now, mtime, postings, docs, meta };
  return _cache;
}

// --- BM25 query ----------------------------------------------------------------
/**
 * Return up to `k` recent arXiv papers most relevant to `message`.
 * @returns {Array<{id,title,published,snippet,url,primary_category}>}
 */
function queryArxiv(message, k = 3) {
  try {
    if (!message || !looksLikeAIResearchQuestion(message)) return [];
    const idx = loadIndex();
    if (!idx.postings || !idx.docs || !idx.docs.length) return [];

    const qterms = Array.from(new Set(tokenize(message)));
    if (!qterms.length) return [];

    const N = idx.meta.count || idx.docs.length;
    const avgdl = idx.meta.avgdl || 1;
    const k1 = idx.meta.k1 || 1.5;
    const b = idx.meta.b || 0.75;

    const scores = new Map();
    for (const term of qterms) {
      const plist = idx.postings[term];
      if (!plist || !plist.length) continue;
      const df = plist.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of plist) {
        const doc = idx.docs[docId];
        if (!doc) continue;
        const dl = doc.len || avgdl;
        const denom = tf + k1 * (1 - b + (b * dl) / avgdl);
        const gain = idf * ((tf * (k1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) || 0) + gain);
      }
    }
    if (!scores.size) return [];

    const top = Array.from(scores.entries())
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, k)
      .map(([docId]) => {
        const d = idx.docs[docId];
        return {
          id: d.id,
          title: d.title,
          published: d.published,
          snippet: d.snippet,
          url: d.url,
          primary_category: d.primary_category,
        };
      });
    return top;
  } catch {
    return [];
  }
}

/** Whether a usable index is present on disk (for status/diagnostics). */
function isAvailable() {
  try {
    const idx = loadIndex();
    return Boolean(idx.postings && idx.docs && idx.docs.length);
  } catch {
    return false;
  }
}

module.exports = { queryArxiv, looksLikeAIResearchQuestion, tokenize, isAvailable, INDEX_DIR };
