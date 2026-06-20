"use strict";
// Verify trigger for the Kalshi slice of the Convergence loop (agent-spine note §6, step 3).
//
// THE GAP THIS CLOSES
// kalshi-suggest.js already EMITS a ConvergenceRecord per tradeable entry (Reason),
// and scripts/convergence_close_loop.py already GRADES records against an
// outcomes.jsonl sidecar and runs extract_patterns (Verify → Converge). The wire
// that was missing: nothing turned a *settled Kalshi market* into an outcome line.
// So the records piled up unverified — the loop was coded but never triggered.
//
// THIS MODULE is that trigger. For every emitted kalshi-suggest record it looks up
// the market (live, via the public Kalshi GET /markets/{ticker}); if the market has
// SETTLED (result yes/no), it writes {record_id, passed} to outcomes.jsonl — exactly
// the shape convergence_close_loop.py consumes. A trade either wins or loses, so this
// is a reasoner with ground truth: the graded confidence is earned, not heuristic.
//
// Pure + injectable on purpose: parsePrediction / resolutionToOutcome are pure and
// unit-tested (tests/test_kalshi_outcomes.js); the live fetch is a swappable dep so
// the tests need no network or API keys. Best-effort throughout — a single market
// lookup failing never aborts the batch.

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");
const { RECORDS_PATH } = require("./convergence-records");

const OUTCOMES_PATH = path.join(path.dirname(RECORDS_PATH), "outcomes.jsonl");
const KALSHI_REASONER = "kalshi-suggest";

// ── Pure: read the prediction out of an emitted record ───────────────────────
// The kalshi-suggest record stores the ticker in evidence_ids[0] and the predicted
// side in the hypothesis ("buy YES (…) @ …c — title [TICKER]"); the result line
// ("entry yes … ") is a fallback. Returns { ticker, side: 'yes'|'no' } or null.
function parsePrediction(record) {
  if (!record || record.reasoner !== KALSHI_REASONER) return null;

  let ticker =
    Array.isArray(record.evidence_ids) && record.evidence_ids[0]
      ? String(record.evidence_ids[0]).trim()
      : "";
  if (!ticker) {
    const m = String(record.hypothesis || "").match(/\[([^\]]+)\]\s*$/);
    if (m) ticker = m[1].trim();
  }
  if (!ticker) return null;

  const hay = `${record.hypothesis || ""} ${record.result || ""}`;
  const sideMatch = hay.match(/\b(?:buy|entry)\s+(yes|no)\b/i);
  if (!sideMatch) return null;

  return { ticker, side: sideMatch[1].toLowerCase() };
}

// ── Pure: extract the kalshi market object from a getMarket() response ────────
// getMarket resolves { ok, status, data }; the body is { market: {...} }. Be
// lenient about shape so a slightly different envelope still resolves.
function marketFromResponse(resp) {
  if (!resp || resp.ok === false || !resp.data) return null;
  return resp.data.market || resp.data || null;
}

// ── Pure: settled market + record → outcome line (or null if not resolvable) ──
// A market is graded only once its result is a definitive yes/no. Anything else
// (open, empty, void/"") returns null so the record stays pending, not mis-graded.
function resolutionToOutcome(record, market) {
  if (!market) return null;
  const result = String(market.result == null ? "" : market.result).trim().toLowerCase();
  if (result !== "yes" && result !== "no") return null;
  const pred = parsePrediction(record);
  if (!pred) return null;
  return {
    record_id: record.id,
    passed: pred.side === result,
    notes: `kalshi ${pred.ticker} settled ${result}; predicted ${pred.side}`,
  };
}

// ── I/O: load already-graded record ids so a re-run is idempotent ────────────
function loadGradedIds(outcomesPath) {
  const seen = new Set();
  try {
    const text = fs.readFileSync(outcomesPath, "utf-8");
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && o.record_id) seen.add(o.record_id);
      } catch { /* skip corrupt line */ }
    }
  } catch { /* no outcomes yet */ }
  return seen;
}

function loadKalshiRecords(recordsPath) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(recordsPath, "utf-8");
  } catch {
    return out; // no records yet
  }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && r.reasoner === KALSHI_REASONER && r.id) out.push(r);
    } catch { /* skip corrupt line */ }
  }
  return out;
}

// ── The trigger: settle emitted kalshi-suggest records into outcomes.jsonl ────
// For each not-yet-graded kalshi-suggest record, fetch its market once (cached per
// ticker per run) and, if settled, append an outcome line. Returns an accounting
// summary. Never throws — a failed lookup leaves that record pending for next run.
async function generateOutcomes({
  recordsPath = RECORDS_PATH,
  outcomesPath = OUTCOMES_PATH,
  getMarketFn = null,
} = {}) {
  const getMarket = getMarketFn || require("./kalshi-api").getMarket;
  const records = loadKalshiRecords(recordsPath);
  const graded = loadGradedIds(outcomesPath);

  const marketCache = new Map(); // ticker -> market (per-run, avoids refetch)
  const summary = { scanned: records.length, alreadyGraded: 0, written: 0, pending: 0, unparseable: 0 };

  for (const record of records) {
    if (graded.has(record.id)) { summary.alreadyGraded++; continue; }
    const pred = parsePrediction(record);
    if (!pred) { summary.unparseable++; continue; }

    try {
      if (!marketCache.has(pred.ticker)) {
        marketCache.set(pred.ticker, marketFromResponse(await getMarket(pred.ticker)));
      }
      const outcome = resolutionToOutcome(record, marketCache.get(pred.ticker));
      if (outcome) {
        await appendJsonlQueued(outcomesPath, outcome);
        graded.add(record.id);
        summary.written++;
      } else {
        summary.pending++;
      }
    } catch {
      summary.pending++; // lookup failed → retry next run
    }
  }
  return summary;
}

module.exports = {
  parsePrediction,
  marketFromResponse,
  resolutionToOutcome,
  loadGradedIds,
  loadKalshiRecords,
  generateOutcomes,
  OUTCOMES_PATH,
  KALSHI_REASONER,
};

// Runnable: live pass against the Kalshi API. Pair with the Converge grader:
//   node apps/lantern-garage/lib/kalshi-convergence-outcomes.js
//   python scripts/convergence_close_loop.py
if (require.main === module) {
  generateOutcomes()
    .then((s) => { console.log("[kalshi-outcomes]", JSON.stringify(s)); })
    .catch((e) => { console.error("[kalshi-outcomes] failed:", e && e.message); process.exit(1); });
}
