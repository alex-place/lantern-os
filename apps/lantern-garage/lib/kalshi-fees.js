/**
 * Kalshi fee + expected-value model — the grounded gate for trade suggestions.
 *
 * Σ₀ rule: a "buy" suggestion is an important claim, so it needs evidence. A binary
 * contract is only worth taking when its expected value is positive AFTER fees — win
 * rate alone is a trap (you can win 53% of the time and still lose money if the wins
 * are small and the losses are full). This module is the external-reality anchor the
 * suggestion engine checks before it presents a card.
 *
 * FEE FORMULA (Kalshi published Feb-2026 fee schedule):
 *     fee = roundup_to_cent( multiplier × C × P × (1 − P) )
 *   - P = price in dollars (0..1), C = contracts, multiplier = 0.07 for standard
 *     markets (some series 0.035; crypto/premium higher). Rounded UP to the next cent
 *     on the total order.
 *   - The per-contract fee peaks at P=0.50: 0.07 × 0.25 = 0.0175 → ~1.75¢/contract.
 *   Sources (fetched 2026-06-29):
 *     https://kalshi.com/fee-schedule
 *     https://pm.wiki/learn/kalshi-fees-explained
 *     https://marketmath.io/blog/kalshi-fees-guide-2026
 *
 * BREAK-EVEN: buying at price p (in prob), payout $1, the win probability needed to
 * break even is p PLUS the fee fraction — on Kalshi that pushes a 50¢ contract's
 * breakeven from 50% to ~51.75%. Source: https://marketmath.io/tools/breakeven-calculator
 *
 *     netEV_per_contract = w·(1−p) − (1−w)·p − fee = (w − p) − feeFraction(p)
 *     +EV  ⟺  w > p + feeFraction(p) = breakevenWinProb(p)
 */

"use strict";

const STANDARD_MULTIPLIER = 0.07;

function _clampPrice(priceCents) {
  const c = Number(priceCents);
  if (!Number.isFinite(c)) return null;
  return Math.min(99, Math.max(1, c));
}

/**
 * Per-contract fee as a probability fraction (== dollars, since payout is $1).
 * This is the UN-rounded marginal rate; real order fees round up per order, so this
 * is a conservative lower bound used for break-even / EV gating.
 */
function feeFraction(priceCents, multiplier = STANDARD_MULTIPLIER) {
  const c = _clampPrice(priceCents);
  if (c == null) return 0;
  const p = c / 100;
  return multiplier * p * (1 - p);
}

/** Taker fee in cents for `contracts` at `priceCents`, rounded UP to the cent per Kalshi. */
function takerFeeCents(priceCents, contracts = 1, multiplier = STANDARD_MULTIPLIER) {
  const c = _clampPrice(priceCents);
  if (c == null) return 0;
  const p = c / 100;
  const raw = multiplier * contracts * p * (1 - p); // dollars
  // Round up to the next cent, but absorb float error first so an exact $1.75 doesn't
  // ceil to 176¢ (0.07*0.5*0.5 = 0.017500000000000002 in IEEE-754).
  const cents = Number((raw * 100).toFixed(6));
  return Math.ceil(cents);
}

/**
 * Fee-aware break-even win probability for BUYING at `priceCents`.
 * roundTrip=true adds an exit-side fee priced at the same level (sell-before-settle);
 * settlement itself is fee-free, so entry-only is the honest minimum.
 */
function breakevenWinProb(priceCents, { roundTrip = false, multiplier = STANDARD_MULTIPLIER } = {}) {
  const c = _clampPrice(priceCents);
  if (c == null) return 1;
  const p = c / 100;
  const fee = feeFraction(priceCents, multiplier) * (roundTrip ? 2 : 1);
  return Math.min(1, p + fee);
}

/**
 * Net expected value per contract (in cents) given an estimated win probability `winProb`.
 * Returns negative when the trade loses money after fees.
 */
function netEvCents(priceCents, winProb, { roundTrip = false, multiplier = STANDARD_MULTIPLIER } = {}) {
  const c = _clampPrice(priceCents);
  if (c == null || !Number.isFinite(winProb)) return null;
  const p = c / 100;
  const w = Math.min(1, Math.max(0, winProb));
  const fee = feeFraction(priceCents, multiplier) * (roundTrip ? 2 : 1);
  return Math.round(((w - p) - fee) * 100 * 10) / 10; // cents, 1dp
}

/** True iff buying at `priceCents` with estimated `winProb` is +EV after fees (+ margin). */
function isPositiveEv(priceCents, winProb, { roundTrip = false, multiplier = STANDARD_MULTIPLIER, marginFrac = 0 } = {}) {
  const w = Math.min(1, Math.max(0, Number(winProb)));
  return w > breakevenWinProb(priceCents, { roundTrip, multiplier }) + marginFrac;
}

module.exports = {
  STANDARD_MULTIPLIER,
  feeFraction,
  takerFeeCents,
  breakevenWinProb,
  netEvCents,
  isPositiveEv,
};
