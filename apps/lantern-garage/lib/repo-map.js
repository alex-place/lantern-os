"use strict";
/**
 * Local repo-map: a symbol-graph over source files, ranked for a task query, emitted as a
 * serialized evidence packet (#1409, Remember/Reason — context assembly).
 *
 * Aider-style idea (files = nodes, requires = edges, PageRank-style centrality), scoped down
 * for a v1: regex-based symbol/require extraction (no new AST-parser dependency), scoped by
 * default to apps/lantern-garage/{lib,routes} (the most actively-touched area) rather than the
 * whole repo. Both are deliberate, stated v1 limits, not hidden gaps — pass `roots`/`exts` to
 * widen scope; a real AST parser is the natural v2 upgrade for symbol-extraction fidelity.
 *
 * NOT YET WIRED into the live coding path — this ships the core module (extraction, ranking,
 * evidence packet) as a standalone, tested unit. Consuming it from dream-chat/stream-chat's
 * tool-calling loop is real, separate integration work.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_EXTS = new Set([".js"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "vendor", "dist", "build"]);

// Regex-based symbol extraction — deliberately simple (no AST). Catches the common JS
// declaration shapes; misses destructured/dynamic exports and non-standard patterns.
const SYMBOL_PATTERNS = [
  { kind: "function", re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
  { kind: "const-fn", re: /^\s*(?:exports\.)?(?:module\.exports\.)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm },
  { kind: "class", re: /^\s*class\s+([A-Za-z_$][\w$]*)/gm },
];
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

function walkSourceFiles(root, { exts = DEFAULT_EXTS } = {}) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.has(path.extname(e.name))) out.push(full);
    }
  })(root);
  return out;
}

function extractSymbols(content) {
  const symbols = [];
  for (const { kind, re } of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) symbols.push({ name: m[1], kind });
  }
  return symbols;
}

function extractRequires(content) {
  const reqs = [];
  REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_RE.exec(content))) if (m[1].startsWith(".")) reqs.push(m[1]);
  return reqs;
}

// Build the graph: one node per file (path, symbols), edges from require() resolution.
// Unresolvable requires (missing file, non-.js target) are dropped silently — a repo-map is
// best-effort context assembly, not a build tool; a dangling edge would only pollute ranking.
function buildGraph(root, { exts = DEFAULT_EXTS } = {}) {
  const files = walkSourceFiles(root, { exts });
  const nodes = new Map(); // absPath -> { file, rel, symbols, requires: [] }
  for (const file of files) {
    let content = "";
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    nodes.set(file, {
      file, rel: path.relative(root, file).replace(/\\/g, "/"),
      symbols: extractSymbols(content), requires: [],
    });
  }
  const edges = []; // {from, to} absolute paths
  for (const [file, node] of nodes) {
    const dir = path.dirname(file);
    for (const req of extractRequires(fs.readFileSync(file, "utf8"))) {
      for (const cand of [req, `${req}.js`, path.join(req, "index.js")]) {
        const resolved = path.resolve(dir, cand);
        if (nodes.has(resolved)) { node.requires.push(resolved); edges.push({ from: file, to: resolved }); break; }
      }
    }
  }
  return { nodes, edges };
}

// Simple PageRank (power iteration), damping 0.85, over the require-graph. A file required by
// many important files ranks higher — the "this is load-bearing" signal, independent of query.
function pageRank({ nodes, edges }, { damping = 0.85, iterations = 30 } = {}) {
  const ids = [...nodes.keys()];
  const n = ids.length;
  if (!n) return new Map();
  const idx = new Map(ids.map((id, i) => [id, i]));
  const outDegree = new Array(n).fill(0);
  const inEdges = Array.from({ length: n }, () => []);
  for (const { from, to } of edges) {
    const fi = idx.get(from), ti = idx.get(to);
    if (fi == null || ti == null) continue;
    outDegree[fi]++;
    inEdges[ti].push(fi);
  }
  let ranks = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill((1 - damping) / n);
    // Dangling mass (nodes with no outgoing edges) redistributed evenly — standard PageRank
    // fix so total rank mass is conserved instead of leaking out of the graph.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outDegree[i] === 0) dangling += ranks[i];
    for (let i = 0; i < n; i++) next[i] += damping * dangling / n;
    for (let i = 0; i < n; i++) {
      for (const j of inEdges[i]) next[i] += damping * (ranks[j] / outDegree[j]);
    }
    ranks = next;
  }
  const out = new Map();
  ids.forEach((id, i) => out.set(id, ranks[i]));
  return out;
}

const STOP = new Set("the a an is are was were of to in on at for with by from and or this that".split(" "));
function queryTerms(q) {
  return new Set(String(q || "").toLowerCase().split(/[^a-z0-9_$]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

// Relevance: fraction of query terms matched by this file's path or symbol names.
function _relevance(node, terms) {
  if (!terms.size) return 0;
  const hay = new Set();
  for (const w of node.rel.toLowerCase().split(/[^a-z0-9_$]+/)) hay.add(w);
  // Split on case FIRST (processRefund -> "process","Refund"), THEN lowercase each piece —
  // lowercasing before the split erases every capital letter the regex needs to find.
  for (const s of node.symbols) for (const w of s.name.split(/(?=[A-Z])|_/)) if (w) hay.add(w.toLowerCase());
  let hits = 0;
  const matched = [];
  for (const t of terms) if (hay.has(t)) { hits++; matched.push(t); }
  return { score: hits / terms.size, matched };
}

/**
 * Rank files for a task query. Relevance ALWAYS dominates centrality — a file that actually
 * matches the query outranks every non-matching file, however load-bearing the latter is;
 * centrality only breaks ties (among relevant files, and among the irrelevant fallback set,
 * where the most-central files still surface as likely-needed infrastructure, ranked strictly
 * below every direct match). A naive linear blend of the two independently-normalized scores
 * lets a hub file with zero relevance outrank a peripheral file that's actually on-topic —
 * caught by this module's own tests (test_repo_map.js) before it shipped; a two-band score
 * keeps that impossible by construction. Returns the top `limit` files, matched symbols, and
 * why each was selected.
 */
function selectContext(graph, query, { limit = 8, centralityTiebreak = 0.2 } = {}) {
  const ranks = pageRank(graph);
  const maxRank = Math.max(...ranks.values(), 1e-9);
  const terms = queryTerms(query);
  const scored = [];
  for (const node of graph.nodes.values()) {
    const rel = _relevance(node, terms);
    const centrality = (ranks.get(node.file) || 0) / maxRank;
    const score = rel.score > 0
      ? 1 + rel.score + centralityTiebreak * centrality   // relevant band: strictly > 1
      : centralityTiebreak * centrality;                    // fallback band: <= centralityTiebreak
    if (rel.score > 0 || centrality > 0) {
      scored.push({ node, score, relevance: rel.score, centrality, matchedTerms: rel.matched || [] });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Serialize a selectContext() result into the evidence packet #1409 asks for. */
function buildEvidencePacket(query, selected) {
  return {
    query: String(query || ""),
    generatedAt: new Date().toISOString(),
    files: selected.map((s) => ({
      path: s.node.rel,
      score: Math.round(s.score * 1000) / 1000,
      relevance: Math.round(s.relevance * 1000) / 1000,
      centrality: Math.round(s.centrality * 1000) / 1000,
      matchedTerms: s.matchedTerms,
      symbols: s.node.symbols.map((sym) => sym.name),
      reason: s.matchedTerms.length
        ? `query terms [${s.matchedTerms.join(", ")}] matched path/symbols`
        : "selected for graph centrality (load-bearing dependency), no direct term match",
    })),
  };
}

module.exports = {
  walkSourceFiles, extractSymbols, extractRequires, buildGraph, pageRank,
  queryTerms, selectContext, buildEvidencePacket,
};
