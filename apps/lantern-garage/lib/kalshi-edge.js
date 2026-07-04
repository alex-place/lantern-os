"use strict";

/**
 * Kalshi edge — the "moat column" (the Reason→Verify surface Verso can't show).
 *
 * For a market, combine three things we already compute into ONE uniform object the
 * terminal can render as a badge:
 *   • market-implied P(YES)         — the price (yes_ask / 100)
 *   • our web-grounded P(YES)       — kalshi-grounding.peek() (CACHED; never triggers a
 *                                     new LLM call), calibrated by our forward track record
 *   • edge after fees               — kalshi-fees.netEvCents() on the better side
 *   • Brier (n)                     — kalshi-calibration: how right our probabilities have
 *                                     been on settled outcomes (lower is better; 0.25 = coin)
 *
 * Verso stops at "what moved." This says "what's MISPRICED, which way, by how much after
 * fees — and our track record on such calls" (External-Reality Rule: cite + grade, never
 * assert). A market with no live-grounded view returns { grounded:false } — no edge claimed.
 */

const fees = require("./kalshi-fees");
const grounding = require("./kalshi-grounding");

let _getCalibrator = null;
try { _getCalibrator = require("./kalshi-calibration").getCalibrator; } catch { /* optional */ }

/**
 * @param {object} market  a Kalshi market with { ticker, yes_ask, no_ask } (cents)
 * @param {object} [calibrator]  a shared calibrator from getCalibrator() (pass once per batch)
 * @returns {object|null} edge badge, or null if the market is unusable
 */
function edgeForMarket(market, calibrator) {
  if (!market || !market.ticker) return null;
  const ya = Number.isFinite(market.yes_ask) ? market.yes_ask : null;
  const na = Number.isFinite(market.no_ask) ? market.no_ask : null;
  const marketP = ya != null ? Math.round((ya / 100) * 1000) / 1000 : null;

  const g = grounding.peek(market.ticker); // cached grounding only — no network / LLM
  // No live-grounded, web-sourced probability → we do NOT claim an edge over the market.
  if (!g || g.p_yes == null || g.web_grounded === false) {
    return { grounded: false, marketP, p_yes: g && g.p_yes != null ? g.p_yes : null };
  }

  const cal = calibrator || (_getCalibrator ? _getCalibrator() : null);
  const rawP = g.p_yes;
  const p = cal && typeof cal.calibrate === "function" ? cal.calibrate(rawP) : rawP;

  const evYes = ya != null ? fees.netEvCents(ya, p) : null;
  const evNo = na != null ? fees.netEvCents(na, 1 - p) : null;
  const yesBetter = (evYes == null ? -1e9 : evYes) >= (evNo == null ? -1e9 : evNo);
  const entry = yesBetter ? ya : na;
  const edgeCents = yesBetter ? evYes : evNo;

  return {
    grounded: true,
    side: yesBetter ? "YES" : "NO",
    p_yes: Math.round(rawP * 1000) / 1000, // our grounded probability
    calibrated: Math.round(p * 1000) / 1000, // after forward calibration
    marketP, // market-implied P(YES)
    entryCents: entry,
    edgeCents: edgeCents == null ? null : Math.round(edgeCents * 10) / 10, // fee-adjusted EV, ¢/contract
    positive: edgeCents != null && edgeCents > 0,
    brier: cal && Number.isFinite(cal.brier) ? Math.round(cal.brier * 1000) / 1000 : null,
    n: cal ? cal.n || 0 : 0,
    confidence: Number.isFinite(g.confidence) ? g.confidence : null,
    sources: Array.isArray(g.sources) ? g.sources.slice(0, 3) : [],
  };
}

/** Attach `.edge` to a list of cards that carry a `.market`. Builds the calibrator once. */
function attachEdges(cards) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  let cal = null;
  try { cal = _getCalibrator ? _getCalibrator() : null; } catch { cal = null; }
  for (const card of cards) {
    if (card && card.market) {
      try { card.edge = edgeForMarket(card.market, cal); } catch { /* leave card.edge unset */ }
    }
  }
  return cards;
}

module.exports = { edgeForMarket, attachEdges };
