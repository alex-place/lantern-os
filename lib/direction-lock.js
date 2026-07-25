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

/** { family, sign } for an instrument; unknowns are their own +1 family. */
function instrumentSign(sym) {
  const s = String(sym || '').toUpperCase();
  const hit = FAMILY[s];
  return hit ? { family: hit[0], sign: hit[1] } : { family: s, sign: 1 };
}

/** Net direction per family from live positions: { FAMILY: -1|1 } (0 net → absent).
 *  positions: [{ symbol, qty }] — negative qty (a real short) flips the sign. */
function familyExposure(positions) {
  const score = {};
  for (const p of (positions || [])) {
    const qty = Number(p.qty) || 0;
    if (!qty) continue;
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

module.exports = { FAMILY, instrumentSign, familyExposure, conflicts };
