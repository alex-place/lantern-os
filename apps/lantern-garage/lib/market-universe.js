'use strict';

/**
 * market-universe.js — the list of symbols the movers board ranks (2026-10-11).
 *
 * WHY A LIST AND NOT "THE MARKET". We have no screener. The quote client fetches a
 * batch you hand it (market-data-yahoo.getQuotes), so a movers board has to name its
 * universe. The honest consequence is that this board reports the biggest movers IN
 * THIS LIST, and the page says exactly that rather than implying it swept the exchange.
 *
 * WHAT IS IN IT. Large, liquid US names a reader would recognise, plus the index,
 * sector and leveraged ETFs the engine actually trades — so the board is useful to the
 * same person the rest of the site is for, and the engine's own names are never missing
 * from it. Every symbol here is one the quote client can price; a symbol it cannot
 * price simply drops out of the result rather than rendering as a blank row.
 *
 * KEEPING IT HONEST. This is a curated list, not an index membership, and it will drift
 * as companies do. It is not a recommendation: inclusion says "liquid enough to rank",
 * nothing more. Changing it changes what the board can report, so it is one list in one
 * file rather than a literal inside a route.
 */

// ── Mega/large-cap equities ──────────────────────────────────────────────────────
// (Block trades as XYZ since January 2025; SQ no longer prices, and dropped silently.)
const EQUITIES = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'BRK-B', 'LLY',
  'JPM', 'V', 'UNH', 'XOM', 'MA', 'COST', 'HD', 'PG', 'JNJ', 'ABBV',
  'WMT', 'NFLX', 'CRM', 'BAC', 'AMD', 'KO', 'PEP', 'TMO', 'LIN', 'ADBE',
  'CSCO', 'MCD', 'ACN', 'ABT', 'ORCL', 'DIS', 'INTC', 'QCOM', 'TXN', 'INTU',
  'CAT', 'GE', 'VZ', 'AMGN', 'PFE', 'IBM', 'NOW', 'UBER', 'BA', 'GS',
  'MU', 'PLTR', 'COIN', 'SHOP', 'PANW', 'SBUX', 'NKE', 'T', 'F', 'GM',
  'DAL', 'RIVN', 'SOFI', 'HOOD', 'SNAP', 'PYPL', 'XYZ', 'ROKU', 'DKNG', 'CVNA',
];

// ── Index, sector and commodity ETFs ─────────────────────────────────────────────
const ETFS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'EFA', 'VTI',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
  'SMH', 'SOXX', 'ARKK', 'XBI', 'IBB', 'XOP', 'XME', 'KRE', 'ITB', 'JETS',
  'GLD', 'SLV', 'USO', 'UNG', 'TLT', 'IEF', 'HYG', 'LQD', 'VXX', 'GDX',
];

// ── Leveraged / inverse — the engine's own working set ───────────────────────────
// Kept separate because they move several times the market and would otherwise
// monopolise a "biggest move" ranking on any ordinary day. The board reports them, and
// labels them, rather than pretending a leveraged fund's 9% day is the same event as a
// stock's. Most are 3x; NUGT, JNUG and UCO are 2x, so the label says "leveraged", not
// "3x". (GDX, the unleveraged gold-miners fund, sat in this list until 2026-10-11 and was
// labelled as one; it is an ordinary ETF above.)
const LEVERAGED = [
  'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'TNA', 'TZA',
  'UPRO', 'LABU', 'NUGT', 'JNUG', 'UCO',
];

const UNIVERSE = [].concat(EQUITIES, ETFS, LEVERAGED);
const LEVERAGED_SET = new Set(LEVERAGED);
const ETF_SET = new Set([].concat(ETFS, LEVERAGED));

/** What kind of instrument a symbol is, so the board can label a 3x move as one. */
function kindOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (LEVERAGED_SET.has(s)) return 'leveraged';
  if (ETF_SET.has(s)) return 'etf';
  return 'stock';
}

module.exports = { UNIVERSE, EQUITIES, ETFS, LEVERAGED, kindOf };
