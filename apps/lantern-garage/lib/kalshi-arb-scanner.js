"use strict";

/**
 * Kalshi cross-contract arbitrage scanner (P2-3, docs/TRADER-ANALYSIS-2026-07.md).
 *
 * The one edge on a prediction market that does NOT depend on forecasting anything is a
 * DUTCH BOOK: when a set of mutually-exclusive, collectively-exhaustive contracts is priced
 * so their combined cost is below the guaranteed $1 payout, buying the whole set locks in a
 * risk-free profit regardless of the outcome. The open-source Kalshi bots surveyed don't scan
 * for this; it's pure structure, not prediction, so it's the highest-confidence "edge" there is.
 *
 * This module finds two forms, both NET OF FEES (a gross Dutch book that fees erase is not an
 * arb — the whole point of the 2026-07 analysis):
 *
 *   1. Exhaustive-partition arb — a ladder where exactly ONE bucket resolves YES (e.g. a
 *      temperature ladder that tiles every range). Buy 1 YES in every bucket: exactly one pays
 *      100¢, so profit = 100 − Σ(yes_ask) − Σ(entry fees). Requires a TRUE partition; the
 *      caller asserts it (`exhaustive:true`) because Kalshi also lists overlapping "above X"
 *      markets that are NOT mutually exclusive.
 *
 *   2. Complementary-pair arb — two binary markets where YES(A) ⇔ NO(B) (logically the same
 *      event). Buy YES(A) + NO(B): exactly one pays 100¢, so profit = 100 − yes_ask(A) −
 *      no_ask(B) − fees. Handles the common two-market Dutch book without partition detection.
 *
 * Honesty: never fabricates a fill. A leg with no ask (empty book) makes the group
 * un-actionable and it is skipped, not assumed fillable at some made-up price.
 */

const { takerFeeCents } = require("./kalshi-fees");

function _num(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** yes_ask / no_ask in cents for a market object, tolerating cents and dollar fields. */
function askCents(market, side) {
  if (!market) return null;
  const base = side === "no" ? "no_ask" : "yes_ask";
  const cents = _num(market[base]);
  if (cents != null) return cents;
  const d = _num(market[base + "_dollars"]);
  return d == null ? null : Math.round(d * 100);
}

/**
 * partitionArb — scan a set of markets that partition ONE event (exactly one resolves YES).
 * Buys 1 YES contract in every bucket. Returns the lock-in economics, net of entry fees.
 *
 * @param {object[]} markets  the buckets (each with yes_ask[_dollars])
 * @param {object}  opts.contracts   contracts per leg (default 1)
 * @param {boolean} opts.exhaustive  caller's assertion this IS a true partition (required true)
 * @returns {{arb:boolean, ...}}  or {arb:false, reason} when un-actionable
 */
function partitionArb(markets, { contracts = 1, exhaustive = false, multiplier } = {}) {
  if (!exhaustive) return { arb: false, reason: "not asserted exhaustive — refusing to assume a partition" };
  if (!Array.isArray(markets) || markets.length < 2) return { arb: false, reason: "need ≥2 buckets" };
  const asks = markets.map((m) => askCents(m, "yes"));
  if (asks.some((a) => a == null)) return { arb: false, reason: "a bucket has no yes ask (empty book)" };
  const n = contracts;
  const grossCostCents = asks.reduce((s, a) => s + a, 0) * n;
  const feeCents = asks.reduce((s, a) => s + takerFeeCents(a, n, multiplier), 0);
  const payoutCents = 100 * n;                 // exactly one bucket pays 100¢ per contract
  const netProfitCents = payoutCents - grossCostCents - feeCents;
  return {
    arb: netProfitCents > 0,
    kind: "exhaustive-partition",
    legs: markets.length,
    contracts: n,
    grossCostCents,
    feeCents,
    payoutCents,
    netProfitCents,
    // guaranteed return on the capital actually outlaid (cost + fees)
    roi: Number((netProfitCents / (grossCostCents + feeCents)).toFixed(4)),
    tickers: markets.map((m) => m.ticker || null),
  };
}

/**
 * complementaryArb — two markets where YES(A) resolves iff NO(B) resolves (same event).
 * Buy YES(A) + NO(B): exactly one pays 100¢. Net of entry fees.
 */
function complementaryArb(a, b, { contracts = 1, multiplier } = {}) {
  const aYes = askCents(a, "yes");
  const bNo = askCents(b, "no");
  if (aYes == null || bNo == null) return { arb: false, reason: "a leg has no ask (empty book)" };
  const n = contracts;
  const grossCostCents = (aYes + bNo) * n;
  const feeCents = takerFeeCents(aYes, n, multiplier) + takerFeeCents(bNo, n, multiplier);
  const payoutCents = 100 * n;
  const netProfitCents = payoutCents - grossCostCents - feeCents;
  return {
    arb: netProfitCents > 0,
    kind: "complementary-pair",
    contracts: n,
    grossCostCents,
    feeCents,
    payoutCents,
    netProfitCents,
    roi: Number((netProfitCents / (grossCostCents + feeCents)).toFixed(4)),
    tickers: [a && a.ticker, b && b.ticker],
  };
}

/**
 * scan — run partitionArb over caller-provided partition groups and complementaryArb over
 * caller-provided pairs, returning only the opportunities that clear fees (profit > 0),
 * best ROI first. Grouping/pairing is the caller's domain knowledge; the math is here.
 *
 * @param {object} input.partitions  [{ markets:[...], contracts? }]  each an asserted partition
 * @param {object} input.pairs       [{ a, b, contracts? }]           each a complementary pair
 */
function scan({ partitions = [], pairs = [], contracts = 1, multiplier } = {}) {
  const found = [];
  for (const g of partitions) {
    const r = partitionArb(g.markets, { contracts: g.contracts || contracts, exhaustive: true, multiplier });
    if (r.arb) found.push(r);
  }
  for (const p of pairs) {
    const r = complementaryArb(p.a, p.b, { contracts: p.contracts || contracts, multiplier });
    if (r.arb) found.push(r);
  }
  found.sort((x, y) => y.roi - x.roi);
  return { count: found.length, opportunities: found };
}

module.exports = { partitionArb, complementaryArb, scan, askCents };
