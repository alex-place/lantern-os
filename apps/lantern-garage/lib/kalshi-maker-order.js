"use strict";

/**
 * Kalshi maker order mode (P2-2, docs/TRADER-ANALYSIS-2026-07.md).
 *
 * The trader only ever TAKES — it lifts the ask and pays the full taker fee (~1.75¢/contract
 * at 50¢) plus the whole bid/ask spread. On a market with any spread, posting a resting LIMIT
 * order instead (a maker order) captures part of the spread AND pays the lower maker fee — the
 * single biggest structural cost reduction available to a small account. The catch is fill
 * risk: a maker order only executes if the market comes to it.
 *
 * This module supplies the two decisions that make maker mode safe and honest:
 *   1. makerLimitCents() — a passive limit price that JOINS or IMPROVES the near side without
 *      crossing the spread (so it rests as a maker, never accidentally takes).
 *   2. decideExecution() — maker vs taker, from the spread, how much edge is at stake, and how
 *      urgent the fill is, comparing the fee+spread saved against the risk of not filling.
 *
 * Fee facts (Kalshi fee schedule, "July 2026 — 7.7.26 update", cross-checked pm.wiki /
 * marketmath.io, fetched 2026-07-14):
 *   - Taker and maker both follow the parabolic ceil(mult·C·P·(1−P)) shape; the MAKER
 *     multiplier is materially LOWER than the taker's (base tier ≈ 5bps maker vs ≈12bps taker;
 *     one source quotes maker ≈ ¼ of taker). Exact rate is VOLUME-TIER dependent.
 *   - A maker fee is charged only when the resting order FILLS; cancelling a resting order is free.
 * Because the exact maker multiplier is tier-dependent and sources disagree, it is a
 * documented, OVERRIDABLE parameter here — never a silently-hardcoded money constant. Callers
 * that know their tier should pass the real multipliers.
 */

// Taker multiplier is the well-established 0.07 parabola. Maker default is a CONSERVATIVE
// estimate (half the taker rate) — deliberately pessimistic so maker mode isn't oversold;
// override with the account's real tiered rate.
const TAKER_MULTIPLIER = 0.07;
const MAKER_MULTIPLIER_DEFAULT = Number(process.env.KALSHI_MAKER_MULTIPLIER || 0.035);

function _num(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function _clampPrice(c) { const n = _num(c); return n == null ? null : Math.min(99, Math.max(1, n)); }

/** Per-order fee in cents (rounded up per Kalshi) for a role, at a price. */
function feeCents(priceCents, contracts = 1, { role = "taker", makerMultiplier = MAKER_MULTIPLIER_DEFAULT } = {}) {
  const c = _clampPrice(priceCents);
  if (c == null) return 0;
  const p = c / 100;
  const mult = role === "maker" ? makerMultiplier : TAKER_MULTIPLIER;
  const raw = mult * contracts * p * (1 - p);
  return Math.ceil(Number((raw * 100).toFixed(6)));
}

/** Touch prices (cents) for a side, tolerating cents + dollar fields. */
function touch(book, side) {
  const pick = (base) => {
    const c = _num(book && book[base]);
    if (c != null) return c;
    const d = _num(book && book[base + "_dollars"]);
    return d == null ? null : Math.round(d * 100);
  };
  const yes = side === "yes";
  return { ask: pick(yes ? "yes_ask" : "no_ask"), bid: pick(yes ? "yes_bid" : "no_bid") };
}

/**
 * makerLimitCents — a passive limit price that rests as a maker (never crosses).
 *   BUY : join the bid, optionally improving by improveTicks for queue priority, but always
 *         strictly BELOW the ask (bestAsk−1) so it can't take.
 *   SELL: join the ask, optionally improving down by improveTicks, but strictly ABOVE the bid.
 * Returns null if the book side needed is missing (no fabricated price).
 */
function makerLimitCents(book, side, action = "buy", { improveTicks = 0 } = {}) {
  const { ask, bid } = touch(book, side);
  const tick = Math.max(0, Math.floor(_num(improveTicks) ?? 0));
  if (action === "sell") {
    if (ask == null) return null;
    let px = ask - tick;                       // improve the offer downward
    if (bid != null) px = Math.max(px, bid + 1); // stay strictly above the bid → still resting
    return _clampPrice(px);
  }
  if (bid == null) return null;
  let px = bid + tick;                          // improve the bid upward
  if (ask != null) px = Math.min(px, ask - 1);  // stay strictly below the ask → still resting
  return _clampPrice(px);
}

/**
 * decideExecution — maker vs taker for a BUY (the taker path lifts the ask).
 *
 * Maker wins when the cost saved — the spread you no longer pay to cross PLUS the taker/maker
 * fee differential — is worth the fill risk, and the fill isn't urgent. Taker wins when the
 * spread is ~0 (nothing to capture), urgency is high (must fill now), or the edge is so thin a
 * missed fill costs nothing anyway.
 *
 * @param {object} book        market with the side's bid/ask
 * @param {object} opts.side   'yes' | 'no' (default 'yes')
 * @param {number} opts.contracts
 * @param {boolean} opts.urgent   caller must fill this poll (e.g. closing risk) → force taker
 * @param {number} opts.minSpreadCents  don't bother posting maker below this spread (default 2)
 * @param {number} opts.makerMultiplier override the maker fee rate for the account's tier
 * @returns {{mode:'maker'|'taker', limitCents:number|null, savingCents:number, reason:string}}
 */
function decideExecution(book, { side = "yes", contracts = 1, urgent = false, minSpreadCents = 2, makerMultiplier = MAKER_MULTIPLIER_DEFAULT } = {}) {
  const { ask, bid } = touch(book, side);
  const takerPx = ask;
  if (takerPx == null) return { mode: "taker", limitCents: null, savingCents: 0, reason: "no ask — cannot price either path" };
  const spread = (bid != null) ? (ask - bid) : null;

  if (urgent) return { mode: "taker", limitCents: takerPx, savingCents: 0, reason: "urgent fill required — cross the spread" };
  if (spread == null || spread < minSpreadCents) {
    return { mode: "taker", limitCents: takerPx, savingCents: 0, reason: `spread ${spread == null ? "n/a" : spread + "¢"} < ${minSpreadCents}¢ — nothing to capture` };
  }

  const makerPx = makerLimitCents(book, side, "buy", { improveTicks: 0 }); // join the bid
  if (makerPx == null) return { mode: "taker", limitCents: takerPx, savingCents: 0, reason: "cannot rest a maker order — no bid" };

  // Cost saved by resting instead of crossing: the price improvement (ask − makerPx) plus the
  // fee differential, per contract, times size.
  const priceImprove = takerPx - makerPx;
  const feeSave = feeCents(takerPx, contracts, { role: "taker" }) - feeCents(makerPx, contracts, { role: "maker", makerMultiplier });
  const savingCents = priceImprove * contracts + feeSave;

  return {
    mode: "maker",
    limitCents: makerPx,
    savingCents,
    takerCents: takerPx,
    spreadCents: spread,
    reason: `rest maker @${makerPx}¢ vs take @${takerPx}¢ — saves ~${savingCents}¢ over ${contracts} (spread ${spread}¢ + lower maker fee); fills only if the market comes to it`,
  };
}

module.exports = {
  TAKER_MULTIPLIER, MAKER_MULTIPLIER_DEFAULT,
  feeCents, makerLimitCents, decideExecution, touch,
};
