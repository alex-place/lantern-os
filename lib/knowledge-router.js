/**
 * Knowledge router — cheaper deterministic / "near" routing over the base
 * Knowledge Center grounding index (data/knowledge/index.jsonl).
 *
 * Tiering (cheapest first):
 *   1. deterministic — exact heading/path match → return that section verbatim ($0, no LLM)
 *   2. near          — TF-IDF nearest section above threshold → grounded answer ($0, no LLM)
 *   3. miss          → caller falls through to the LLM provider chain
 *
 * Build the index: `python scripts/build_knowledge_index.py`
 */
"use strict";
const fs = require("fs");
const path = require("path");

const INDEX_PATH = path.resolve(__dirname, "..", "data", "knowledge", "index.jsonl");
const NEAR_THRESHOLD = 0.18; // min normalized score to count as a near hit

let _cache = null;
let _mtime = 0;

const STOP = new Set("the a an of to and or is are for in on with how do does what why this that it as be by from at".split(" "));

function tokenize(s) {
  return (s || "").toLowerCase().match(/[a-z0-9_]{3,}/g)?.filter((t) => !STOP.has(t)) || [];
}

/**
 * A section is servable/retrievable only if it carries real prose. Guards against
 * degenerate index records (e.g. a bare code fence "```bash", or a heading-only
 * stub) that must never be surfaced verbatim as a chat answer.
 */
function hasProse(text) {
  const t = (text || "").replace(/```[a-z0-9]*|~~~/gi, "").trim();
  // strip fenced code so we judge the human-readable content, then require a few words
  const words = t.match(/[A-Za-z]{2,}/g) || [];
  return words.length >= 5;
}

function _load() {
  let stat;
  try { stat = fs.statSync(INDEX_PATH); } catch { return null; }
  if (_cache && stat.mtimeMs === _mtime) return _cache;

  const recs = [];
  const df = {}; // document frequency per term
  for (const line of fs.readFileSync(INDEX_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const toks = tokenize(`${r.heading} ${r.text}`);
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
    recs.push({ ...r, tf, len: toks.length || 1 });
  }
  const N = recs.length || 1;
  const idf = {};
  for (const [t, c] of Object.entries(df)) idf[t] = Math.log(1 + N / c);

  _cache = { recs, idf, N };
  _mtime = stat.mtimeMs;
  return _cache;
}

function _score(queryToks, rec, idf) {
  let s = 0;
  for (const t of queryToks) {
    if (rec.tf[t]) s += (rec.tf[t] / rec.len) * (idf[t] || 0);
  }
  return s;
}

/** Top-k KB sections for a query (deterministic; no LLM). */
function retrieve(query, k = 3) {
  const idx = _load();
  if (!idx) return [];
  const q = tokenize(query);
  if (!q.length) return [];
  const qnorm = q.length;
  const scored = idx.recs
    .filter((r) => hasProse(r.text))
    .map((r) => ({ r, score: _score(q, r, idx.idf) / qnorm }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map((x) => ({
    id: x.r.id, doc: x.r.doc, path: x.r.path, heading: x.r.heading,
    text: x.r.text, score: Math.round(x.score * 1000) / 1000,
  }));
}

/**
 * Try to answer a query cheaply from the KB. Returns:
 *   { tier: "deterministic"|"near"|"miss", hit, source, text, score, alternatives }
 */
function answer(query) {
  const idx = _load();
  if (!idx) return { tier: "miss", hit: false, reason: "no_index" };

  // 1. deterministic: query matches a heading (case-insensitive substring)
  const ql = (query || "").toLowerCase().trim();
  const exact = idx.recs.find((r) => ql && r.heading.toLowerCase() === ql && hasProse(r.text))
    || (ql.length > 6 ? idx.recs.find((r) => r.heading.toLowerCase().includes(ql) && hasProse(r.text)) : null);
  if (exact) {
    return { tier: "deterministic", hit: true, source: exact.path, heading: exact.heading, text: exact.text, score: 1 };
  }

  // 2. near: TF-IDF nearest section
  const top = retrieve(query, 3);
  if (top.length && top[0].score >= NEAR_THRESHOLD) {
    return { tier: "near", hit: true, source: top[0].path, heading: top[0].heading,
             text: top[0].text, score: top[0].score, alternatives: top.slice(1) };
  }
  return { tier: "miss", hit: false, top: top.slice(0, 3) };
}

module.exports = { retrieve, answer, NEAR_THRESHOLD };
