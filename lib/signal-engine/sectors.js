"use strict";
/**
 * signal-engine/sectors.js — sector-strength inputs (framework Step 5).
 *
 * Maps a stock to its SPDR sector ETF and scores the SECTOR's recent trend, so a
 * trade can be confirmed by (or discounted against) sector rotation: a long in a
 * leading sector is better than a long in a lagging one. Pure + data-light — the
 * caller fetches the sector ETFs' daily bars once per scan and reuses them.
 */

// Ticker → SPDR sector ETF. Not exhaustive; an unmapped ticker returns null →
// the sector signal stays neutral (never fabricated) rather than guessing.
const SECTOR_ETF = {
  // Information technology / semis
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", AMD: "XLK", INTC: "XLK", ASML: "XLK",
  AVGO: "XLK", QCOM: "XLK", MU: "XLK", TXN: "XLK", ORCL: "XLK", CRM: "XLK",
  ADBE: "XLK", CSCO: "XLK", IBM: "XLK", SMCI: "XLK", ARM: "XLK", TSM: "XLK",
  AMAT: "XLK", LRCX: "XLK", PLTR: "XLK", NOW: "XLK", DELL: "XLK",
  // Communication services
  GOOGL: "XLC", GOOG: "XLC", META: "XLC", NFLX: "XLC", DIS: "XLC", T: "XLC", VZ: "XLC", TMUS: "XLC",
  // Consumer discretionary
  TSLA: "XLY", AMZN: "XLY", SHOP: "XLY", HD: "XLY", MCD: "XLY", NKE: "XLY",
  SBUX: "XLY", LOW: "XLY", BABA: "XLY", ABNB: "XLY", CMG: "XLY",
  // Financials
  JPM: "XLF", BAC: "XLF", WFC: "XLF", GS: "XLF", MS: "XLF", C: "XLF",
  V: "XLF", MA: "XLF", AXP: "XLF", SCHW: "XLF", BLK: "XLF",
  // Health care
  UNH: "XLV", JNJ: "XLV", LLY: "XLV", PFE: "XLV", MRK: "XLV", ABBV: "XLV", TMO: "XLV", ABT: "XLV",
  // Energy
  XOM: "XLE", CVX: "XLE", COP: "XLE", SLB: "XLE", OXY: "XLE", EOG: "XLE",
  // Industrials
  BA: "XLI", CAT: "XLI", GE: "XLI", HON: "XLI", UPS: "XLI", RTX: "XLI", LMT: "XLI", DE: "XLI",
  // Consumer staples
  WMT: "XLP", PG: "XLP", KO: "XLP", PEP: "XLP", COST: "XLP", MDLZ: "XLP",
};

/** The sector ETF for a ticker, or null when unmapped (→ neutral signal). */
function sectorFor(ticker) {
  return SECTOR_ETF[String(ticker || "").toUpperCase()] || null;
}

/** The unique set of sector ETFs needed for a list of tickers. */
function etfsFor(tickers) {
  const set = new Set();
  for (const t of (tickers || [])) { const e = sectorFor(t); if (e) set.add(e); }
  return [...set];
}

/** Sector momentum from daily bars: signed rate-of-change over `lookback` bars
 *  (fraction, e.g. +0.03 = sector +3%). null when there aren't enough bars. */
function sectorMomentum(dailyBars, lookback = 10) {
  const b = Array.isArray(dailyBars) ? dailyBars : [];
  if (b.length < lookback + 1) return null;
  const last = Number(b[b.length - 1].close);
  const prior = Number(b[b.length - 1 - lookback].close);
  if (!(last > 0) || !(prior > 0)) return null;
  return (last - prior) / prior;
}

module.exports = { sectorFor, etfsFor, sectorMomentum, SECTOR_ETF };
