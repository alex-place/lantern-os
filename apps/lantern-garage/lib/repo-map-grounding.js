"use strict";
/**
 * Wires lib/repo-map.js's PageRank/symbol-graph selection into the live Keystone
 * kernel's GROUND phase (#1409 acceptance: "the coding path consumes it").
 *
 * repo-context.js's searchRepoFiles() already does keyword+symbol matching over the
 * WHOLE repo — that stays as-is (proven, live, not touched here). What it's missing
 * is the graph-CENTRALITY signal repo-map.js adds: a file heavily depended-on by
 * other relevant files, even with a weak direct keyword match, is more likely to be
 * load-bearing context. This module ADDS repo-map's top picks to whatever
 * searchRepoFiles already found — additive only, so it can only supplement grounding,
 * never remove a file the existing search already surfaced.
 *
 * Scoped to apps/lantern-garage (repo-map's own stated v1 limit — see repo-map.js's
 * docstring) rather than the whole monorepo: building the symbol graph means reading
 * every .js file under the root, and the whole-repo tree (docs/, experiments/,
 * src/ Python, node_modules) is both irrelevant to a JS kernel run and too slow to
 * walk on every GROUND phase. Cached with a TTL so repeated kernel runs in the same
 * session don't rebuild the graph from scratch each time (mirrors repo-context.js's
 * own SYMBOL_INDEX_TTL pattern).
 */
const path = require("path");
const { buildGraph, selectContext, buildEvidencePacket } = require("./repo-map");

const GRAPH_TTL_MS = 5 * 60_000;
let _cache = null; // { ts, root, graph }

function _cachedGraph(scanRoot) {
  if (_cache && _cache.root === scanRoot && Date.now() - _cache.ts < GRAPH_TTL_MS) {
    return _cache.graph;
  }
  const graph = buildGraph(scanRoot);
  _cache = { ts: Date.now(), root: scanRoot, graph };
  return graph;
}

/**
 * Build a repo-map evidence packet for a task string. Best-effort: any internal
 * failure (unreadable dir, empty repo) returns an empty-but-valid packet rather than
 * throwing, so a caller on the live serving path never has to guard this specially.
 *
 * Path namespace: repo-map.js reports paths relative to whatever root it scanned
 * (apps/lantern-garage here), but searchRepoFiles()/readFileContent() in
 * repo-context.js — and everything downstream that consumes this packet — expect
 * paths relative to the overall REPO ROOT (matching `git ls-files`). Rewrite every
 * file path to that shared namespace so a repo-map pick and a searchRepoFiles pick
 * of the SAME file dedupe correctly, and so a repo-map-only pick can actually be
 * read by readFileContent() instead of resolving to the wrong file or failing.
 */
const SCAN_SUBDIR = path.join("apps", "lantern-garage");

function buildRepoMapEvidence(query, repoRoot, opts = {}) {
  const scanRoot = path.join(repoRoot, SCAN_SUBDIR);
  try {
    const graph = _cachedGraph(scanRoot);
    const selected = selectContext(graph, query, { limit: opts.limit || 8 });
    const packet = buildEvidencePacket(query, selected);
    packet.files.forEach((f) => { f.path = `${SCAN_SUBDIR.replace(/\\/g, "/")}/${f.path}`; });
    return packet;
  } catch (_e) {
    return buildEvidencePacket(query, []);
  }
}

/**
 * Merge repo-map's evidence-packet files into searchRepoFiles()'s existing results.
 * Pure function — additive only: every existing result is kept as-is and in its
 * original relative order; repo-map files not already present are appended (their
 * own score, so they still sort behind any stronger existing match), capped at
 * maxFiles total. Never removes or re-scores an existing entry.
 */
function mergeGroundingResults(searchResults, evidencePacket, maxFiles) {
  const existing = new Set((searchResults || []).map((r) => r.path));
  const merged = (searchResults || []).slice();
  for (const f of (evidencePacket && evidencePacket.files) || []) {
    if (merged.length >= maxFiles) break;
    if (existing.has(f.path)) continue;
    existing.add(f.path);
    merged.push({ path: f.path, score: f.score, fromRepoMap: true, reason: f.reason });
  }
  return merged.slice(0, maxFiles);
}

/**
 * Context precision (#1409 acceptance: "selected-and-used vs selected-and-unused").
 * selectedPaths: every file the evidence packet named as relevant.
 * usedPaths: files the landed patch actually touched (keystone-runtime's targetsOf()).
 * Precision is undefined (null) when nothing was selected — avoids a fabricated 0/0.
 */
function computeContextPrecision(selectedPaths, usedPaths) {
  const selected = new Set(selectedPaths || []);
  const used = new Set(usedPaths || []);
  let selectedAndUsed = 0;
  for (const p of selected) if (used.has(p)) selectedAndUsed++;
  const selectedAndUnused = selected.size - selectedAndUsed;
  return {
    selected: selected.size,
    selectedAndUsed,
    selectedAndUnused,
    precision: selected.size > 0 ? selectedAndUsed / selected.size : null,
  };
}

module.exports = { buildRepoMapEvidence, mergeGroundingResults, computeContextPrecision };
