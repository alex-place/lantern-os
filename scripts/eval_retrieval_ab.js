#!/usr/bin/env node
"use strict";
/**
 * eval_retrieval_ab.js — retrieval A/B measurement harness on OUR corpus (#2356).
 *
 * WHY: every retrieval number we have is borrowed (arXiv 2604.01733's +17.2pp
 * reranking lift is one financial domain w/ a cloud reranker; MTEB shifts monthly).
 * Per the External Reality Rule we do NOT wire a reranker (#2355) or swap a store on
 * faith. This harness replicates an arXiv-2604.01733-style ablation on a known-item
 * eval set drawn from our OWN prose corpus (dream-chat + trading narrations), using
 * the REAL production scorers (csf-memory relevanceScoreIdf; the nomic transport from
 * semantic-reranker), so the arms measured here are the arms dream-chat actually runs.
 *
 * ARMS
 *   lexical-idf   IDF-weighted overlap — the ACTUAL production lexical scorer
 *                 (csf-memory.relevanceScoreIdf + buildDocFreq). Deterministic, always runs.
 *   bm25-okapi    reference Okapi BM25 (k1=1.5, b=0.75). Deterministic, always runs.
 *   nomic-dense   cosine over nomic-embed-text (our dense arm). Runs iff Ollama is up.
 *   hybrid-a<α>   min-max-normalized lexical-idf ⊕ nomic, fused at α (default 0.5 — the
 *                 current production fusion). Runs iff Ollama is up.
 *   hybrid+rerank hybrid candidates reranked by a cross-encoder at $RERANKER_ENDPOINT.
 *                 SKIPPED (logged) until #2355 provides an endpoint — this is the seam
 *                 that converts the borrowed +17.2pp into a measured-on-our-corpus number.
 *
 * NO SILENT CAPS: every skipped arm prints why. Metrics: Recall@{5,10}, MRR@{3,10},
 * overall + per lexical-overlap tercile (low/mid/high — where dense/rerank should pay).
 *
 * USAGE
 *   node scripts/eval_retrieval_ab.js                 # bundled fixture (CI-safe, no deps)
 *   node scripts/eval_retrieval_ab.js --corpus <c.jsonl> --queries <q.jsonl>
 *   ALPHA=0.5 OLLAMA_HOST=127.0.0.1 node scripts/eval_retrieval_ab.js
 *
 *   Corpus JSONL:  {"id": "...", "text": "...", "category": "..."}
 *   Queries JSONL: {"query": "...", "gold_id": "..."}
 *
 * Appends one row per run to data/eval/retrieval/runs.jsonl. Registered in docs/BENCHMARKS.md.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { relevanceScoreIdf, buildDocFreq } = require(path.join(REPO_ROOT, "lib/csf-memory"));
const { embedText, _cosine } = require(path.join(REPO_ROOT, "lib/semantic-reranker"));

const ALPHA = Number(process.env.ALPHA || 0.5);
const RERANKER_ENDPOINT = process.env.RERANKER_ENDPOINT || "";
// Resolved at call time (not module-load) so tests can redirect via RETRIEVAL_RUNS_LOG.
function runsLogPath() { return process.env.RETRIEVAL_RUNS_LOG || path.join(REPO_ROOT, "data/eval/retrieval/runs.jsonl"); }
const FIXTURE_DIR = path.join(REPO_ROOT, "data/eval/retrieval/fixture");

// ── args ────────────────────────────────────────────────────────────────────────
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function readJsonl(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── tokenizer for the reference BM25 arm + overlap banding (self-contained) ───────
const STOP = new Set(("a an the is are was were be been and or but if of to in on at for with as by from this that " +
  "it its we our they their you your i me my he she his her do does did not no so than then " +
  "why did we how what when where which who").split(" "));
function toks(s) {
  const m = String(s || "").toLowerCase().match(/[a-z0-9]+/g);
  return m ? m.filter((t) => t.length >= 2 && !STOP.has(t)) : [];
}

// ── arms ──────────────────────────────────────────────────────────────────────────
// Each arm returns a Map<docId, score>. Higher = more relevant.
function armLexicalIdf(corpus, query, dfInfo) {
  const out = new Map();
  for (const d of corpus) out.set(d.id, relevanceScoreIdf(d.text, query, dfInfo));
  return out;
}

function buildBm25(corpus) {
  const docTokens = corpus.map((d) => toks(d.text));
  const N = corpus.length;
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(N, 1);
  const df = new Map();
  for (const t of docTokens) for (const term of new Set(t)) df.set(term, (df.get(term) || 0) + 1);
  const idf = (term) => Math.log(1 + (N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
  return { docTokens, avgdl, idf, k1: 1.5, b: 0.75 };
}
function armBm25(corpus, query, bm) {
  const q = toks(query);
  const out = new Map();
  corpus.forEach((d, i) => {
    const dt = bm.docTokens[i];
    const tf = new Map();
    for (const t of dt) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const term of q) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const num = f * (bm.k1 + 1);
      const den = f + bm.k1 * (1 - bm.b + bm.b * (dt.length / bm.avgdl));
      s += bm.idf(term) * (num / den);
    }
    out.set(d.id, s);
  });
  return out;
}

function armDense(corpus, queryVec, docVecs) {
  const out = new Map();
  for (const d of corpus) {
    const v = docVecs.get(d.id);
    out.set(d.id, v && queryVec ? _cosine(queryVec, v) : 0);
  }
  return out;
}

function minmax(scoreMap) {
  const vals = [...scoreMap.values()];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo;
  const out = new Map();
  for (const [k, v] of scoreMap) out.set(k, span > 0 ? (v - lo) / span : 0);
  return out;
}
function armHybrid(lexMap, denseMap, alpha) {
  const L = minmax(lexMap), D = minmax(denseMap);
  const out = new Map();
  for (const k of L.keys()) out.set(k, alpha * (L.get(k) || 0) + (1 - alpha) * (D.get(k) || 0));
  return out;
}

// ── Reciprocal Rank Fusion (#2389) ─────────────────────────────────────────────────
// Fuse the base retrieval arms by RANK, not score: each doc scores Σ_arm 1/(k + rank_arm),
// k=60 (Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet…"). Score-free
// fusion sidesteps the min-max normalization the hybrid arm needs, so a single arm's
// score scale can't dominate. A doc with no positive evidence in an arm contributes 0 from
// that arm (consistent with rankGold's non-positive = not-retrieved guard), so RRF can't
// reward a doc an arm never actually surfaced. Returns a Map<docId, fusedScore>.
const RRF_K = 60;
function armRRF(scoreMaps, k = RRF_K) {
  const fused = new Map();
  for (const sm of scoreMaps) {
    const ranked = [...sm.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    ranked.forEach(([id], i) => fused.set(id, (fused.get(id) || 0) + 1 / (k + i + 1)));
  }
  return fused;
}

// ── ranking + metrics ─────────────────────────────────────────────────────────────
// Honest 1-based rank of the gold doc. Two guards against inflated recall:
//  (1) a non-positive score = no retrieval evidence → Infinity (not "found by luck").
//      Otherwise an all-zero lexical arm would "rank" gold by its arbitrary corpus
//      position and score a false R@5 hit — the calm-but-wrong trap.
//  (2) ties are broken PESSIMISTICALLY (gold sits at the BOTTOM of its tie block),
//      so tied-at-zero or tied-at-max never gets a lucky top slot.
function rankGold(scoreMap, goldId) {
  const goldScore = scoreMap.get(goldId);
  if (goldScore === undefined || goldScore <= 0) return Infinity;
  let strictlyGreater = 0, tied = 0;
  for (const [id, s] of scoreMap) {
    if (id === goldId) continue;
    if (s > goldScore) strictlyGreater++;
    else if (s === goldScore) tied++;
  }
  return strictlyGreater + tied + 1;
}
function lexicalOverlap(query, goldText) {
  const q = new Set(toks(query));
  if (q.size === 0) return 0;
  const g = new Set(toks(goldText));
  let hit = 0;
  for (const t of q) if (g.has(t)) hit++;
  return hit / q.size;
}
function emptyAgg() { return { n: 0, r5: 0, r10: 0, mrr3: 0, mrr10: 0 }; }
function accumulate(agg, rank) {
  agg.n++;
  if (rank <= 5) agg.r5++;
  if (rank <= 10) agg.r10++;
  if (rank <= 3) agg.mrr3 += 1 / rank;
  if (rank <= 10) agg.mrr10 += 1 / rank;
}
function finalize(agg) {
  const n = Math.max(agg.n, 1);
  return { n: agg.n, "R@5": agg.r5 / n, "R@10": agg.r10 / n, "MRR@3": agg.mrr3 / n, "MRR@10": agg.mrr10 / n };
}

// ── cross-encoder rerank (pluggable — the #2355 seam) ─────────────────────────────
async function crossEncoderRerank(query, candidateDocs) {
  if (!RERANKER_ENDPOINT) return null; // caller logs the skip
  const http = require("http");
  const body = JSON.stringify({ query, documents: candidateDocs.map((d) => d.text) });
  const scores = await new Promise((resolve) => {
    const u = new URL(RERANKER_ENDPOINT);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let raw = ""; res.on("data", (d) => (raw += d));
      res.on("end", () => { try { resolve(JSON.parse(raw).scores || null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
  if (!Array.isArray(scores)) return null;
  const out = new Map();
  candidateDocs.forEach((d, i) => out.set(d.id, scores[i] ?? 0));
  return out;
}

// ── driver ──────────────────────────────────────────────────────────────────────
async function main() {
  const corpusPath = argOf("--corpus") || path.join(FIXTURE_DIR, "corpus.jsonl");
  const queriesPath = argOf("--queries") || path.join(FIXTURE_DIR, "queries.jsonl");
  const usingFixture = corpusPath.startsWith(FIXTURE_DIR);

  const corpus = readJsonl(corpusPath);
  const queries = readJsonl(queriesPath);
  const goldText = new Map(corpus.map((d) => [d.id, d.text]));
  const skipped = [];

  console.log(`# retrieval A/B — corpus=${corpus.length} docs, queries=${queries.length}` +
    `${usingFixture ? " (bundled fixture)" : ""}, alpha=${ALPHA}`);

  // Probe Ollama once (dense/hybrid arms).
  let ollamaUp = false;
  try { ollamaUp = !!(await embedText("probe")); } catch { ollamaUp = false; }
  if (!ollamaUp) skipped.push("nomic-dense + hybrid: Ollama embed unavailable (start Ollama + pull nomic-embed-text)");
  if (!RERANKER_ENDPOINT) skipped.push("hybrid+rerank: no $RERANKER_ENDPOINT set (provided by #2355)");

  // Precompute: lexical df over the corpus, BM25 stats, doc embeddings.
  const records = corpus.map((d) => ({ content: { text: d.text }, tags: [] }));
  const dfInfo = buildDocFreq(records);
  const bm = buildBm25(corpus);
  const docVecs = new Map();
  if (ollamaUp) for (const d of corpus) docVecs.set(d.id, await embedText(d.text));

  // Which arms run.
  const arms = ["lexical-idf", "bm25-okapi"];
  if (ollamaUp) arms.push("nomic-dense", `hybrid-a${ALPHA}`);
  if (ollamaUp && RERANKER_ENDPOINT) arms.push("hybrid+rerank");
  // RRF fuses the BASE retrieval arms (lexical-idf, bm25-okapi, + nomic-dense when up) —
  // not the hybrid/rerank arms, which are themselves fusions. Always runs (≥2 base arms).
  arms.push("rrf");

  // Per-arm aggregates: overall + 3 overlap bands.
  const overall = {}, byBand = {};
  for (const a of arms) { overall[a] = emptyAgg(); byBand[a] = { low: emptyAgg(), mid: emptyAgg(), high: emptyAgg() }; }

  // Band by FIXED lexical-overlap thresholds (not equal-count terciles): overlap is
  // discrete — many known-item queries share terms verbatim with their gold (overlap
  // ~1.0) — so value terciles collapse (a strict top-third split can leave a band
  // empty). Fixed bands stay interpretable ("how much of the query is literally in the
  // gold") and the low band is the one that matters: it's where dense/rerank should pay.
  const overlaps = queries.map((q) => lexicalOverlap(q.query, goldText.get(q.gold_id) || ""));
  const bandOf = (o) => (o <= 0.34 ? "low" : o <= 0.67 ? "mid" : "high");

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const band = bandOf(overlaps[i]);
    const lex = armLexicalIdf(corpus, q.query, dfInfo);
    const b25 = armBm25(corpus, q.query, bm);
    const ranks = { "lexical-idf": rankGold(lex, q.gold_id), "bm25-okapi": rankGold(b25, q.gold_id) };
    const rrfArms = [lex, b25]; // base arms to fuse; dense joins below when Ollama is up

    if (ollamaUp) {
      const qv = await embedText(q.query);
      const dense = armDense(corpus, qv, docVecs);
      const hybrid = armHybrid(lex, dense, ALPHA);
      ranks["nomic-dense"] = rankGold(dense, q.gold_id);
      ranks[`hybrid-a${ALPHA}`] = rankGold(hybrid, q.gold_id);
      rrfArms.push(dense);
      if (RERANKER_ENDPOINT) {
        // Rerank the top-20 hybrid candidates.
        const top = [...hybrid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
          .map(([id]) => ({ id, text: goldText.get(id) }));
        const rr = await crossEncoderRerank(q.query, top);
        ranks["hybrid+rerank"] = rr ? rankGold(rr, q.gold_id) : Infinity;
      }
    }
    ranks["rrf"] = rankGold(armRRF(rrfArms), q.gold_id);
    for (const a of arms) { accumulate(overall[a], ranks[a]); accumulate(byBand[a][band], ranks[a]); }
  }

  // ── report ──────────────────────────────────────────────────────────────────
  console.log("\n## Overall");
  const cols = ["n", "R@5", "R@10", "MRR@3", "MRR@10"];
  console.log(["arm".padEnd(16), ...cols.map((c) => c.padStart(8))].join(""));
  const rows = {};
  for (const a of arms) {
    const f = finalize(overall[a]); rows[a] = f;
    console.log([a.padEnd(16), ...cols.map((c) => String(c === "n" ? f[c] : f[c].toFixed(3)).padStart(8))].join(""));
  }
  const bandN = { low: byBand[arms[0]].low.n, mid: byBand[arms[0]].mid.n, high: byBand[arms[0]].high.n };
  console.log(`\n## By lexical-overlap band — R@5 (low is where dense/rerank should pay)` +
    `  [n: low=${bandN.low} mid=${bandN.mid} high=${bandN.high}]`);
  console.log(["arm".padEnd(16), "low".padStart(8), "mid".padStart(8), "high".padStart(8)].join(""));
  const bandRows = {};
  const fmtBand = (agg) => (agg.n === 0 ? "  n/a" : finalize(agg)["R@5"].toFixed(3)).padStart(8);
  for (const a of arms) {
    bandRows[a] = {
      low: byBand[a].low.n ? finalize(byBand[a].low)["R@5"] : null,
      mid: byBand[a].mid.n ? finalize(byBand[a].mid)["R@5"] : null,
      high: byBand[a].high.n ? finalize(byBand[a].high)["R@5"] : null,
    };
    console.log([a.padEnd(16), fmtBand(byBand[a].low), fmtBand(byBand[a].mid), fmtBand(byBand[a].high)].join(""));
  }

  // oracle-band-best — DIAGNOSTIC CEILING, NOT a deployable arm. Per band, the best SINGLE
  // base arm's R@5 (an oracle that already knows which arm wins each band). It bounds what any
  // real per-query router could reach and shows how much of RRF's lift is just "pick the right
  // arm per band." Never ship this or quote it as an achievable number.
  const singleArms = arms.filter((a) => a !== "rrf" && a !== "hybrid+rerank" && !a.startsWith("hybrid-a"));
  const oracleBandBest = {};
  for (const band of ["low", "mid", "high"]) {
    let best = null;
    for (const a of singleArms) {
      if (!byBand[a][band].n) continue;
      const r5 = finalize(byBand[a][band])["R@5"];
      if (best === null || r5 > best.r5) best = { arm: a, r5 };
    }
    oracleBandBest[band] = best;
  }
  console.log(`\n## oracle-band-best (DIAGNOSTIC CEILING — not deployable) — R@5`);
  console.log(["".padEnd(16), "low".padStart(13), "mid".padStart(13), "high".padStart(13)].join(""));
  console.log(["best-arm R@5".padEnd(16),
    ...["low", "mid", "high"].map((b) => (oracleBandBest[b] ? oracleBandBest[b].r5.toFixed(3) : "n/a").padStart(13))].join(""));
  console.log(["(which arm)".padEnd(16),
    ...["low", "mid", "high"].map((b) => (oracleBandBest[b] ? oracleBandBest[b].arm : "n/a").padStart(13))].join(""));

  if (skipped.length) {
    console.log("\n## Skipped arms (NOT silently dropped)");
    for (const s of skipped) console.log("  - " + s);
  }

  // ── append run row ────────────────────────────────────────────────────────────
  const row = {
    ts: new Date().toISOString(),
    corpus: usingFixture ? "fixture" : corpusPath,
    corpusDocs: corpus.length, queries: queries.length, alpha: ALPHA,
    ollama: ollamaUp, reranker: !!RERANKER_ENDPOINT,
    arms: rows, byBandR5: bandRows, rrfK: RRF_K,
    oracleBandBestR5: oracleBandBest, // DIAGNOSTIC CEILING, not deployable (see report note)
    skipped,
  };
  const runsLog = runsLogPath();
  fs.mkdirSync(path.dirname(runsLog), { recursive: true });
  fs.appendFileSync(runsLog, JSON.stringify(row) + "\n");
  console.log(`\nAppended run → ${path.relative(REPO_ROOT, runsLog)}`);
  return row;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  module.exports = { main, lexicalOverlap, armBm25, buildBm25, armLexicalIdf, armHybrid, armRRF, rankGold };
}
