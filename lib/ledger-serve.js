"use strict";

/**
 * Serve-from-ledger (#2859 item 1) — the deterministic answer path.
 *
 * Operator directive (2026-07-22): Σ₀ must be deterministic from the outside — the
 * answer is a function of (question, verified knowledge), never of the sampling
 * path. When a question maps to converged ConvergenceRecords, the answer is those
 * records VERBATIM + provenance, not a regeneration (regeneration is where
 * variance leaks). Re-asking is not re-rolling: answers change only on new
 * evidence, with a receipt.
 *
 * Guardrail honored (stream-chat.js ~L2032, the #1778 scar): this is NOT the
 * banned retrieval short-circuit. That served TF-IDF DOC CHUNKS as answers —
 * keyword matching with no comprehension. This serves MODEL-GENERATED, converged,
 * non-refuted claims (exactly the "cache MODEL-generated answers, not doc chunks"
 * path that comment blesses), matched by EXACT normalized question — no fuzzy
 * scoring, no partial hits, a miss is a miss.
 *
 * Chat wiring is deliberately NOT in this module's first landing: the serve path
 * + stability canary ship and measure first; the stream-chat flip is its own
 * reviewed change (see #2859).
 */

const crypto = require("crypto");
const fs = require("fs");

const { RECORDS_PATH } = require("./convergence-records");

/** Deterministic question key: case/whitespace/terminal-punctuation insensitive. */
function normalizeQuestion(q) {
  return String(q == null ? "" : q)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?!.\s]+$/, "");
}

/** Parse the JSONL ledger, tolerating bad lines (append-only files get truncated tails). */
function readLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* tolerate a torn tail line */
    }
  }
  return rows;
}

/**
 * Build the question → converged-claims index from ledger rows.
 *
 * A chat turn emits one row PER CLAIM (all sharing the turn's `userMessage`), so a
 * served answer is the AGGREGATE of that question's surviving claims. Gates: the
 * row must carry a claim + userMessage, not be refuted or corrected, and clear
 * `minConfidence` (converged, not merely uttered). Identical claim texts dedupe to
 * their latest instance. Claims sort by (timestamp, text) so the served answer is
 * byte-stable regardless of file row order.
 */
function buildIndex(rows, { minConfidence = 0.8 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (!r.userMessage || !r.claim) continue;
    if (r.refuted === true || r.corrected === true) continue;
    if (!(Number(r.confidence) >= minConfidence)) continue;
    const key = normalizeQuestion(r.userMessage);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, question: String(r.userMessage), claims: new Map() });
    const bucket = byKey.get(key);
    const prev = bucket.claims.get(r.claim);
    if (!prev || String(r.timestamp || "") > String(prev.timestamp || "")) bucket.claims.set(r.claim, r);
  }
  const index = new Map();
  for (const [key, b] of byKey) {
    const claims = [...b.claims.values()].sort(
      (a, z) => String(a.timestamp || "").localeCompare(String(z.timestamp || "")) || String(a.claim).localeCompare(String(z.claim)),
    );
    index.set(key, { key, question: b.question, claims });
  }
  return index;
}

// mtime+size cached index so a hot chat path doesn't re-parse per message.
let _cache = null;
function loadIndex({ file = RECORDS_PATH, minConfidence = 0.8, force = false } = {}) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* absent ledger → empty index */
  }
  const sig = stat ? `${file}|${stat.mtimeMs}|${stat.size}|${minConfidence}` : `${file}|absent|${minConfidence}`;
  if (!force && _cache && _cache.sig === sig) return _cache.index;
  const index = buildIndex(readLedger(file), { minConfidence });
  _cache = { sig, index };
  return index;
}

/** Stable identity of a served answer's evidence (the canary's receipt hash). */
function recordHash(entry) {
  const basis = entry.claims.map((c) => [c.claim, c.timestamp || "", c.confidence, c.source || ""]);
  return crypto.createHash("sha1").update(JSON.stringify([entry.key, basis])).digest("hex");
}

/**
 * The deterministic serve path. Exact-normalized-key lookup; a miss returns null
 * (the caller regenerates as today — this path never guesses).
 *
 * @returns null | {
 *   servedFromLedger:true, key, question, answer, claims,
 *   provenance: { recordCount, asOf, minConfidence, maxConfidence, sources },
 *   answerHash, recordHash
 * }
 */
function serveFromLedger(question, { file = RECORDS_PATH, minConfidence = 0.8, force = false } = {}) {
  const key = normalizeQuestion(question);
  if (!key) return null;
  const entry = loadIndex({ file, minConfidence, force }).get(key);
  if (!entry || !entry.claims.length) return null;
  const answer = entry.claims.map((c) => c.claim).join("\n");
  const confs = entry.claims.map((c) => Number(c.confidence) || 0);
  const sources = [...new Set(entry.claims.map((c) => c.source).filter(Boolean))].sort();
  return {
    servedFromLedger: true,
    key,
    question: entry.question,
    answer,
    claims: entry.claims,
    provenance: {
      recordCount: entry.claims.length,
      asOf: entry.claims.reduce((m, c) => (String(c.timestamp || "") > m ? String(c.timestamp) : m), ""),
      minConfidence: Math.min(...confs),
      maxConfidence: Math.max(...confs),
      sources,
    },
    answerHash: crypto.createHash("sha1").update(answer).digest("hex"),
    recordHash: recordHash(entry),
  };
}

module.exports = { normalizeQuestion, readLedger, buildIndex, loadIndex, serveFromLedger, RECORDS_PATH };
