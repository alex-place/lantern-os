"use strict";

/**
 * Worldwide-patent retrieval for the unisona.ai chat assistant.
 *
 * A third local-corpus grounding source beside arXiv (lib/arxiv-index.js) — same
 * shape, same BM25 machinery, folded into the one research loop (lib/wide-search.js)
 * and exposed as the `patent_search` chat tool. NOT a new memory system: it mirrors
 * arXiv exactly so patents "inherit local grounding with no extra wiring".
 *
 * The index lives on the corpus drive:  $PATENT_CORPUS_DIR\index\  (default F:\patent-corpus).
 *   postings.json  {term: [[docId, tf], ...]}
 *   docs.jsonl     line docId = {id,title,published,country,assignee,cpc,snippet,url,len}
 *   meta.json      {count, avgdl, k1, b}
 *
 * The corpus is harvested offline (scripts/patent_harvest.py → scripts/patent_build_index.py),
 * worldwide-bibliographic + abstract via EPO Open Patent Services (free). Full text is
 * only free for EP/WO/US, so retrieval grounds on title + abstract — see docs/PATENT-CORPUS.md.
 *
 * Fail-safe by design: any missing index / parse error yields [] so chat is never
 * blocked. Gated so it only fires on patent / prior-art / IP questions.
 *
 * IMPORTANT: the tokenizer below must match scripts/patent_build_index.py exactly, or
 * query terms won't line up with indexed terms. (It is byte-identical to arxiv-index.js's
 * tokenizer on purpose — the two corpora share one tokenization contract.)
 */

const fs = require("fs");
const path = require("path");

const CORPUS_ROOT = process.env.PATENT_CORPUS_DIR || "F:\\patent-corpus";
const INDEX_DIR = path.join(CORPUS_ROOT, "index");

// Matched verbatim with the Python indexer's STOPWORDS (and with arxiv-index.js).
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

// --- patent-intent gate ----------------------------------------------------------
// Cheap keyword gate so retrieval only fires on questions where patents help (prior
// art, IP landscape, freedom-to-operate, "who holds the patent on X"), avoiding
// per-message cost and noise on unrelated chats. `includes`-matching means the bare
// token "patent" already covers patents / patented / patentable / patentability /
// patent family / patent office / patent search / patent landscape / publication
// number, so the list stays short and every entry is unambiguously patent/IP intent.
const PATENT_GATE_TERMS = [
  "patent",                              // the workhorse — substring-covers the whole family above
  "prior art", "prior-art",
  "uspto", "espacenet", "wipo", "patentscope", "google patents",
  "intellectual property",
  "freedom to operate", "freedom-to-operate",
  "infringe",                            // infringe / infringes / infringing / infringement
  "invention", "inventor",
  "novelty", "non-obvious", "obviousness",
  "cpc classification", "ipc classification",
];

function looksLikePatentQuestion(message) {
  const m = String(message || "").toLowerCase();
  if (m.length < 3) return false;
  return PATENT_GATE_TERMS.some((t) => m.includes(t));
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
 * Return up to `k` patents most relevant to `message`.
 * @returns {Array<{id,title,published,country,assignee,cpc,snippet,url}>}
 */
function queryPatents(message, k = 3) {
  try {
    if (!message || !looksLikePatentQuestion(message)) return [];
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
          country: d.country,
          assignee: d.assignee,
          cpc: d.cpc,
          snippet: d.snippet,
          url: d.url,
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

module.exports = { queryPatents, looksLikePatentQuestion, tokenize, isAvailable, INDEX_DIR };
