'use strict';

/**
 * direction-lock.js — one account, one direction per underlying FAMILY.
 *
 * The trading engines are longs-only in INSTRUMENTS, but an inverse ETF is an
 * economic SHORT on its underlying — so "long SQQQ" and "long QQQ/TQQQ" in the
 * same account is a hedged-with-fees contradiction (net ≈ 0 exposure, double
 * commissions, double 3× decay), and it can arise two real ways:
 *   1. sequentially inside the intraday engine (buy TQQQ in the morning uptrend;
 *      the reversal turns SQQQ trend-aligned before TQQQ's exits fire), and
 *   2. across engines (intraday holds SQQQ on a downtrend day; at 15:45 the
 *      overnight book's capitulation sleeve buys QQQ on the very same condition).
 *
 * The lock: map every instrument to (underlying family, sign), derive the
 * account's live net direction per family from its positions, and refuse any
 * ENTRY whose sign opposes existing family exposure. Closing positions is never
 * blocked (it reduces exposure). Cross-family offsets (TQQQ + TZA = long tech /
 * short small-caps) are deliberately allowed — that's relative value, not a
 * contradiction. The convex "profit whichever way it breaks" construct belongs
 * to the OPTIONS trader, not to linear ETF pairs with wide stops.
 *
 * Pure + dependency-free; both engines call `conflicts(sym, positions)`.
 */

// Instrument → { family, sign }. Unknown symbols fail OPEN as their own +1 family
// (a stock only ever conflicts with a listed inverse of itself — never invented).
const FAMILY = {
  // S&P 500
  SPY: ['SPY', 1], VOO: ['SPY', 1], IVV: ['SPY', 1], SPLG: ['SPY', 1],
  SPXL: ['SPY', 1], UPRO: ['SPY', 1], SSO: ['SPY', 1],
  SH: ['SPY', -1], SPXS: ['SPY', -1], SPXU: ['SPY', -1], SDS: ['SPY', -1],
  // Nasdaq-100
  QQQ: ['QQQ', 1], QQQM: ['QQQ', 1], TQQQ: ['QQQ', 1], QLD: ['QQQ', 1],
  SQQQ: ['QQQ', -1], PSQ: ['QQQ', -1], QID: ['QQQ', -1],
  // Russell 2000
  IWM: ['IWM', 1], TNA: ['IWM', 1], UWM: ['IWM', 1],
  TZA: ['IWM', -1], RWM: ['IWM', -1], TWM: ['IWM', -1],
  // Semiconductors
  SMH: ['SOX', 1], SOXX: ['SOX', 1], SOXL: ['SOX', 1],
  SOXS: ['SOX', -1],
  // Dow
  DIA: ['DIA', 1], UDOW: ['DIA', 1], SDOW: ['DIA', -1], DOG: ['DIA', -1],
  // Gold / bonds (no inverses in our universe, listed for completeness)
  GLD: ['GLD', 1], IAU: ['GLD', 1], GLL: ['GLD', -1],
  TLT: ['TLT', 1], TBT: ['TLT', -1], TBF: ['TLT', -1],
};

// ── LEVERAGE (#3354) ────────────────────────────────────────────────────────
// A 3x wrapper at 6% of equity carries 18% of market risk. Nothing in sizing,
// the gross cap (maxGrossPct, measured on NOTIONAL) or the family lock knew
// that, so concentration was invisible: on 2026-08-18 SMH (12.1%) + SOXL (6.0%
// notional, 18.1% beta-adjusted) put 30.2% of the book in semis at 09:30 and
// semis fell 4.33% — 67% of that day's loss, from an exposure no log reported.
//
// This map exists to MEASURE, not to constrain. The measured record is explicit
// that leverage is where the edge lives (2026-08 round trips: 3x wrappers n=17,
// +$7,647, +0.714% per trade on notional; 1x n=59, +$2,991, +0.057%) and that
// the two HIGHEST-concentration sessions were the two best days (SOXS alone at
// 53.7% beta on 8/13 and 8/14: +$2,145 and +$6,803). Every cap level tested in
// the observed range removed more profit than loss, so no cap ships — only the
// number, so a human can see 30% semis and decide.
const LEVERAGE = {
  SPXL: 3, UPRO: 3, SPXS: 3, SPXU: 3,      // S&P 3x
  TQQQ: 3, SQQQ: 3,                         // Nasdaq 3x
  TNA: 3, TZA: 3,                           // Russell 3x
  SOXL: 3, SOXS: 3,                         // Semis 3x
  UDOW: 3, SDOW: 3,                         // Dow 3x
  SSO: 2, SDS: 2, QLD: 2, QID: 2,           // 2x
  UWM: 2, TWM: 2, GLL: 2, TBT: 2,
};
/** Leverage MAGNITUDE (always positive; direction is `sign`). Unknown = 1x. */
function leverageOf(sym) {
  return LEVERAGE[String(sym || '').toUpperCase()] || 1;
}

/**
 * Beta-adjusted exposure per family, in absolute currency: |market value| x
 * leverage. This is the number the notional-based gross cap cannot see.
 * Dust (<1 share) is excluded, matching familyExposure().
 */
function familyBetaNotional(positions) {
  const out = {};
  for (const p of (positions || [])) {
    const qty = Number(p.qty) || 0;
    if (Math.abs(qty) < 1) continue;
    const mv = Math.abs(Number(p.market_value) || (qty * (Number(p.current_price) || 0)));
    if (!(mv > 0)) continue;
    const { family } = instrumentSign(p.symbol);
    out[family] = (out[family] || 0) + mv * leverageOf(p.symbol);
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

// ── RISK BUCKETS (2026-08-13) ────────────────────────────────────────────────
// The concurrency cap counts SYMBOLS, but risk is carried by DIRECTION. On
// 2026-08-13 the book held SOXS, SQQQ and SPXS simultaneously — three different
// families, so the direction-lock (which only blocks OPPOSING exposure) allowed
// all three, and the cap counted them as three independent slots. They are one
// bet: "the market falls", held in triplicate. The market rallied and all three
// lost together (-5.1%, -3.0%, -1.4%).
//
// There is a structural reason this recurs: IBS buys whatever sits at the bottom
// of its session range, and in a rally that is ALWAYS the inverse ETFs. So the
// engine drifts into concentrated short exposure precisely when it is most
// wrong. Bucketing makes that exposure countable.
//
// Equity-correlated families collapse to equity_long / equity_short. Precious
// metals move together and get their own bucket. Everything else (bonds, an
// unknown symbol) is its own bucket — correlation we cannot assert, we do not.
const EQUITY_FAMILIES = new Set([
  'SPY', 'QQQ', 'IWM', 'SOX', 'DIA',                                  // broad + semis
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLU', 'XLY', 'XLP',             // sectors
  'EEM', 'EFA',                                                        // international
]);
const METALS = new Set(['GLD', 'SLV', 'GDX']);

/** Which correlated risk bucket an instrument belongs to. */
function riskBucket(sym) {
  const { family, sign } = instrumentSign(sym);
  if (METALS.has(family)) return 'metals';
  if (EQUITY_FAMILIES.has(family)) return sign < 0 ? 'equity_short' : 'equity_long';
  return family;                                    // bonds, unknowns: own bucket
}

/** Count of REAL positions per risk bucket. Dust is excluded for the same reason
 *  familyExposure excludes it: an untradeable stub is not exposure. */
function bucketCounts(positions) {
  const out = {};
  for (const p of (positions || [])) {
    if (Math.abs(Number(p.qty) || 0) < 1) continue;
    const b = riskBucket(p.symbol);
    out[b] = (out[b] || 0) + 1;
  }
  return out;
}

/** { family, sign } for an instrument; unknowns are their own +1 family. */
function instrumentSign(sym) {
  const s = String(sym || '').toUpperCase();
  const hit = FAMILY[s];
  return hit ? { family: hit[0], sign: hit[1] } : { family: s, sign: 1 };
}

// The 1x instrument that carries each family's ACTUAL market signal. A levered
// or inverse wrapper is a derivative of this price series; any market-semantic
// computation (washout, regime, trend) done on the wrapper's own bars is either
// amplified or MIRRORED. The mirror case is the dangerous one: a -3x wrapper's
// session low is the underlying's session high, so "SOXS washed out" read off
// SOXS bars means "semis at their session HIGH" (#3295 — measured at the fire
// moments: median underlying IBS 0.90, 94% in the top third, 0% actually washed
// out). The same class of bug was hit before in the lab: regime derived from
// SQQQ's own SMA-200 inverted the gate and "silently made every inverse-ETF
// result meaningless" (spy_engine_backtest.js header).
/**
 * The opposite-sign instrument in the same family at the SAME leverage — the
 * symbol a regime-aware redirect would substitute (#3390: the washout trigger
 * structurally cannot fire an inverse on the day it pays, so the only way to
 * express "down day" is to flip a LONG fire to its mirror). Derived from
 * FAMILY + LEVERAGE so a new wrapper added above is mirrored automatically.
 * null when the family has no same-leverage opposite in the universe.
 */
const MIRROR = (() => {
  const out = {};
  for (const [sym, [fam, sign]] of Object.entries(FAMILY)) {
    const lev = LEVERAGE[sym] || 1;
    for (const [cand, [f2, s2]] of Object.entries(FAMILY)) {
      if (f2 === fam && s2 === -sign && (LEVERAGE[cand] || 1) === lev) { out[sym] = cand; break; }
    }
  }
  return out;
})();
function mirrorOf(sym) { return MIRROR[String(sym || '').toUpperCase()] || null; }

const FAMILY_PROXY = {
  SPY: 'SPY', QQQ: 'QQQ', IWM: 'IWM', SOX: 'SMH', DIA: 'DIA', GLD: 'GLD', TLT: 'TLT',
};

/** The 1x proxy whose bars carry the family's market signal (null if unknown). */
function underlyingProxy(sym) {
  const { family } = instrumentSign(sym);
  return FAMILY_PROXY[family] || null;
}

/** Net direction per family from live positions: { FAMILY: -1|1 } (0 net → absent).
 *  positions: [{ symbol, qty }] — negative qty (a real short) flips the sign.
 *  Sub-share DUST (|qty| < 1) is ignored: IBKR structurally cannot trade a
 *  fractional-only position (the 0.8-share SOXS remnant froze its own exits and
 *  then vetoed every semiconductor long via this exposure map, 2026-08-03) — an
 *  untradeable stub is not real directional exposure. */
function familyExposure(positions) {
  const score = {};
  for (const p of (positions || [])) {
    const qty = Number(p.qty) || 0;
    if (Math.abs(qty) < 1) continue;   // untradeable dust — not exposure
    const { family, sign } = instrumentSign(p.symbol);
    score[family] = (score[family] || 0) + sign * qty;
  }
  const out = {};
  for (const [fam, s] of Object.entries(score)) { if (s > 0) out[fam] = 1; else if (s < 0) out[fam] = -1; }
  return out;
}

/**
 * Would ENTERING (buying) `sym` oppose existing family exposure?
 * Returns { conflict, family, entrySign, existingSign, against:[symbols] }.
 */
function conflicts(sym, positions) {
  const { family, sign } = instrumentSign(sym);
  const exposure = familyExposure(positions);
  const existing = exposure[family];
  if (existing == null || existing === sign) {
    return { conflict: false, family, entrySign: sign, existingSign: existing == null ? 0 : existing, against: [] };
  }
  const against = (positions || [])
    .filter((p) => (Number(p.qty) || 0) !== 0 && instrumentSign(p.symbol).family === family && instrumentSign(p.symbol).sign !== sign)
    .map((p) => String(p.symbol).toUpperCase());
  return { conflict: true, family, entrySign: sign, existingSign: existing, against };
}

module.exports = { FAMILY, LEVERAGE, leverageOf, familyBetaNotional, instrumentSign, underlyingProxy, mirrorOf, familyExposure, conflicts, riskBucket, bucketCounts, EQUITY_FAMILIES, METALS };
