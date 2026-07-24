"use strict";

/**
 * M1 No-Free-Confidence — the ENFORCED runtime gate (#2872; audited-candidate form
 * promoted ✓ ~70% in #2860; replay instrument ran clean 0 free rises / 48 pairs on
 * history, #2786 2026-07-22).
 *
 * Invariant (R3, SIGMA0-COLLAPSE-CERTIFICATE.md): a claim-chain's recorded
 * confidence may RISE between consecutive ledger entries ONLY IF the evidence
 * basis changed in between. This module applies that invariant PROSPECTIVELY, on
 * every outgoing ledger row, mirroring experiments/v1_10_toy/m1_ledger_check.py
 * exactly (same claim normalization, same evidence fingerprint) so the replay
 * instrument and the live gate can never disagree about what a violation is.
 *
 * Enforcement is CLAMP-AND-RECEIPT, not block: the append-only ledger ethos
 * survives (nothing is dropped), but the free rise does not — confidence caps at
 * the chain's prior value and the clamp itself is receipted on the row
 * (`m1_clamped`), so the canary/auditors can count attempts. Never throws: a gate
 * failure must never break a chat reply (returns the row unchanged).
 */

const crypto = require("crypto");
const fs = require("fs");

const _sha16 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Chain key — mirrors m1_ledger_check.norm_claim (lowercased, alnum-collapsed, sha1/16). */
function normClaim(text) {
  return _sha16(String(text == null ? "" : text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
}

/**
 * Cheap fingerprint of a row's evidence basis — mirrors m1_ledger_check.evidence_key
 * (sources|source + evidence[:400]); hypothesis-shaped rows additionally fold
 * evidence_ids + verified_by (their evidence carriers) into the sorted source set.
 */
function evidenceKey(rec) {
  const src = Array.isArray(rec.sources) && rec.sources.length ? rec.sources : rec.source ? [rec.source] : [];
  const extra = []
    .concat(Array.isArray(rec.evidence_ids) ? rec.evidence_ids : [])
    .concat(Array.isArray(rec.verified_by) ? rec.verified_by : []);
  const ev = String(rec.evidence == null ? "" : rec.evidence).slice(0, 400);
  return _sha16(src.concat(extra).map(String).sort().join("|") + "###" + ev);
}

const _keyOf = (rec) => (rec && (rec.claim || rec.hypothesis) ? normClaim(rec.claim || rec.hypothesis) : null);

// Last {confidence, evidenceKey, ts} per chain: a file index (mtime+size cached)
// merged with the in-process tail, so same-batch pairs are gated without a re-read
// and rows written by OTHER processes are seen on the next stat change. When both
// exist, the newer timestamp wins (the file may have moved past our memory).
let _fileCache = null;
const _memLast = new Map();

function _fileLast(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* absent ledger → empty index */
  }
  const sig = stat ? `${file}|${stat.mtimeMs}|${stat.size}` : `${file}|absent`;
  if (_fileCache && _fileCache.sig === sig) return _fileCache.last;
  const last = new Map();
  if (stat) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // tolerate a torn tail line
      }
      const k = _keyOf(r);
      if (k) last.set(k, { confidence: Number(r.confidence) || 0, evidenceKey: evidenceKey(r), ts: String(r.timestamp || "") });
    }
  }
  _fileCache = { sig, last };
  return last;
}

function _latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return String(a.ts || "") >= String(b.ts || "") ? a : b;
}

/**
 * Gate one outgoing ledger row. Returns the row unchanged, or a shallow copy with
 * `confidence` clamped to the chain's prior value plus an `m1_clamped` receipt,
 * when the row would be a free rise (higher confidence, identical evidence
 * fingerprint). Falls, flats, first sightings, and evidence-backed rises pass.
 */
function applyM1Gate(rec, { file } = {}) {
  try {
    const k = _keyOf(rec);
    if (!k || !file) return rec;
    const prior = _latest(_memLast.get(k), _fileLast(file).get(k));
    const ek = evidenceKey(rec);
    const conf = Number(rec.confidence) || 0;
    let out = rec;
    if (prior && conf > prior.confidence + 1e-9 && ek === prior.evidenceKey) {
      out = {
        ...rec,
        confidence: prior.confidence,
        m1_clamped: { from: conf, to: prior.confidence, reason: "no-new-evidence", gate: "#2872" },
      };
      console.warn(
        `[m1-gate] free confidence rise clamped ${conf} -> ${prior.confidence}: "${String(rec.claim || rec.hypothesis).slice(0, 60)}"`,
      );
    }
    _memLast.set(k, { confidence: Number(out.confidence) || 0, evidenceKey: ek, ts: String(out.timestamp || "") || new Date().toISOString() });
    return out;
  } catch (e) {
    console.error("[m1-gate] non-fatal:", e && e.message);
    return rec;
  }
}

/** Test hook: drop all cached state so each test starts from the file alone. */
function _resetForTests() {
  _fileCache = null;
  _memLast.clear();
}

module.exports = { applyM1Gate, normClaim, evidenceKey, _resetForTests };
