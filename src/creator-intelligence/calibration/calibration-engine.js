// Creator Intelligence — calibration engine
// Joins first-party analytics OUTCOMES to the measured FEATURES of the clip they
// came from, then reports — honestly — whether our structural signals actually
// predict real performance. This is the bridge the V10 scorer has been waiting
// on: it is what eventually flips `calibrated:false` to a data-backed model.
//
// Everything here obeys the insufficient_data contract: below threshold, no
// correlation is reported; before full calibration size, results are explicitly
// labeled "directional, not calibrated". No number is ever invented.
//
// See docs/creator-v10/learning-pipeline-research.md

"use strict";

const store = require("./outcome-store");
const retention = require("./retention-analysis");

// Graduated thresholds, consistent with score-engine's culture of honest floors.
const MIN_FOR_CORRELATION = 30;   // below this, report nothing
const MIN_FOR_CALIBRATION = 100;  // below this, correlations are "directional"
// A fuzzy title link at/above this confidence may be auto-accepted; anything
// below requires explicit human confirmation (no fabricated joins).
const AUTO_LINK_CONFIDENCE = 0.92;

function nowIso() { return new Date().toISOString(); }
function makeId() { return `outcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function insufficient(have, need, reason) { return { status: "insufficient_data", have, need, reason }; }

// ---------------------------------------------------------------------------
// Feature extraction from a stored entry (data/creator/entries/<id>/metadata.json)
// ---------------------------------------------------------------------------

// Canonical measured-feature keys we trust as REAL (computed by the ffmpeg
// HighlightTimeline analysis of the user's own clip — see viral-score-v10.js).
const SIGNAL_KEYS = [
  "durationSec", "highlightsCount", "timeToFirstEventSec", "cutsPerMin",
  "avgShotLengthSec", "coverage", "gapCV", "audioActivityPerMin", "audioPeak",
  "multiSignalSpikesPerMin", "endPayoff", "lateSurprise", "excessMotion", "strongBeats",
  "wordsPerSec", "speechCoverage", "deadAirMaxSec",
];
const HEADLINE_KEYS = ["viralScore", "predictedCompletionRate", "predictedShareRate"];

/**
 * Pull the real measured features off an entry. Returns ONLY finite numbers
 * that actually exist; missing fields are omitted (never zero-filled).
 * @param {Object} entry  parsed metadata.json
 * @returns {Object<string, number>}
 */
function loadFeaturesFromEntry(entry) {
  const features = {};
  const signals = entry && entry.scoreV10 && entry.scoreV10.viral && entry.scoreV10.viral.signals;
  if (signals) {
    for (const k of SIGNAL_KEYS) {
      if (typeof signals[k] === "number" && Number.isFinite(signals[k])) features[k] = signals[k];
    }
  }
  const headline = entry && entry.scoreV10 && entry.scoreV10.headline;
  if (headline) {
    for (const k of HEADLINE_KEYS) {
      if (typeof headline[k] === "number" && Number.isFinite(headline[k])) features[k] = headline[k];
    }
  }
  return features;
}

// ---------------------------------------------------------------------------
// Linking analytics rows -> local entries
// ---------------------------------------------------------------------------

function normalizeTitle(t) {
  return String(t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenJaccard(a, b) {
  const sa = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const sb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Propose a link between each analytics row and a local entry.
 * @param {Array} analyticsRows  output of parseAnalyticsCsv().rows
 * @param {Array} entries        [{id, title}]
 * @returns {Array<{videoRef, title, entryId, candidateTitle, method, confidence, status}>}
 *   status: "auto" (confident enough to write) | "needs_confirmation" | "unmatched"
 */
function proposeLinks(analyticsRows, entries, opts = {}) {
  const autoThreshold = opts.autoLinkConfidence ?? AUTO_LINK_CONFIDENCE;
  const savedLinks = store.readLinks();
  const proposals = [];

  for (const row of analyticsRows) {
    const videoRef = row.videoId || row.title;
    // 1) Previously confirmed link wins outright.
    if (videoRef && savedLinks[videoRef]) {
      proposals.push({
        videoRef, title: row.title, entryId: savedLinks[videoRef],
        candidateTitle: null, method: "manual", confidence: 1, status: "auto",
      });
      continue;
    }

    // 2) Best title match against local entries.
    let best = { entryId: null, candidateTitle: null, confidence: 0 };
    for (const e of entries) {
      const nA = normalizeTitle(row.title);
      const nB = normalizeTitle(e.title);
      let conf = 0;
      if (nA && nA === nB) conf = 1;
      else conf = tokenJaccard(row.title, e.title);
      if (conf > best.confidence) best = { entryId: e.id, candidateTitle: e.title, confidence: conf };
    }

    let method = "fuzzy_title";
    if (best.confidence === 1) method = "exact_title";
    let status = "unmatched";
    if (best.entryId && best.confidence >= autoThreshold) status = "auto";
    else if (best.entryId && best.confidence > 0) status = "needs_confirmation";

    proposals.push({
      videoRef, title: row.title,
      entryId: status === "auto" ? best.entryId : null,
      candidateEntryId: best.entryId,
      candidateTitle: best.candidateTitle,
      method, confidence: Number(best.confidence.toFixed(3)), status,
    });
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Ingest: write outcome rows for confirmed links only
// ---------------------------------------------------------------------------

/**
 * Persist labeled outcome rows by joining analytics outcomes to measured features.
 * Only rows with a CONFIRMED link (auto or manual) are written.
 *
 * @param {Object} params
 *   - analyticsRows: parseAnalyticsCsv().rows
 *   - links: proposeLinks() output (or a manually-confirmed equivalent)
 *   - featuresByEntryId: { [entryId]: {featureKey:number} } measured features
 *   - outcomeSource: provenance string (default "youtube_studio_csv")
 *   - persistLinks: when true, save accepted links for idempotent re-import
 * @returns {{written:number, skipped:Array, usable:number}}
 */
function outcomeSignature(videoRef, outcome) {
  const keys = Object.keys(outcome || {}).sort();
  return videoRef + "|" + keys.map((k) => `${k}=${outcome[k]}`).join(",");
}

function ingest({ analyticsRows, links, featuresByEntryId = {}, retentionByEntryId = {}, outcomeSource = "youtube_studio_csv", persistLinks = true }) {
  const linkByRef = new Map();
  for (const l of links || []) linkByRef.set(l.videoRef, l);

  // Idempotency: an identical (videoRef + metrics) outcome is never written
  // twice, so re-importing the same export is safe. Genuinely-changed metrics
  // (a later analytics snapshot) still append — that's a desirable time series.
  const existing = new Set(store.readAll().map((r) => outcomeSignature(r.videoRef, r.outcome)));

  const skipped = [];
  let written = 0;
  let usable = 0;
  let duplicates = 0;

  for (const row of analyticsRows) {
    const videoRef = row.videoId || row.title;
    const link = linkByRef.get(videoRef);

    if (!link || (link.status !== "auto" && link.method !== "manual")) {
      skipped.push({ videoRef, reason: "no confirmed link" });
      continue;
    }

    const sig = outcomeSignature(videoRef, row.outcome);
    if (existing.has(sig)) {
      duplicates++;
      skipped.push({ videoRef, reason: "duplicate (already imported)" });
      continue;
    }
    const entryId = link.entryId || link.candidateEntryId;
    if (!entryId) {
      skipped.push({ videoRef, reason: "link has no entryId" });
      continue;
    }

    const features = featuresByEntryId[entryId] || null;
    const hasFeatures = features && Object.keys(features).length > 0;

    const outcomeRow = {
      id: makeId(),
      entryId,
      videoRef,
      title: row.title || null,
      platform: "youtube",
      linkMethod: link.method,
      linkConfidence: typeof link.confidence === "number" ? link.confidence : 1,
      features: hasFeatures ? features : null,
      featureProvenance: hasFeatures ? "own_render" : null,
      usableForCalibration: !!hasFeatures,
      outcome: row.outcome,
      outcomeSource,
      collectedAt: nowIso(),
    };

    // A4→B2 (additive): if a retention curve + the edit's segment list are supplied
    // for this entry, merge the retention metrics into the outcome and attach the
    // cliffSegment attribution that the drop-off model (B2) learns from. Rows
    // without a curve are untouched.
    const ret = retentionByEntryId[entryId];
    if (ret && Array.isArray(ret.points)) {
      const enr = retention.enrichFromCurve(ret.points, ret.segments, ret.durationSec);
      if (enr.outcomeMetrics && Object.keys(enr.outcomeMetrics).length) {
        outcomeRow.outcome = { ...outcomeRow.outcome, ...enr.outcomeMetrics };
      }
      if (enr.cliffSegment) outcomeRow.cliffSegment = enr.cliffSegment;
    }

    try {
      store.appendOutcome(outcomeRow);
      existing.add(sig); // dedup within this same batch too
      written++;
      if (hasFeatures) usable++;
      if (persistLinks && videoRef) store.saveLink(videoRef, entryId);
    } catch (err) {
      skipped.push({ videoRef, reason: err.message });
    }
  }

  return { written, skipped, usable, duplicates };
}

// ---------------------------------------------------------------------------
// Readiness + correlations
// ---------------------------------------------------------------------------

function readiness() {
  const usable = store.usableRows().length;
  if (usable < MIN_FOR_CALIBRATION) {
    return insufficient(usable, MIN_FOR_CALIBRATION, "not enough labeled outcomes to calibrate scores");
  }
  return { status: "ok", have: usable, need: MIN_FOR_CALIBRATION };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null; // a constant column has no correlation
  return num / Math.sqrt(dx * dy);
}

/**
 * Correlate each measured feature against each real outcome metric over the
 * usable calibration rows. Pairs are computed only where BOTH values exist.
 *
 * @returns insufficient_data (below MIN_FOR_CORRELATION) OR
 *   { status:"ok", calibrated:boolean, sampleSize, correlations:[{feature, metric, r, n}] }
 */
function correlations(opts = {}) {
  const rows = store.usableRows();
  const need = opts.minRows || MIN_FOR_CORRELATION;
  if (rows.length < need) {
    return insufficient(rows.length, need, "not enough labeled outcomes to compute correlations");
  }

  const featureKeys = new Set();
  const metricKeys = new Set();
  for (const r of rows) {
    Object.keys(r.features || {}).forEach((k) => featureKeys.add(k));
    Object.keys(r.outcome || {}).forEach((k) => metricKeys.add(k));
  }

  const correlations = [];
  for (const f of featureKeys) {
    for (const m of metricKeys) {
      const xs = [], ys = [];
      for (const r of rows) {
        const fv = r.features[f], mv = r.outcome[m];
        if (typeof fv === "number" && Number.isFinite(fv) &&
            typeof mv === "number" && Number.isFinite(mv)) {
          xs.push(fv); ys.push(mv);
        }
      }
      if (xs.length < need) continue;
      const r = pearson(xs, ys);
      if (r === null) continue;
      correlations.push({ feature: f, metric: m, r: Number(r.toFixed(3)), n: xs.length });
    }
  }
  correlations.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  return {
    status: "ok",
    calibrated: rows.length >= MIN_FOR_CALIBRATION,
    note: rows.length >= MIN_FOR_CALIBRATION
      ? "calibrated on first-party outcomes"
      : "directional, not calibrated (need " + MIN_FOR_CALIBRATION + "+ labeled outcomes)",
    sampleSize: rows.length,
    correlations,
    computedAt: nowIso(),
  };
}

// Human-readable names for the measured features, used in recommendations.
const FEATURE_LABELS = {
  cutsPerMin: "cuts per minute", timeToFirstEventSec: "hook speed (time to first event)",
  coverage: "highlight coverage", gapCV: "pacing rhythm (gap variance)",
  audioActivityPerMin: "audio activity", audioPeak: "peak loudness",
  multiSignalSpikesPerMin: "multi-signal spikes", endPayoff: "ending payoff",
  lateSurprise: "late surprise", excessMotion: "excess motion", strongBeats: "strong beats",
  highlightsCount: "number of highlights", durationSec: "duration",
  viralScore: "structural viral score", predictedCompletionRate: "predicted completion",
  predictedShareRate: "predicted share rate",
};

// Which outcome metrics are "good when higher" (drives the direction of advice).
const HIGHER_IS_BETTER = {
  views: true, avgPercentViewed: true, avgViewDurationSec: true, watchTimeHours: true,
  impressions: true, ctrPercent: true, subscribersGained: true, shares: true,
  likes: true, comments: true,
  // A4 retention-curve outcomes:
  introRetention: true, meanRetention: true,
  maxCliffDrop: false, // a bigger drop-off cliff is WORSE
};

/**
 * Calibrated recommendations — STRICTLY separated from structural estimates.
 * Returns insufficient_data until the calibration set is large enough; only then
 * does it turn the strongest, real feature↔outcome correlations into plain-language
 * advice. Every item carries its r and n so the claim is auditable.
 *
 * @returns insufficient_data OR
 *   { status:"ok", calibrated:true, basis:"first_party_outcomes", sampleSize, recommendations:[...] }
 */
function calibratedRecommendations(opts = {}) {
  const ready = readiness();
  if (ready.status !== "ok") {
    return { ...ready, basis: "first_party_outcomes" }; // insufficient_data, honestly
  }
  const corr = correlations(opts);
  if (corr.status !== "ok" || !corr.calibrated) {
    return insufficient(corr.sampleSize || 0, MIN_FOR_CALIBRATION, "correlations not yet calibrated");
  }

  const minAbsR = opts.minAbsR ?? 0.3; // ignore weak/noise correlations
  const recommendations = corr.correlations
    .filter((c) => Math.abs(c.r) >= minAbsR)
    .slice(0, opts.limit ?? 6)
    .map((c) => {
      const goodHigher = HIGHER_IS_BETTER[c.metric] !== false;
      // Positive r + good metric => more of the feature helps; flip otherwise.
      const moreHelps = (c.r > 0) === goodHigher;
      const fLabel = FEATURE_LABELS[c.feature] || c.feature;
      return {
        feature: c.feature, metric: c.metric, r: c.r, n: c.n,
        direction: moreHelps ? "increase" : "decrease",
        text: `${moreHelps ? "Increase" : "Decrease"} ${fLabel} — it correlates with ${c.metric} ` +
              `(r=${c.r}, n=${c.n}) in your own posted shorts.`,
      };
    });

  return {
    status: "ok",
    calibrated: true,
    basis: "first_party_outcomes",
    sampleSize: corr.sampleSize,
    recommendations,
    computedAt: nowIso(),
  };
}

module.exports = {
  MIN_FOR_CORRELATION, MIN_FOR_CALIBRATION, AUTO_LINK_CONFIDENCE,
  loadFeaturesFromEntry, proposeLinks, ingest, readiness, correlations,
  calibratedRecommendations,
  // exported for testing
  normalizeTitle, tokenJaccard, pearson, SIGNAL_KEYS, HEADLINE_KEYS,
};
