"use strict";
// Fast-layer plasticity (#1011) — the non-parametric "weights" that update in
// real time after EACH external grounding. This is the thesis-safe alternative
// to per-loop NEURAL weight updates: no catastrophic forgetting, no irreversible
// gradient step, no eval-gate needed — because the weight is a PURE FUNCTION of an
// append-only grounding log, so it updates instantly per loop yet is fully
// replayable / reversible.
//
//   grounding event  = { key, predicted, outcome }
//     key       — the dimension we calibrate trust on (provider / agent / source …)
//     predicted — the confidence WE asserted, in [0,1]
//     outcome   — the external ground truth, 0 or 1 (a web check, a settled market,
//                 a passing test — never the model's own say-so)
//
//   trust(key)  = Beta(1+hits, 1+misses) posterior mean — starts at 0.5 and moves
//                 toward empirical correctness with each grounding.
//   brier       = mean (predicted − outcome)²  — the calibration report card
//                 (0 = perfect, 0.25 = a coin flip, lower = better).
const fs = require("fs");
const path = require("path");

const LOG_REL = "data/convergence/grounding-calibration.jsonl";
function logPath(root) { return path.join(root || process.cwd(), LOG_REL); }

function clamp01(x) { x = Number(x); return x < 0 ? 0 : x > 1 ? 1 : (x || 0); }

// ── Pure core: fold an append-only event list into calibrated weights ─────────
function foldKey(events) {
  let n = 0, hits = 0, sumBrier = 0;
  for (const e of events) {
    const p = clamp01(e.predicted), o = e.outcome ? 1 : 0;
    n++; hits += o; sumBrier += (p - o) * (p - o);
  }
  return {
    key: events[0] && events[0].key,
    n,
    trust: (1 + hits) / (2 + n),        // Beta posterior mean — the fast weight
    brier: n ? sumBrier / n : null,     // calibration quality for this key
  };
}

// Reduce the whole log → per-key weights + the headline global Brier.
function summarize(events) {
  const byKey = new Map();
  let n = 0, sumBrier = 0;
  for (const e of events) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
    const p = clamp01(e.predicted), o = e.outcome ? 1 : 0;
    n++; sumBrier += (p - o) * (p - o);
  }
  const keys = {};
  for (const [k, evs] of byKey) keys[k] = foldKey(evs);
  return { total_events: n, global_brier: n ? sumBrier / n : null, keys };
}

// ── I/O (append-only, replayable) ─────────────────────────────────────────────
function readEvents(root) {
  try {
    return fs.readFileSync(logPath(root), "utf-8").split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Append ONE grounding event and return the UPDATED weight for its key — the
// real-time, per-loop adjustment. `ts` is injectable so the write is deterministic.
function recordGrounding({ key, predicted, outcome, ts, source }, root) {
  if (!key) throw new Error("grounding-calibration: key required");
  const evt = {
    key: String(key),
    predicted: clamp01(predicted),
    outcome: outcome ? 1 : 0,
    ts: ts || new Date().toISOString(),
    source: source || null,
  };
  const p = logPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(evt) + "\n");
  return foldKey(readEvents(root).filter((e) => e.key === evt.key));
}

// The weight a caller (e.g. the router) consults each loop. 0.5 prior when unseen.
function trust(key, root) {
  const evs = readEvents(root).filter((e) => e.key === key);
  return evs.length ? foldKey(evs).trust : 0.5;
}

function calibration(root) { return summarize(readEvents(root)); }

module.exports = {
  recordGrounding, trust, calibration,
  foldKey, summarize, readEvents, logPath, clamp01,
};
