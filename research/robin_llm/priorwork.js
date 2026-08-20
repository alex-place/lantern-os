"use strict";
// What THIS repo has already measured -- the prior-art source nothing else has.
//
// The 2026-08-20 red team of the first bench lists found that two of four "worth starting"
// recommendations were already answered inside this repository, and a third was refuted here:
//   probe on activations        -> probe_ladder.py had it at 0.837/0.980/1.000 by scale
//   cross-layer activation norm -> ouro_canary_vs_logprob.py had canary_hnorm at AUROC 0.519
//   rerank + self-consistency   -> scripts/humaneval_rerank.py already does exactly that
// None of that is on arXiv and no web search will surface it. An idea mill that does not read its
// own lab notebook will keep proposing experiments the lab has already run.
//
// This indexes the notebook: every experiment script, research note, ADR, and result file, by its
// own first paragraph, with BM25 (same parameters as the arXiv index so scores are comparable).
// Result files are indexed too, so a hit can carry the number the experiment actually produced.
//
// Cheap: ~400 documents, read once per process, no network.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCES = [
  { dir: "experiments", ext: ".py", kind: "experiment" },
  { dir: "research/epistemic_controller", ext: ".py", kind: "experiment" },
  // research/robin_llm itself is deliberately NOT indexed: this mill is not a measurement,
  // and its own docstrings describe the red-team findings, so it surfaced as "prior work" for
  // the very ideas those findings were about.
  { dir: "docs/research", ext: ".md", kind: "note" },
  { dir: "docs/adr", ext: ".md", kind: "decision" },
  { dir: "scripts", ext: ".py", kind: "harness" },
];
const RESULT_DIRS = ["experiments/results", "data/eval", "research/epistemic_controller/results"];

const K1 = 1.5, B = 0.75;
let _index = null;

// Crude suffix stripping, because exact matching missed the two hits that mattered most in the
// red team: "rerank" did not match "reranking" (scripts/humaneval_rerank.py) and "activation" did
// not match "activations". A real stemmer is overkill for 400 documents; this is enough to stop
// a plural costing us a prior-art hit, which is the failure that matters here.
function stem(w) {
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ers", "er", "ed", "es", "s"]) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

function tokenize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && w.length < 30).map(stem);
}

// The first paragraph of a python docstring / the first prose of a markdown file. That is where
// these files say what question they answer, by convention throughout this repo.
function head(text, kind) {
  const t = String(text);
  if (kind === "note" || kind === "decision") {
    const body = t.replace(/^---[\s\S]*?---\s*/, "");         // front matter
    return body.slice(0, 1400);
  }
  const m = t.match(/^[\s\S]{0,200}?(?:r?"""|r?''')([\s\S]{0,1400}?)(?:"""|''')/);
  if (m) return m[1];
  return t.split(/\n/).filter((l) => l.trim().startsWith("//")).slice(0, 20).join("\n").slice(0, 1400);
}

function titleOf(snippet, file) {
  for (const line of String(snippet).split(/\n/)) {
    const s = line.replace(/^#+\s*/, "").trim();
    if (s.length > 12) return s.slice(0, 160);
  }
  return path.basename(file);
}

function walk(dir, ext, out, depth = 0) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs) || depth > 2) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, ext, out, depth + 1);
    else if (e.name.endsWith(ext)) out.push(rel);
  }
}

// A result file's own verdict, if it states one. This is what turns "we looked at that" into
// "we looked at that and here is the number", which is the difference between a hint and evidence.
function verdictOf(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const k of ["verdict", "VERDICT", "primary_finding", "evidence_class"]) {
    if (typeof obj[k] === "string" && obj[k].length > 8) return obj[k].slice(0, 300);
  }
  for (const v of Object.values(obj)) {
    const r = verdictOf(v, depth + 1);
    if (r) return r;
  }
  return null;
}

function build() {
  const docs = [];
  for (const s of SOURCES) {
    const files = [];
    walk(s.dir, s.ext, files);
    for (const f of files) {
      let text = "";
      try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
      const snippet = head(text, s.kind);
      if (snippet.trim().length < 60) continue;               // no stated question: nothing to match on
      docs.push({ file: f, kind: s.kind, title: titleOf(snippet, f), snippet: snippet.trim() });
    }
  }
  for (const dir of RESULT_DIRS) {
    const files = [];
    walk(dir, ".json", files);
    for (const f of files) {
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { continue; }
      const v = verdictOf(obj);
      if (!v) continue;
      // Index the key NAMES as well as the verdict: a result file's value here is that it
      // contains "canary_hnorm" and "auroc", which is what an idea about activation norms should
      // match on. The verdict string alone ("MEASURED") matches nothing.
      // DEDUPED and length-filtered. A result file with one entry per arm per seed repeats the
      // same key hundreds of times; indexed raw, its term frequency swamps every real match and
      // it becomes a magnet for any query (measured: world_s.json outranked the correct hit on
      // an activation-norm query). A key is evidence that the file MENTIONS something, once.
      const keys = new Set();
      (function collect(o, d) {
        if (!o || typeof o !== "object" || d > 3 || keys.size > 150) return;
        for (const [k, val] of Object.entries(o)) {
          if (k.length >= 5) keys.add(k);
          collect(val, d + 1);
        }
      })(obj, 0);
      docs.push({ file: f, kind: "result", title: path.basename(f, ".json").replace(/[_-]/g, " "),
                  snippet: `${v}\n${Array.from(keys).join(" ")}`, verdict: v });
    }
  }
  const N = docs.length;
  const postings = new Map();
  let total = 0;
  docs.forEach((d, i) => {
    const terms = tokenize(`${d.title} ${d.snippet}`);
    d.len = terms.length;
    total += terms.length;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([i, c]);
    }
  });
  return { docs, postings, N, avgdl: total / Math.max(1, N) };
}

function index() {
  if (!_index) _index = build();
  return _index;
}

// Below this BM25 score a hit is noise, and reporting noise as prior work is the same error as
// reporting silence as novelty. Calibrated on the red-team cases: the true matches scored 12-17,
// the unrelated top hits 9-10.
const FLOOR = 11;

function search(query, k = 5, floor = FLOOR) {
  const idx = index();
  const scores = new Map();
  for (const term of new Set(tokenize(query))) {
    const pl = idx.postings.get(term);
    if (!pl) continue;
    const idf = Math.log(1 + (idx.N - pl.length + 0.5) / (pl.length + 0.5));
    for (const [i, tf] of pl) {
      // Short documents get a large BM25 boost, and a result file indexed by its key names
      // is short. Measured: world_s.json outscored the correct experiment on three
      // unrelated queries purely because it is brief and shares one rare token. Floor the
      // length used for normalisation so brevity alone cannot win.
      const dl = Math.max(idx.docs[i].len || idx.avgdl, idx.avgdl * 0.5);
      scores.set(i, (scores.get(i) || 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / idx.avgdl))));
    }
  }
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score >= floor).slice(0, k)
    .map(([i, score]) => ({ ...idx.docs[i], score: Number(score.toFixed(2)) }));
}

function stats() {
  const idx = index();
  const byKind = {};
  for (const d of idx.docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  return { documents: idx.N, terms: idx.postings.size, byKind };
}

module.exports = { search, stats, tokenize, stem, FLOOR, ROOT };
