/**
 * Kalshi Convergence-Optimized Game Scorer
 *
 * Ranks games by:
 * 1. Ideal time window (1-6h until close = max prediction accuracy window)
 * 2. High conviction (≥70%)
 * 3. Strong convergence signal (momentum + spread + liquidity alignment)
 *
 * Returns ranked list of games best-suited for convergence routing.
 */

"use strict";

/**
 * Score a game for convergence routing fitness.
 * Higher score = better trade opportunity.
 */
function scoreGame(card) {
  if (!card || card.kind !== "entry") return 0;

  let score = 0;

  // ── Time Window Fitness ────────────────────────────────────────────────
  // Ideal: 1-6 hours until close (enough time for in-game action, not stale)
  const minsToClose = card.minsToClose || 0;
  const hrsToClose = minsToClose / 60;

  if (hrsToClose >= 1 && hrsToClose <= 6) {
    // Sweet spot: full window
    score += 30;
  } else if (hrsToClose > 6 && hrsToClose <= 24) {
    // Acceptable: full day ahead
    score += 15;
  } else if (hrsToClose < 1) {
    // Very tight: less than 1h
    score += 20;
  } else if (hrsToClose > 24) {
    // Too far: stale prediction window
    score += 0;
  }

  // ── Conviction ────────────────────────────────────────────────────────
  // High conviction = convergence router has high confidence
  const conv = card.conviction || 0;
  if (conv >= 75) {
    score += 25; // Very high confidence
  } else if (conv >= 70) {
    score += 20; // High confidence
  } else if (conv >= 60) {
    score += 10; // Moderate
  } else if (conv >= 50) {
    score += 5; // Low-moderate
  }

  // ── Momentum Signal (Convergence Indicator) ─────────────────────────
  // Strong tick = clear directional conviction
  const yesCents = card.yesCents || 0;
  const noCents = card.noCents || 0;
  const tick = Math.abs(yesCents - noCents) - 50; // deviation from 50/50
  const spread = Math.abs((yesCents || 0) - (noCents || 0));

  if (Math.abs(tick) >= 5) {
    score += 15; // Strong directional tick
  } else if (Math.abs(tick) >= 3) {
    score += 10; // Moderate momentum
  } else if (Math.abs(tick) >= 1) {
    score += 5; // Weak momentum
  }

  // ── Spread Quality (Market Tightness) ──────────────────────────────
  // Tight spread = liquid market, convergence is real not noise
  if (spread <= 1) {
    score += 12; // Ultra-tight
  } else if (spread <= 2) {
    score += 8; // Tight
  } else if (spread <= 4) {
    score += 4; // Moderate
  }

  // ── Reason Signal Quality ──────────────────────────────────────────
  // Parse the reason text for signal patterns
  const reason = (card.reason || "").toLowerCase();
  if (reason.includes("ticked")) {
    score += 5; // Has momentum indicator
  }
  if (reason.includes("spread")) {
    score += 3; // Mentions market quality
  }

  return Math.round(score);
}

/**
 * Filter and rank games by convergence fitness.
 * Returns top games for trading in ideal time window.
 */
function rankByConvergence(cards, limit = 12) {
  if (!Array.isArray(cards)) return [];

  return cards
    .filter((c) => c.kind === "entry")
    .map((c) => ({
      ...c,
      convergenceScore: scoreGame(c),
    }))
    .sort((a, b) => {
      // Primary: convergence score
      if (b.convergenceScore !== a.convergenceScore) {
        return b.convergenceScore - a.convergenceScore;
      }
      // Secondary: conviction
      if (b.conviction !== a.conviction) {
        return b.conviction - a.conviction;
      }
      // Tertiary: time to close (prefer sooner)
      return (a.minsToClose || 0) - (b.minsToClose || 0);
    })
    .slice(0, limit);
}

module.exports = {
  scoreGame,
  rankByConvergence,
};
