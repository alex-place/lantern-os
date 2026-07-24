/**
 * Kalshi Adaptive Exits — PCSF-driven profit/stop-loss using convergence state.
 *
 * Instead of mechanical bands (±25%), exit decisions based on:
 * - Entry conviction (how right we were at entry)
 * - Current market state (DETERMINED/CONFIDENT/UNCERTAIN)
 * - Convergence direction (is our side converging or diverging?)
 *
 * Exit Rules:
 * ✓ TAKE PROFIT: market reaches DETERMINED state on our entry side
 * ✓ STOP-LOSS: market state UNCERTAIN + diverging >15% from entry
 * ✓ ADAPTIVE: tighten stops if conviction drops; widen if converging
 * ✗ NO FLATTEN: block automatic close-at-30m to let convergence play out
 */

"use strict";

function getCategory(ticker) {
  if (!ticker) return "unknown";
  if (ticker.startsWith("KXBTC") || ticker.startsWith("KXETH") ||
      ticker.startsWith("KXSOL") || ticker.startsWith("KXXRP") ||
      ticker.startsWith("KXDOGE")) return "crypto";
  if (ticker.startsWith("KXMVE")) return "sports";
  return "other";
}

/**
 * Determine current market state using convergence engine logic.
 * Returns {stateLabel, confidence, width, favSide, favProb}
 */
function getMarketState(market) {
  if (!market) return null;

  const yesAsk = market.yes_ask || 50;
  const noAsk = market.no_ask || 50;

  // Implied probability: yes_ask / (yes_ask + no_ask)
  const denom = yesAsk + noAsk;
  const yesProb = denom > 0 ? Math.round((yesAsk / denom) * 100) : 50;
  const noProb = 100 - yesProb;

  // Convergence width (distance from 50/50)
  const mid = (yesAsk + noAsk) / 2;
  const width = Math.abs(mid - 50) * 2;  // distance from center

  // State classification
  const confidence = Math.min(99, Math.round(100 - width));
  const determined = width <= 15;   // <15 = fully determined
  const confident = width <= 40;    // <40 = confident
  const stateLabel = determined ? "DETERMINED" : confident ? "CONFIDENT" : "UNCERTAIN";

  const favSide = yesProb >= noProb ? "yes" : "no";
  const favProb = Math.max(yesProb, noProb);

  return {
    stateLabel,
    confidence,
    width,
    favSide,
    favProb,
    yesProb,
    noProb
  };
}

/**
 * Calculate adaptive exit thresholds based on entry conviction + current state.
 * Entry conviction tells us how right we were; state tells us if market agrees now.
 */
function calcAdaptiveExitThresholds(entryConviction, currentState) {
  if (!currentState) return { takeProfit: 25, stopLoss: -25 };

  // Start with conviction-scaled bands
  let takeProfit = Math.max(15, Math.min(50, 15 + (entryConviction / 100) * 35));
  let stopLoss = Math.max(-50, Math.min(-10, -10 - (entryConviction / 100) * 40));

  // Adjust based on current convergence state
  if (currentState.stateLabel === "DETERMINED") {
    // Market has strong conviction on favSide — tighten profit target
    takeProfit = Math.max(5, takeProfit - 10);
  } else if (currentState.stateLabel === "UNCERTAIN") {
    // Market lost conviction — tighten stop-loss (protect faster)
    stopLoss = Math.max(stopLoss, -15);
  }

  return { takeProfit, stopLoss };
}

/**
 * Evaluate if position should exit now.
 * Returns {shouldExit, tag, reason, pnlPct}
 */
function evaluateExit(position, market, entryConviction) {
  if (!position || !market) return { shouldExit: false };

  const entrySide = position.side;  // 'yes' | 'no'
  const entryPrice = position.limitCents || 50;

  // Get current market state
  const state = getMarketState(market);
  if (!state) return { shouldExit: false };

  // Get adaptive thresholds
  const thresholds = calcAdaptiveExitThresholds(entryConviction, state);

  // Current exit price (bid, realistic with spread)
  const currentBid = entrySide === "yes"
    ? (market.yes_bid || market.yes_ask || entryPrice)
    : (market.no_bid || market.no_ask || entryPrice);

  // P&L calculation
  const pnlCents = currentBid - entryPrice;
  const pnlPct = Math.round((pnlCents / entryPrice) * 100);

  // ── Exit Logic (convergence-driven, not mechanical) ───────────────────

  // 1. TAKE PROFIT: Market reached DETERMINED on our favored side
  if (state.stateLabel === "DETERMINED" && state.favSide === entrySide) {
    return {
      shouldExit: true,
      tag: "CONVERGENCE-DETERMINED",
      reason: `Market DETERMINED on ${entrySide.toUpperCase()} (${state.favProb}% prob) — lock in`,
      pnlPct,
      exitPrice: currentBid
    };
  }

  // 2. MECHANICAL TAKE PROFIT: If PnL exceeds adaptive threshold
  if (pnlPct >= thresholds.takeProfit) {
    return {
      shouldExit: true,
      tag: "TAKE-PROFIT",
      reason: `+${pnlPct}% ≥ ${thresholds.takeProfit}% threshold`,
      pnlPct,
      exitPrice: currentBid
    };
  }

  // 3. ADAPTIVE STOP-LOSS: P&L + state divergence
  if (pnlPct <= thresholds.stopLoss) {
    return {
      shouldExit: true,
      tag: "STOP-LOSS",
      reason: `${pnlPct}% ≤ ${thresholds.stopLoss}% threshold (${state.stateLabel} state)`,
      pnlPct,
      exitPrice: currentBid
    };
  }

  // 4. CONFIDENCE COLLAPSE: Market went UNCERTAIN after we entered confident
  if (entryConviction >= 70 && state.stateLabel === "UNCERTAIN" && pnlPct < -5) {
    return {
      shouldExit: true,
      tag: "CONFIDENCE-COLLAPSE",
      reason: `Conviction dropped from ${entryConviction}% → UNCERTAIN state`,
      pnlPct,
      exitPrice: currentBid
    };
  }

  // NO FLATTEN AT CLOSE — let convergence play out

  return { shouldExit: false };
}

/**
 * Score remaining positions — which are still worth holding?
 * Returns ranked list by potential profit + convergence signal strength.
 */
function scoreHold(position, market, entryConviction) {
  if (!position || !market) return 0;

  const state = getMarketState(market);
  if (!state) return 0;

  let score = 0;

  // 1. Convergence strength: how clear is the signal?
  if (state.stateLabel === "DETERMINED") {
    score += state.favSide === position.side ? 40 : -40;
  } else if (state.stateLabel === "CONFIDENT") {
    score += state.favSide === position.side ? 25 : -25;
  } else {
    score += state.favSide === position.side ? 10 : -10;
  }

  // 2. Entry confidence: were we right at entry?
  score += entryConviction / 3;

  // 3. Time decay: penalize if very close to close
  const minsToClose = market.close_time
    ? Math.round((new Date(market.close_time).getTime() - Date.now()) / 60000)
    : Infinity;

  if (minsToClose < 5) {
    score -= 20;  // Too late to hold
  } else if (minsToClose < 15) {
    score -= 10;  // Getting tight
  } else if (minsToClose > 60) {
    score += 5;   // Plenty of time for convergence
  }

  return Math.round(score);
}

module.exports = {
  getMarketState,
  calcAdaptiveExitThresholds,
  evaluateExit,
  scoreHold,
  getCategory
};
