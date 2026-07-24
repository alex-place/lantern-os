"use strict";

/**
 * arXiv full-text + full-abstract fetch for the universal research skill.
 *
 * The local corpus (scripts/arxiv_harvest.py) stores metadata + abstracts only; the
 * BM25 index (arxiv-index.js) returns a 400-char snippet. This module covers the two
 * "go deeper on ONE paper" moves that snippet-level retrieval can't:
 *
 *   readAbstractFromRaw(id)   — the FULL abstract (untruncated) + metadata, read
 *                               locally from raw\<YYYY-MM>.jsonl. No network.
 *   fetchArxivFullText(id)    — the ACTUAL report: fetch arxiv.org's HTML rendering
 *                               (LaTeX-derived, available for most 2023+ papers),
 *                               strip to plain text. On-demand, one paper at a time —
 *                               never bulk, never auto-injected into a research round.
 *
 * Fail-safe by design: every function resolves to a { ok:false, error } shape rather
 * than throwing, so a missing corpus / offline network / paper-without-HTML never
 * breaks a research turn. Dependency-free (Node global fetch + regex strip).
 */

const fs = require("fs");
const path = require("path");

const CORPUS_ROOT = process.env.ARXIV_CORPUS_DIR || "F:\\arxiv-corpus";
const RAW_DIR = path.join(CORPUS_ROOT, "raw");

// arxiv.org is polite about a descriptive UA; keep it identifiable.
const UA = "keystone-research/1.0 (+local arXiv grounding)";
const FETCH_TIMEOUT_MS = parseInt(process.env.ARXIV_FULLTEXT_TIMEOUT || "20000", 10);
const DEFAULT_MAX_CHARS = parseInt(process.env.ARXIV_FULLTEXT_MAX_CHARS || "60000", 10);

/**
 * Normalise a user-supplied id to the bare arXiv id (strip a version suffix, an
 * arxiv.org URL wrapper, or an "arXiv:" prefix). Returns "" if it doesn't look like
 * a modern YYMM.NNNNN id (pre-2007 ids aren't in this corpus anyway).
 */
function normalizeId(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return m ? m[1] : "";
}

/** id 2507.00002 -> raw shard "2025-07.jsonl" (YYMM prefix is authoritative). */
function shardForId(id) {
  const m = normalizeId(id).match(/^(\d{2})(\d{2})\./);
  if (!m) return null;
  return `20${m[1]}-${m[2]}.jsonl`;
}

/**
 * Read the full record (untruncated abstract + metadata) for one id straight out of
 * the local raw corpus. Only reads the single month shard the id belongs to, so it's
 * a cheap line scan, not a whole-corpus walk.
 * @returns {{ok:true, record:object} | {ok:false, error:string}}
 */
function readAbstractFromRaw(rawId) {
  const id = normalizeId(rawId);
  if (!id) return { ok: false, error: `not a modern arXiv id: ${rawId}` };
  const shard = shardForId(id);
  if (!shard) return { ok: false, error: `cannot map id to a corpus shard: ${id}` };
  const file = path.join(RAW_DIR, shard);
  if (!fs.existsSync(file)) return { ok: false, error: `corpus shard missing: ${shard}` };
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim() || !line.includes(id)) continue; // cheap prefilter before JSON.parse
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.id === id) return { ok: true, record: rec };
    }
    return { ok: false, error: `id not found in ${shard}: ${id}` };
  } catch (e) {
    return { ok: false, error: `read failed: ${e.message}` };
  }
}

async function _get(url, { accept = "text/html" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: accept },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { ok: true, status: res.status, text, url: res.url };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip an HTML document to readable plain text (drop script/style/nav chrome). */
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<(nav|footer|header|figure)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|section|h[1-6]|li|tr|br)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the handful of entities arXiv HTML actually emits.
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Fetch the ACTUAL report text for one paper. Tries arXiv's HTML rendering first
 * (clean, LaTeX-derived, no PDF parsing), then ar5iv as a fallback host. Never the
 * PDF binary — text extraction from PDF needs a heavy dep and arXiv HTML now covers
 * most modern papers. If neither HTML host has it, returns the pdf_url so the caller
 * can hand the user a direct link instead.
 *
 * @param {string} rawId
 * @param {{maxChars?:number}} [opts]
 * @returns {Promise<{ok:true, id, source, chars, text, truncated} | {ok:false, id, error, pdfUrl?}>}
 */
async function fetchArxivFullText(rawId, opts = {}) {
  const id = normalizeId(rawId);
  if (!id) return { ok: false, id: String(rawId), error: `not a modern arXiv id: ${rawId}` };
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const pdfUrl = `https://arxiv.org/pdf/${id}`;

  const hosts = [
    { name: "arxiv-html", url: `https://arxiv.org/html/${id}` },
    { name: "ar5iv", url: `https://ar5iv.org/abs/${id}` },
  ];
  for (const h of hosts) {
    const r = await _get(h.url);
    if (!r.ok) continue;
    const text = htmlToText(r.text);
    // arXiv serves a stub HTML page ("No HTML for this paper") ~a few hundred chars;
    // treat anything that short as a miss and fall through.
    if (text.length < 1500) continue;
    const truncated = text.length > maxChars;
    return {
      ok: true,
      id,
      source: h.name,
      url: h.url,
      chars: text.length,
      truncated,
      text: truncated ? `${text.slice(0, maxChars)}\n\n…[truncated at ${maxChars} chars — full paper at ${h.url}]` : text,
    };
  }
  return { ok: false, id, error: "no HTML rendering available for this paper", pdfUrl };
}

module.exports = {
  normalizeId,
  shardForId,
  readAbstractFromRaw,
  fetchArxivFullText,
  htmlToText,
  CORPUS_ROOT,
};
