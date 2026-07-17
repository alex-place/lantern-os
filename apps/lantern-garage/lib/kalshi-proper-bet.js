/**
 * Proper-betting stake sizing for binary prediction markets (Kalshi) — the
 * theorem-backed replacement for Kelly sizing on order-book markets.
 *
 * Theorem reference: Gu, Kagan, Sun, Wu & Xu, "When do prophets profit in
 * prediction markets?", arXiv:2607.06166 (2026).
 *   - Definition 2 (proper betting): for a strictly proper scoring rule S with
 *     convex potential G (Proposition 1: S(p,y) = G(p) + ∇G(p)·(1_y − p)), the
 *     proper bet on forecast p against market price q is the position vector
 *         s_G(p, q) = ∇G(p) − ∇G(q).
 *   - Theorem 1 (robust profitability): its expected profit decomposes as
 *         π = [S(p;p*) − S(q;p*)]  +  D_G(q, p)  −  L_ρ(s; q)
 *            (score gap)            (Bregman ≥ 0)   (liquidity loss ≥ 0)
 *     so expected profit is ≥ 0 whenever p outperforms q under S AND the
 *     Bregman divergence covers the liquidity loss. Theorem 2: up to rescaling
 *     (λ·s) and constant shifts (s + λ·1) this is the ONLY strategy with that
 *     robust guarantee — Kelly and max-margin both fail it (paper Ex. 1–2).
 *   - §3.3.4 (bid-ask spreads): with separate executable prices, the proper bet
 *     buys YES only when p > yesAsk, buys NO only when (1 − p) > noAsk, and
 *     honestly does NOT trade inside the spread deadband.
 *
 * Binary (K = 2) instantiation implemented here, reduced to a single leg via
 * the profitability-invariant constant shift s → s − s_no·1:
 *   - Brier / quadratic rule: G(p) = p² + (1−p)²   → stake magnitude ∝ |p − q|
 *   - Log rule:               G(p) = Σ p·ln p      → stake magnitude ∝ |logit(p) − logit(q)|
 * Both variants pick the same SIDE (sign(p − q)) but size differently: the log
 * rule weights a fixed margin |p − q| far more heavily near the price boundary
 * (logit blows up as q → 0 or 1), the Brier rule sizes purely on the margin
 * (paper Remark 5 / Table 1 — bet sizes must vary across events ∝ ∇G(p) − ∇G(q)).
 *
 * Bankroll mapping (the free λ of Theorem 2): the theorem pins down RELATIVE
 * sizing across markets, not the absolute scale, so we choose λ such that a
 * 0.9-vs-0.1 disagreement stakes `maxFraction` (default 10%) of the bankroll
 * under either rule, and cap there. Relative sizing below the cap is exactly
 * the paper's s_G.
 *
 * LIQUIDITY CAVEAT: the profitability guarantee holds only while the Bregman
 * divergence D_G(q,p) covers the liquidity loss L_ρ (slippage from walking the
 * book) — Theorem 1's condition. This module prices at the quoted ask with NO
 * depth model, so treat the stake as valid only when it is small relative to
 * resting size at top of book; thin books void the guarantee. The suggestion
 * engine's ≤2¢-spread gate bounds the spread cost but does NOT verify depth.
 *
 * ADVISORY SIZING ONLY — this module places no orders and is wired only into
 * the suggestion payload; live trading stays behind the existing dry-run /
 * kill-switch gates.
 */

"use strict";

// A 0.9-vs-0.1 disagreement maps to the full per-market fraction (see header).
const DEFAULT_MAX_FRACTION = 0.1;
const FULL_SCALE_PAIR = [0.9, 0.1];

function logit(x) {
  return Math.log(x / (1 - x));
}

// Per-rule pieces, all expressed in "traded-side space" (the side being bought
// plays the role of YES; both rules are invariant under that relabeling).
//   magnitude(p, q): single-leg reduction of s_G(p,q) = ∇G(p) − ∇G(q), > 0 for p > q
//   expScore(x, p) : expected score E_{y~p}[S(x, y)] of reporting x under belief p
const RULES = {
  brier: {
    // G(p) = p² + (1−p)²  → ∇G leg gap ∝ (p − q); constant factor dropped
    // (rescaling is profitability-invariant, Theorem 2).
    magnitude: (p, q) => p - q,
    // S(x,y) = 2·x_y − (x² + (1−x)²)
    expScore: (x, p) => 2 * (p * x + (1 - p) * (1 - x)) - (x * x + (1 - x) * (1 - x)),
  },
  log: {
    // G(p) = p·ln p + (1−p)·ln(1−p)  → leg gap = logit(p) − logit(q)
    magnitude: (p, q) => logit(p) - logit(q),
    // S(x,y) = ln x_y
    expScore: (x, p) => p * Math.log(x) + (1 - p) * Math.log(1 - x),
  },
};
for (const r of Object.values(RULES)) {
  r.fullScale = r.magnitude(FULL_SCALE_PAIR[0], FULL_SCALE_PAIR[1]);
}

function isProb(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0 && x < 1;
}

/**
 * Size one advisory proper bet on a binary market.
 *
 * @param {object} opts
 * @param {number} opts.forecast    P(YES) per the forecaster, strictly in (0,1)
 * @param {number} opts.price       executable YES buy price (prob units, e.g. yes_ask/100), in (0,1)
 * @param {number} [opts.noPrice]   executable NO buy price (prob units, e.g. no_ask/100);
 *                                  defaults to 1 − price (frictionless book). Passing the real
 *                                  no-ask enables the §3.3.4 spread deadband.
 * @param {number} opts.bankroll    advisory bankroll in dollars, > 0
 * @param {string} [opts.rule]      "brier" (alias "quadratic") | "log"; default "brier"
 * @param {number} [opts.maxFraction] per-market bankroll cap in (0,1]; default 0.1
 *
 * @returns {{ok:false, reason:string}} on degenerate inputs, else
 * {{
 *   ok:true, rule:string,
 *   side:"yes"|"no"|null,             // null ⇒ honest no-trade
 *   contracts:number,                 // whole contracts (floor)
 *   stakeDollars:number,              // contracts × cost, 0 when no trade
 *   costPerContractDollars:number|null,
 *   targetFraction:number,            // pre-floor fraction of bankroll the rule asks for
 *   magnitude:number,                 // single-leg |∇G(p) − ∇G(q)| in traded-side space
 *   edge:{forecastScore:number, marketScore:number, scoreGap:number}|null,
 *     // S(p;p) vs S(q;p) under the forecaster's own belief (ground truth is
 *     // unobservable); scoreGap = D_G(p,q) > 0 whenever a side is traded
 *   expectedProfitPerContract:number, // frictionless, under belief p: pSide − qSide
 *   zeroReason:null|"no-edge"|"inside-spread"|"stake-below-one-contract"
 * }}
 */
function properBetSize({ forecast, price, noPrice, bankroll, rule = "brier", maxFraction = DEFAULT_MAX_FRACTION } = {}) {
  const ruleKey = rule === "quadratic" ? "brier" : rule;
  const R = RULES[ruleKey];
  if (!R) return { ok: false, reason: `unknown scoring rule "${rule}" (use "brier" or "log")` };
  if (!isProb(forecast)) return { ok: false, reason: `forecast must be a probability strictly in (0,1), got ${forecast}` };
  if (!isProb(price)) return { ok: false, reason: `price must be a probability strictly in (0,1), got ${price}` };
  if (noPrice === undefined || noPrice === null) noPrice = 1 - price;
  if (!isProb(noPrice)) return { ok: false, reason: `noPrice must be strictly in (0,1), got ${noPrice}` };
  if (typeof bankroll !== "number" || !Number.isFinite(bankroll) || bankroll <= 0) {
    return { ok: false, reason: `bankroll must be a finite positive number, got ${bankroll}` };
  }
  if (typeof maxFraction !== "number" || !Number.isFinite(maxFraction) || maxFraction <= 0 || maxFraction > 1) {
    return { ok: false, reason: `maxFraction must be in (0,1], got ${maxFraction}` };
  }

  // §3.3.4 side selection with executable prices: buy YES iff p > yesAsk,
  // buy NO iff (1 − p) > noAsk, otherwise no executable edge under the rule.
  let side = null;
  if (forecast > price) side = "yes";
  else if (1 - forecast > noPrice) side = "no";

  if (!side) {
    const frictionless = Math.abs(price + noPrice - 1) < 1e-12;
    return {
      ok: true, rule: ruleKey, side: null, contracts: 0, stakeDollars: 0,
      costPerContractDollars: null, targetFraction: 0, magnitude: 0,
      edge: null, expectedProfitPerContract: 0,
      zeroReason: frictionless ? "no-edge" : "inside-spread",
    };
  }

  // Work in traded-side space: the bought side plays the role of YES.
  const pS = side === "yes" ? forecast : 1 - forecast; // P(bought side pays)
  const qS = side === "yes" ? price : noPrice;         // cost per contract, dollars

  const magnitude = R.magnitude(pS, qS);               // > 0 by side selection
  const targetFraction = maxFraction * Math.min(1, magnitude / R.fullScale);
  const contracts = Math.floor((bankroll * targetFraction) / qS + 1e-9);
  const stakeDollars = Math.round(contracts * qS * 100) / 100;

  const forecastScore = R.expScore(pS, pS);
  const marketScore = R.expScore(qS, pS);

  return {
    ok: true,
    rule: ruleKey,
    side,
    contracts,
    stakeDollars,
    costPerContractDollars: qS,
    targetFraction,
    magnitude,
    edge: {
      forecastScore,
      marketScore,
      scoreGap: forecastScore - marketScore, // = D_G(p, q) in side space, > 0
    },
    expectedProfitPerContract: pS - qS,
    zeroReason: contracts === 0 ? "stake-below-one-contract" : null,
  };
}

module.exports = { properBetSize, DEFAULT_MAX_FRACTION };
