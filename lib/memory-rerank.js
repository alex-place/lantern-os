"use strict";
// #2763 — rerank conversation-retrieval candidates so a buried-but-relevant turn (one that
// covers MORE of the query's DISTINCTIVE terms) isn't ranked below a shallow keyword match.
//
// The first pass (relevanceScore) can over-reward a single common-term repeat, so the turn that
// actually answers the question sometimes sorts below noise — the recall gap #2763 measures
// (77.5% recall@5 vs ~98% SOTA). Distinctive-term COVERAGE is the classic reranking signal that
// catches it: fraction of the query's distinct content terms the candidate covers. This is a
// pure REORDER over the existing first-pass candidates (no new store, no new retrieval); it is a
// no-op when the query has no distinctive terms (falls back to first-pass order). Pure; never throws.
//
// Fused score = (1-w)·normalizedFirstPassScore + w·distinctiveCoverage.

const { distinctiveHitCount } = require("./csf-memory");

const DEFAULT_WEIGHT = 0.5;

function _distinctQueryTermCount(query) {
  // The coverage denominator = the number of DISTINCT distinctive terms in the query. Compute it
  // with the same helper used for the numerator (distinctiveHitCount(query, query)) so numerator
  // and denominator share the retriever's exact content-word filtering — no separate tokenizer.
  try {
    return distinctiveHitCount(query, query) || 0;
  } catch {
    return 0;
  }
}

/**
 * Rerank first-pass candidates by fusing normalized first-pass score with distinctive-term
 * coverage. Returns the same objects, reordered, annotated with `.rerankScore` + `.coverage`.
 * @param {string} query
 * @param {Array<{text:string, score:number}>} candidates  first-pass results (score=relevanceScore)
 * @param {{weight?:number, limit?:number}} [opts]
 */
function rerank(query, candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  if (list.length <= 1) return list;
  const w = opts.weight == null ? DEFAULT_WEIGHT : Number(opts.weight);
  const denom = _distinctQueryTermCount(query);
  if (denom === 0) return list; // no distinctive query terms → keep first-pass order

  const maxScore = list.reduce((m, c) => Math.max(m, Number(c.score) || 0), 0) || 1;
  const enriched = list.map((c, i) => {
    const coverage = Math.min(1, (distinctiveHitCount(c.text || "", query) || 0) / denom);
    const norm = (Number(c.score) || 0) / maxScore;
    return { c, i, coverage, rerankScore: (1 - w) * norm + w * coverage };
  });
  // sort by fused score; stable on ties (original order preserved)
  enriched.sort((a, b) => b.rerankScore - a.rerankScore || a.i - b.i);

  const out = enriched.map((e) =>
    Object.assign(e.c, { rerankScore: Number(e.rerankScore.toFixed(4)), coverage: Number(e.coverage.toFixed(4)) }));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

module.exports = { rerank, DEFAULT_WEIGHT };
