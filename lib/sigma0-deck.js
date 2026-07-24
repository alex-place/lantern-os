"use strict";

/**
 * Σ₀ deck engine — end-state prediction + risk-adjusted ranking for the
 * Kalshi swipe terminal (kalshi-terminal.html / decisive-deck).
 *
 * HONEST FRAMING (consistent with the Σ₀ no-free-lunch result):
 *   A binary Kalshi market is a dynamical system whose state is the YES
 *   probability p ∈ [0,1], with TWO attractors — YES(100¢) and NO(0¢). As
 *   close_time approaches the price CONTRACTS onto one attractor: that is Σ₀
 *   collapse onto an invariant end state. We predict WHICH attractor and HOW
 *   converged (a contraction confidence), then rank the deck by risk-adjusted
 *   capturable delta GATED by that confidence.
 *
 *   The market price is already the best probability estimate. Σ₀ here is
 *   SELECTION DISCIPLINE, not an edge over the market: it computes each card's
 *   true win-prob / reward / loss-odds / EV / Kelly, refuses the un-converged
 *   coin-flips (minimize loss), and surfaces the highest risk-adjusted reward
 *   per swipe (maximize gain). Negative-EV cards are flagged, never hidden —
 *   the human still verifies. No fabricated edge.
 *
 * Pure, deterministic, no network. Card-shape tolerant: reads favoured side /
 * ask from several field-name variants used across the deck pipeline.
 */

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

function num(v) {
  const f = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(f) ? f : null;
}

// ── read a card's favoured side + ask (cents) + book, tolerant of variants ────
function readCard(card) {
  const m = card.market || card.m || {};
  const side = (card.favSide || card.side || "").toLowerCase() || null;

  let ask = num(card.favAsk) ?? num(card.sideAsk) ?? num(card.entryCents);
  if (ask == null && side) ask = side === "yes" ? num(m.yes_ask) : num(m.no_ask);

  let bid = null, prevAsk = null;
  if (side === "yes") { bid = num(m.yes_bid); }
  else if (side === "no") { bid = num(m.no_bid); }
  const pYesPrev = num(m.previous_yes_ask_dollars);
  if (pYesPrev != null) prevAsk = side === "no" ? 100 - Math.round(pYesPrev * 100)
                                                 : Math.round(pYesPrev * 100);

  const spread = num(card.spread) ?? (ask != null && bid != null ? Math.abs(ask - bid) : null);
  const tick = num(card.tick) ?? (ask != null && prevAsk != null ? ask - prevAsk : 0) ?? 0;
  const mins = num(card.minsToClose);
  return { side, ask, bid, spread, tick, mins };
}

/**
 * Σ₀ end-state estimate for one card.
 *   pWin   — probability the FAVOURED side resolves in the money. Base is the
 *            market-implied prob (ask/100); a small, explicitly-bounded
 *            momentum nudge is added (continuation of the live tick). This is a
 *            weak heuristic, NOT a claimed edge — bounded to ±0.05.
 *   confidence (contraction) ∈ [0,1] — how collapsed the market is onto its end
 *            state: decisiveness |p−0.5|, book tightness, and time-to-close all
 *            push it toward 1. Low confidence ⇒ coin-flip ⇒ down-ranked.
 *   endState — "YES" / "NO" / "UNDECIDED" (the predicted attractor).
 */
function endState(card) {
  const r = readCard(card);
  if (r.ask == null || r.ask <= 0 || r.ask >= 100 || !r.side) {
    return { ok: false, side: r.side, endState: "UNDECIDED", pWin: null,
             confidence: 0, reason: "no usable price" };
  }
  const marketProb = r.ask / 100;                       // implied P(favoured wins)

  // momentum nudge: a live tick toward the favoured side weakly continues.
  // tick is in cents on the favoured ask; +tick (ask rising) means the crowd is
  // paying up for this side → mild continuation. Bounded hard to ±0.05.
  const momentum = clamp((r.tick || 0) / 100 * 0.5, -0.05, 0.05);
  const pWin = clamp(marketProb + momentum, 0.01, 0.99);

  // contraction confidence: three independent convergence signals, each ∈[0,1].
  const decisiveness = clamp(Math.abs(marketProb - 0.5) * 2, 0, 1);     // near a bound
  const tightness = r.spread == null ? 0.3
                  : r.spread <= 1 ? 1 : r.spread <= 2 ? 0.7
                  : r.spread <= 4 ? 0.4 : 0.1;                          // clean book
  const horizon = r.mins == null || !Number.isFinite(r.mins) ? 0.3
                : r.mins < 30 ? 1 : r.mins < 120 ? 0.8
                : r.mins < 720 ? 0.55 : r.mins < 2880 ? 0.35 : 0.2;     // near close
  const confidence = clamp(0.45 * decisiveness + 0.30 * tightness + 0.25 * horizon, 0, 1);

  const endState = pWin >= 0.5 ? r.side.toUpperCase() : (r.side === "yes" ? "NO" : "YES");
  return { ok: true, side: r.side, ask: r.ask, endState, pWin, confidence,
           marketProb, momentum, spread: r.spread, mins: r.mins };
}

/**
 * Score one card for the swipe deck.
 * opts.riskAppetite ∈ [0,1]: 0 = pure safety (lowest loss odds), 1 = pure
 *   return (largest delta). Default 0.5 balances the two — exactly the user's
 *   "largest returns AND lowest odds of losing" trade-off, made tunable.
 */
function scoreCard(card, opts = {}) {
  const risk = clamp(num(opts.riskAppetite) ?? 0.5, 0, 1);
  const es = endState(card);
  if (!es.ok) {
    return { ...card, sigma0: { ...es, score: 0 } };
  }
  const a = es.ask;                       // favoured ask, cents
  const pWin = es.pWin;
  const reward = 100 - a;                 // cents captured if right ("delta")
  const lossOdds = 1 - pWin;              // probability of losing the stake
  const ev = pWin * reward - lossOdds * a;            // expected cents per contract
  // Kelly fraction f* = p − (1−p)·a/(100−a); negative ⇒ no bet. Combines return
  // and loss-odds into one optimal-stake number.
  const kelly = reward > 0 ? pWin - lossOdds * (a / reward) : -1;

  // utility blends "largest return" (reward) and "lowest loss" (pWin) by risk
  // appetite, normalised to [0,1], then GATED by Σ₀ contraction confidence and
  // penalised hard when EV ≤ 0 (don't push losing swipes to the top).
  const rewardU = reward / 100;
  const utility = risk * rewardU + (1 - risk) * pWin;
  const evPenalty = ev > 0 ? 1 : 0.25;
  const score = clamp(utility * es.confidence * evPenalty, 0, 1);

  return {
    ...card,
    sigma0: {
      end_state: es.endState,
      p_win: +pWin.toFixed(4),
      loss_odds: +lossOdds.toFixed(4),
      reward_cents: reward,                 // capturable delta if right
      ev_cents: +ev.toFixed(2),             // expected value per contract (honest)
      kelly: +kelly.toFixed(4),
      confidence: +es.confidence.toFixed(4),
      score: +score.toFixed(4),
      positive_ev: ev > 0,
      verdict: ev <= 0 ? "SKIP_NEG_EV"
             : es.confidence < 0.4 ? "LOW_CONFIDENCE"
             : kelly > 0.1 ? "STRONG" : "MARGINAL",
    },
  };
}

/** Rank a whole deck in real time. Returns cards sorted by Σ₀ score desc. */
function rankDeck(cards, opts = {}) {
  return (cards || [])
    .map((c) => scoreCard(c, opts))
    .sort((a, b) => (b.sigma0?.score || 0) - (a.sigma0?.score || 0));
}

// ── instrument self-test: prove the ranker behaves on ground truth ────────────
function selfTest() {
  const mk = (id, side, ask, spread, mins, tick = 0) => ({
    ticker: id, favSide: side, favAsk: ask, spread, minsToClose: mins, tick,
    market: { close_time: null },
  });
  const cards = [
    mk("A_strong", "yes", 92, 1, 20, +4),    // converged favourite + momentum → +EV, STRONG, top
    mk("B_coin",   "yes", 50, 1, 20, 0),      // coin-flip, EV≈0 → mid/low
    mk("C_negev",  "yes", 50, 2, 20, -6),     // adverse momentum → genuine -EV → SKIP
    mk("D_wide",   "yes", 70, 6, 4000, 0),    // wide spread, far close → low confidence
  ];
  const ranked = rankDeck(cards, { riskAppetite: 0.5 });
  const order = ranked.map((c) => c.ticker);
  const by = (id) => ranked.find((c) => c.ticker === id).sigma0;
  const checks = {
    strong_card_on_top: order[0] === "A_strong" && by("A_strong").positive_ev,
    coin_flip_not_strong: by("B_coin").verdict !== "STRONG",
    neg_ev_flagged_and_sunk: by("C_negev").verdict === "SKIP_NEG_EV"
      && !by("C_negev").positive_ev && order.indexOf("C_negev") >= 2,
    low_confidence_downranked: by("D_wide").confidence < 0.6,
    scores_sorted_desc: ranked.every((c, i, A) => i === 0 || A[i - 1].sigma0.score >= c.sigma0.score),
  };
  return { ok: Object.values(checks).every(Boolean), checks, order, top: ranked[0].sigma0 };
}

// ── CDF-based early exit (Ouro-inspired, arXiv 2510.25741) ──────────────────
// Tracks confidence evolution across loop iterations. Exit when the cumulative
// distribution of confidence crosses a threshold (sufficient certainty) or
// plateaus (entropy collapsed — no more signal to gain from another loop).
//
// confidenceHistory: float[] of per-loop confidence scores
// threshold: exit when latest >= this (default 0.85, matching Ouro r4)
// eps: exit when |Δ| < this between last two loops (default 0.04)
function cdfExit(confidenceHistory, threshold = 0.85, eps = 0.04) {
  const n = (confidenceHistory || []).length;
  if (!n) return { exit: false, loop_n: 0, confidence: 0, reason: "no_data" };
  const latest = confidenceHistory[n - 1];
  if (latest >= threshold)
    return { exit: true, loop_n: n, confidence: latest, reason: "threshold_met" };
  if (n >= 2 && Math.abs(latest - confidenceHistory[n - 2]) < eps)
    return { exit: true, loop_n: n, confidence: latest, reason: "converged" };
  return { exit: false, loop_n: n, confidence: latest, reason: "continuing" };
}

module.exports = { endState, scoreCard, rankDeck, selfTest, readCard, cdfExit };

if (require.main === module) {
  const r = selfTest();
  const out = [
    `Σ₀ deck self-test: ${r.ok ? "PASS" : "FAIL"}`,
    `  ranked order : ${r.order.join("  >  ")}`,
    `  top card Σ₀  : ${JSON.stringify(r.top)}`,
    `  checks       : ${JSON.stringify(r.checks, null, 0)}`,
  ].join("\n");
  process.stdout.write(out + "\n");
  process.exit(r.ok ? 0 : 1);
}
