"use strict";

/**
 * ForecastEx fee rail (#2217). IBKR ForecastEx charges a flat ~$0.01 per contract — a
 * fraction of Kalshi's price-dependent fee (kalshiFeeCents = ceil(7·p·(1−p)), up to ~1.75¢
 * at mid-price). The weather edge was thin *relative to Kalshi's fee*, not weak: on the
 * cheaper rail more of the same raw edge survives the band-robust net-of-fees gate.
 *
 * Shape matches kalshiFeeCents(price)->cents so it drops straight into robustEdgeReport's
 * injectable `feeCents` argument. Flat means price-independent; NOT floored to 1¢ (unlike
 * Kalshi) so a genuinely sub-cent venue fee is represented honestly.
 *
 * The exact fee is a probe/verify input, not a hard fact yet — #2216 confirms the real
 * per-contract cost. Default 1.0¢ ($0.01) is the issue's stated estimate; override once
 * the probe measures it, or via FORECASTEX_FEE_CENTS.
 */

const DEFAULT_FEE_CENTS = (() => {
  const v = Number(process.env.FORECASTEX_FEE_CENTS);
  return Number.isFinite(v) && v >= 0 ? v : 1.0; // $0.01/contract
})();

/** Flat-fee function factory. Returns feeCents(price)->cents, ignoring price. */
function makeFlatFee(centsPerContract = DEFAULT_FEE_CENTS) {
  const c = Number.isFinite(centsPerContract) && centsPerContract >= 0 ? centsPerContract : DEFAULT_FEE_CENTS;
  return function forecastExFeeCents(_price) { return c; };
}

// Ready-to-inject default (used until the #2216 probe measures the real per-contract fee).
const forecastExFeeCents = makeFlatFee();

module.exports = { forecastExFeeCents, makeFlatFee, DEFAULT_FEE_CENTS };
