#!/usr/bin/env node
"use strict";

/**
 * arxiv_query.js — command-line access to the local arXiv corpus for the /research
 * skill. Reuses the SAME code the chat assistant uses (apps/lantern-garage/lib):
 *   - BM25 search               -> lib/arxiv-index.js  queryArxiv()
 *   - full untruncated abstract -> lib/arxiv-fulltext.js readAbstractFromRaw()
 *   - the ACTUAL report text    -> lib/arxiv-fulltext.js fetchArxivFullText()
 *
 * No server required — reads the corpus on drive F: directly. Fail-safe: a missing
 * corpus prints an honest empty result rather than crashing.
 *
 * Usage:
 *   node scripts/arxiv_query.js "retrieval augmented generation"        # top-k metadata+abstract
 *   node scripts/arxiv_query.js "long context" -k 8 --json              # more hits, JSON out
 *   node scripts/arxiv_query.js "long context" --full                  # full (untruncated) abstracts
 *   node scripts/arxiv_query.js --paper 2507.00002                     # fetch the actual report text
 *   node scripts/arxiv_query.js --paper 2507.00002 --json              # same, as JSON
 */

const path = require("path");

const LIB = path.resolve(__dirname, "..", "apps", "lantern-garage", "lib");
const { queryArxiv, isAvailable } = require(path.join(LIB, "arxiv-index"));
const { readAbstractFromRaw, fetchArxivFullText, normalizeId } = require(path.join(LIB, "arxiv-fulltext"));

function parseArgs(argv) {
  const opts = { k: 5, json: false, full: false, paper: null, query: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--full") opts.full = true;
    else if (a === "-k" || a === "--k") { opts.k = parseInt(argv[++i], 10) || opts.k; }
    else if (a === "--paper" || a === "--id") { opts.paper = argv[++i]; }
    else opts.query.push(a);
  }
  opts.query = opts.query.join(" ").trim();
  return opts;
}

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --- Mode B: fetch one paper's full report text ------------------------------
  if (opts.paper) {
    const id = normalizeId(opts.paper);
    if (!id) die(`not a modern arXiv id: ${opts.paper}`);
    const meta = readAbstractFromRaw(id); // local metadata (best-effort)
    const res = await fetchArxivFullText(id);
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        id,
        metadata: meta.ok ? { title: meta.record.title, authors: meta.record.authors, published: meta.record.published, primary_category: meta.record.primary_category, abstract: meta.record.abstract, pdf_url: meta.record.pdf_url } : null,
        fulltext: res,
      }, null, 2) + "\n");
      return;
    }
    if (meta.ok) {
      const r = meta.record;
      process.stdout.write(`# ${r.title}\narXiv:${id}  ${r.primary_category || ""}  ${r.published || ""}\n${(r.authors || []).join ? (r.authors || []).join(", ") : (r.authors || "")}\n\n## Abstract\n${r.abstract || ""}\n\n`);
    } else {
      process.stdout.write(`# arXiv:${id}\n(local metadata not found: ${meta.error})\n\n`);
    }
    if (res.ok) {
      process.stdout.write(`## Full text (${res.source}, ${res.chars} chars${res.truncated ? ", truncated" : ""})\n${res.url}\n\n${res.text}\n`);
    } else {
      process.stdout.write(`## Full text unavailable\n${res.error}\n${res.pdfUrl ? `PDF: ${res.pdfUrl}\n` : ""}`);
    }
    return;
  }

  // --- Mode A: BM25 search over the corpus -------------------------------------
  if (!opts.query) {
    die("usage: node scripts/arxiv_query.js \"<query>\" [-k N] [--full] [--json]\n"
      + "       node scripts/arxiv_query.js --paper <arxivId> [--json]");
  }
  if (!isAvailable()) {
    if (opts.json) { process.stdout.write(JSON.stringify({ available: false, results: [] }, null, 2) + "\n"); return; }
    die("local arXiv index not available (run scripts/arxiv_build_index.py); check ARXIV_CORPUS_DIR", 2);
  }

  const hits = queryArxiv(opts.query, opts.k) || [];
  const results = hits.map((p) => {
    let abstract = p.snippet;
    if (opts.full) {
      const full = readAbstractFromRaw(p.id);
      if (full.ok && full.record.abstract) abstract = full.record.abstract;
    }
    return { id: p.id, title: p.title, published: p.published, primary_category: p.primary_category, url: p.url, abstract };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ available: true, query: opts.query, count: results.length, results }, null, 2) + "\n");
    return;
  }

  if (!results.length) {
    process.stdout.write(`No local papers matched "${opts.query}" (corpus is AI/ML abstracts, 2025-07 onward).\n`);
    return;
  }
  process.stdout.write(`Top ${results.length} local arXiv papers for "${opts.query}":\n\n`);
  for (const r of results) {
    process.stdout.write(`• ${r.title}\n  arXiv:${r.id}  ${r.primary_category || ""}  ${r.published || ""}\n  ${r.url}\n  ${r.abstract}\n\n`);
  }
}

main().catch((e) => die(`arxiv_query failed: ${e.stack || e.message}`));
