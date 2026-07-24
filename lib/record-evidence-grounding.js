"use strict";
// #2844 — evidence-ground a ConvergenceRecord against real literature (arXiv BM25 + worldwide
// patents), as an INVENTOR: attach cited external evidence + a corroboration score, and CAP
// confidence where reality offers ZERO external support (marking the claim for review). This is
// the External Reality Rule applied outward — a claim the outside world doesn't corroborate is
// not trusted at face value.
//
// Retrievers are injectable; the defaults are the live arxiv-index / patent-index, both of which
// fail-safe to [] when their corpus isn't mounted (arXiv → F:/arxiv-corpus, patents → the EPO OPS
// harvest). So on a box without the corpus, EVERY record is conservatively capped + flagged —
// never silently trusted. Persisted fields stay within the locked ConvergenceRecord schema
// (grounding_signals gets the citation ids; allowed_max_confidence gets the ceiling); the
// citation objects + corroboration score + review flag are returned as report metadata.
// Pure over one record; never throws.

const NO_SUPPORT_CEILING = 0.5; // zero external corroboration → confidence ceiling
const DEFAULT_K = 3;

function _defaultArxiv() {
  try { return require("./arxiv-index").queryArxiv; } catch { return () => []; }
}
function _defaultPatent() {
  try { return require("./patent-index").queryPatents; } catch { return () => []; }
}

function _cite(source, h) {
  const id = h && (h.id || h.pub || h.arxiv_id);
  if (!id) return null;
  return { source, id: String(id), title: h && h.title ? String(h.title) : null,
           url: h && h.url ? String(h.url) : null, published: h && h.published ? String(h.published) : null };
}

/**
 * Ground one ConvergenceRecord in external literature. Returns a NEW record with:
 *   - grounding_signals: existing ids + "arxiv:<id>" / "patent:<id>" (in-schema field)
 *   - allowed_max_confidence: capped to NO_SUPPORT_CEILING when corroboration == 0
 *   - confidence: clamped to the ceiling so a capped record can't over-state
 *   - evidence_citations: [{source, id, title, url, published}]   (report metadata)
 *   - corroboration_score: count of external corroborating docs    (report metadata)
 *   - needs_review: true when zero external support                (report metadata)
 * Best-effort: any retriever error is treated as no hits (conservative).
 *
 * @param {object} record  a ConvergenceRecord (see convergence-records.js)
 * @param {object} [opts]  { arxivQuery, patentQuery, k }
 */
async function groundRecordEvidence(record, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const claim = String(record.hypothesis == null ? "" : record.hypothesis).trim();
  if (!claim) return record;

  const k = opts.k || DEFAULT_K;
  const arxiv = opts.arxivQuery || _defaultArxiv();
  const patent = opts.patentQuery || _defaultPatent();

  let aHits = [];
  let pHits = [];
  try { aHits = (await arxiv(claim, k)) || []; } catch { aHits = []; }
  try { pHits = (await patent(claim, k)) || []; } catch { pHits = []; }

  const citations = [
    ...aHits.map((h) => _cite("arxiv", h)),
    ...pHits.map((h) => _cite("patent", h)),
  ].filter(Boolean);
  const corroboration = citations.length;

  const prevSignals = Array.isArray(record.grounding_signals) ? record.grounding_signals.map(String) : [];
  const grounding_signals = [...prevSignals, ...citations.map((c) => `${c.source}:${c.id}`)];

  let allowed_max_confidence = record.allowed_max_confidence == null ? null : Number(record.allowed_max_confidence);
  let needs_review = Boolean(record.needs_review);
  if (corroboration === 0) {
    allowed_max_confidence = allowed_max_confidence == null
      ? NO_SUPPORT_CEILING
      : Math.min(allowed_max_confidence, NO_SUPPORT_CEILING);
    needs_review = true;
  }
  const confidence = allowed_max_confidence == null
    ? record.confidence
    : Math.min(Number(record.confidence) || 0, allowed_max_confidence);

  return {
    ...record,
    confidence,
    allowed_max_confidence,
    grounding_signals,
    evidence_citations: citations,
    corroboration_score: corroboration,
    needs_review,
  };
}

module.exports = { groundRecordEvidence, NO_SUPPORT_CEILING, DEFAULT_K };
