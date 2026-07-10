"use strict";

/**
 * ForecastEx DAY-AHEAD evaluation core (#2217) — the pure Reason+Verify math shared by the
 * retrospective backtest (scripts/backtest-forecastex-dayahead.js) and the nightly forward
 * paper-verification job (lib/forecastex-paper-verify.js). One implementation so the
 * backtest and the forward job grade the venue IDENTICALLY — fit == serve discipline.
 *
 * THE HONEST PROTOCOL (docs/research/2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md
 * §4): same-day EOD closes already know the outcome, so every evaluation here is DAY-AHEAD —
 * the board for contract date D is priced from the D-1 prices file (EOD closes on D-1) and
 * the MOS forecast is a run available on D-1 (or stamped before the day's high on D). A
 * prediction is stamped BEFORE reality resolves it, then graded against the venue's own
 * settlement flips. Never grade a prediction with data that postdates it.
 *
 * Pure + deterministic + no network + no disk. All I/O lives in the callers.
 */

const oracle = require("./kalshi-weather-edge");
const verify = require("./kalshi-weather-verify");
const { rangeYes } = require("./forecastex-board");

/**
 * Kalshi-style ladder covering ALL of ℝ from a cumulative threshold board
 * (sorted [{thr, yes}]). Buckets: open bottom (<= t0), one bucket per adjacent
 * threshold pair (a, b] = [a+1, b] (1°F wide when thresholds are contiguous, wider
 * across listing gaps — never a hole), open top (>= tLast+1). Every bucket is
 * priceable from cumulative differences by construction. null if the board is too
 * thin (< 2 thresholds) to form a real ladder.
 */
function ladderFromBoard(board) {
  if (!Array.isArray(board) || board.length < 2) return null;
  const t = board.map((b) => b.thr);
  const ladder = [[`<=${t[0]}`, null, t[0]]];
  for (let i = 1; i < t.length; i++) {
    const lo = t[i - 1] + 1, hi = t[i];
    ladder.push([lo === hi ? String(hi) : `${lo}-${hi}`, lo, hi]);
  }
  ladder.push([`>=${t[t.length - 1] + 1}`, t[t.length - 1] + 1, null]);
  return ladder;
}

/** {label -> YES price} for every ladder bucket, from cumulative differences. Values are
 *  clamped to [0, 1]; by construction of ladderFromBoard none are null. */
function askMapFromBoard(board, ladder) {
  const ask = {};
  for (const [lbl, lo, hi] of ladder) {
    const p = rangeYes(board, lo, hi);
    if (p == null) continue; // unreachable for a ladderFromBoard ladder; stay fail-soft
    ask[lbl] = Math.min(1, Math.max(0, p));
  }
  return ask;
}

/**
 * The interval the settled high is pinned to by the venue's own settlement flips
 * (forecastex-board.settledHighs): strict-exceed ⇒ high ∈ [maxYes+1, minNo]. On a clean
 * flip the interval is a single point. null ends = unbounded (missing flips).
 */
function settleInterval(s) {
  if (!s) return null;
  return {
    lo: s.maxYes != null ? s.maxYes + 1 : null,
    hi: s.minNo != null ? s.minNo : null,
  };
}

/**
 * Did the settled high land in bucket [lo, hi]? 1 / 0 when the settle interval decides it
 * either way, null when the interval straddles the bucket edge (undeterminable — an unclean
 * settlement can still grade most buckets; never guess the rest).
 */
function bucketOutcome(interval, lo, hi) {
  if (!interval) return null;
  const iLo = interval.lo, iHi = interval.hi;
  // fully inside the bucket -> 1 (needs both interval ends known)
  if (iLo != null && iHi != null &&
      (lo == null || iLo >= lo) && (hi == null || iHi <= hi)) return 1;
  // fully outside -> 0 (one known end beyond the far bucket edge is enough)
  if (hi != null && iLo != null && iLo > hi) return 0;
  if (lo != null && iHi != null && iHi < lo) return 0;
  return null;
}

/** Ladder index the settle interval pins to, or -1 when it spans buckets / is unbounded. */
function settledBucketIdx(ladder, interval) {
  if (!interval || interval.lo == null || interval.hi == null) return -1;
  const a = verify.settledBucketFromHigh(ladder, interval.lo);
  const b = verify.settledBucketFromHigh(ladder, interval.hi);
  return a >= 0 && a === b ? a : -1;
}

/** Realized P&L in cents/contract of one card at settlement, net of the flat venue fee.
 *  Buy 1 contract at the day-ahead close: YES pays 100·outcome, NO pays 100·(1−outcome). */
function cardPnlCents(side, ask, outcome, feeC = 1) {
  if (outcome !== 0 && outcome !== 1) return null;
  const gross = side === "yes" ? 100 * (outcome - ask) : 100 * (ask - outcome);
  return Math.round((gross - feeC) * 10) / 10;
}

/**
 * Stamp one day-ahead prediction: KLGA-params oracle distribution + band-robust edge cards
 * against the D-1 EOD board. Returns null when the board can't form a ladder.
 * feeCents is the injectable fee FUNCTION (defaults belong to the caller — forecastex-fees).
 */
function predictDay({ board, forecastHigh, lead, month, day, params, minEdgeCents = 5, feeCents }) {
  const ladder = ladderFromBoard(board);
  if (!ladder || !Number.isFinite(forecastHigh)) return null;
  const ask = askMapFromBoard(board, ladder);
  const rep = oracle.robustEdgeReport(forecastHigh, lead, ladder, ask, month, day, minEdgeCents, params, feeCents);
  return {
    ladder, ask, dist: rep.dist, rows: rep.rows,
    actionable: rep.actionable, verdict: rep.verdict,
  };
}

/**
 * Grade one stamped prediction against the venue settlement record
 * ({high, clean, maxYes, minNo}). Proper scores (RPS/PIT, kalshi-weather-verify) for the
 * oracle AND the market's own day-ahead distribution on the SAME ladder — the market is the
 * baseline any information edge must beat — plus per-card realized P&L net of the flat fee.
 */
function gradeDay(pred, settle, { flatFeeC = 1 } = {}) {
  const interval = settleInterval(settle);
  const obsIdx = settledBucketIdx(pred.ladder, interval);
  let scores = null;
  if (obsIdx >= 0) {
    const oracleVec = verify.distVector(pred.dist, pred.ladder);
    const marketVec = verify.distVector(pred.ask, pred.ladder);
    const K = pred.ladder.length;
    const flat = new Array(K).fill(1 / K);
    scores = {
      oracleRPS: verify.rps(oracleVec, obsIdx), oraclePIT: verify.pit(oracleVec, obsIdx),
      marketRPS: verify.rps(marketVec, obsIdx), marketPIT: verify.pit(marketVec, obsIdx),
      climRPS: verify.rps(flat, obsIdx),
    };
  }
  const cards = (pred.actionable || []).map((c) => {
    const [, lo, hi] = pred.ladder.find(([lbl]) => lbl === c.bucket) || [];
    const outcome = bucketOutcome(interval, lo, hi);
    const ask = pred.ask[c.bucket]; // exact close, not the display-rounded ask_c
    return {
      bucket: c.bucket, side: c.side, ask,
      worst_c: c.worst_c, fair: c.fair, outcome,
      pnl_c: cardPnlCents(c.side, ask, outcome, flatFeeC),
    };
  });
  return { obsIdx, interval, scores, cards };
}

module.exports = {
  ladderFromBoard, askMapFromBoard, settleInterval, bucketOutcome,
  settledBucketIdx, cardPnlCents, predictDay, gradeDay,
};
