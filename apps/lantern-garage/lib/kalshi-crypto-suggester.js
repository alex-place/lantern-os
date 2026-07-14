/**
 * Crypto intraday market suggester — 15min, hourly, daily crypto predictions.
 * Markets close in minutes/hours, NOT days. Perfect for convergence trading.
 */

"use strict";

const kalshi = require("./kalshi-api");
const { getWinRate, getCategory, getCategoryStats } = require("./kalshi-winrate-tracker");

// ── entry filters (profitability-driven) ────────────────────────────────────
const MIN_CONVERGENCE_ASK = 80;  // only convergence plays ≥80¢ (tighter threshold)
const MAX_CONVERGENCE_ASK = 90;  // only convergence plays ≤90¢ (profitable remainder)
const MIN_ENTRY_CONVICTION = 65; // only entry cards ≥65% conviction
const MIN_CATEGORY_WINRATE = 45; // skip category if <45% win rate

// P0-3 (docs/TRADER-ANALYSIS-2026-07.md): win-rate alone is NOT profitability — the crypto
// ledger shows 54% win-rate but −45¢/trade EXPECTANCY (tiny 1¢ wins vs 100¢ losses). Gate on the
// category's realized, fee-inclusive expectancy so a category the data proves loses is suppressed.
function categoryProfitable(ticker) {
  const st = getCategoryStats(getCategory(ticker));
  // Unknown category (no trades yet) → don't present it; require proven positive expectancy.
  return !!(st && typeof st.expectancy === "number" && st.expectancy > 0);
}

function isShortWindowMarket(m, nowMs) {
  const closeMs = new Date(m.close_time).getTime();
  const minsToClose = Math.round((closeMs - nowMs) / 60000);
  if (minsToClose <= 0 || minsToClose > 360) return false;
  // Skip markets that have already converged (resolved or nearly so)
  const ya = m.yes_ask || 0;
  const na = m.no_ask || 0;
  if (ya < 4 || ya > 96) return false;   // YES already settled
  if (na < 4 || na > 96) return false;   // NO already settled
  return true;
}

function scoreIntraday(m, nowMs) {
  const closeMs = new Date(m.close_time).getTime();
  const minsToClose = Math.round((closeMs - nowMs) / 60000);

  // Urgency: sooner = higher score
  let urgency = 0;
  if (minsToClose <= 5) urgency = 100;        // NOW
  else if (minsToClose <= 15) urgency = 90;   // very soon
  else if (minsToClose <= 30) urgency = 80;   // soon (12pm markets)
  else if (minsToClose <= 60) urgency = 70;   // within 1h
  else if (minsToClose <= 120) urgency = 60;  // within 2h
  else if (minsToClose <= 360) urgency = 40;  // within 6h
  else urgency = 10;                           // too far

  // Spread quality: tighter = higher score
  const spread = Math.abs((m.yes_ask || 0) - (m.no_ask || 0));
  let spreadScore = 0;
  if (spread <= 1) spreadScore = 20;
  else if (spread <= 2) spreadScore = 15;
  else if (spread <= 4) spreadScore = 10;
  else if (spread <= 6) spreadScore = 5;

  // Tick/momentum
  const prevYes = m.previous_yes_ask_dollars ? Math.round(m.previous_yes_ask_dollars * 100) : null;
  const currentYes = m.yes_ask || 0;
  const tick = (prevYes && currentYes) ? Math.abs(currentYes - prevYes) : 0;
  const momentumScore = Math.min(15, tick * 3);

  return urgency + spreadScore + momentumScore;
}

// Convergence-profit opportunity: one side is pricing 80-90¢ (near-certain, real margin remains).
// Sweet spot: buy the winning side before resolution, collect the spread to 100¢.
// Phase 1 optimization: tighter thresholds + win-rate check
function isConvergenceOpportunity(m, nowMs) {
  // P0-4 (docs/TRADER-ANALYSIS-2026-07.md): DISABLED. The "convergence-profit" thesis — buy the
  // 80–90¢ favorite to "collect the spread to 100¢" — has NO independent edge: the recommendation's
  // conviction WAS the market ask (fair value == price), so the 10–20¢ "profit" is exactly the
  // market's priced loss probability, with fully negative skew (lose 80–90¢ when it flips) and a fee
  // on top. It is the classic short-premium trap and can't be positive-EV by construction. Re-enable
  // ONLY behind an independent grounded P(YES) that exceeds the ask net of fees.
  return false;
}

async function fetchAllCryptoMarkets() {
  const series = ["KXBTC", "KXETH", "KXSOL", "KXXRP", "KXDOGE", "KXBNB", "KXHYPE",
                  "KXBTC15M","KXETH15M","KXSOL15M","KXXRP15M","KXDOGE15M","KXBNB15M","KXHYPE15M"];
  const all = [];
  for (const s of series) {
    try {
      const r = await kalshi.getMarkets({ status: "open", limit: 100, series_ticker: s });
      if (r.ok && r.data && r.data.markets) all.push(...r.data.markets);
    } catch (_) {}
  }
  return all;
}

async function getCryptoSuggestions({ limit = 20, collector = null, exitsOnly = false } = {}) {
  let markets = [];

  // Try collector cache first
  const nowMs = Date.now();
  if (collector) {
    const latest = collector.getLatestMarkets();
    if (latest && latest.length > 0) {
      markets = latest.filter(m => isShortWindowMarket(m, nowMs));
    }
  }

  // Fall back to API — fetch both short-window AND convergence candidates
  let allMarkets = [];
  if (markets.length === 0) {
    try {
      allMarkets = await fetchAllCryptoMarkets();
      markets = allMarkets.filter(m => isShortWindowMarket(m, nowMs));
    } catch (e) {
      return { count: 0, cards: [], error: e.message };
    }
  } else {
    allMarkets = markets; // collector already has them
  }

  const convCards = [];
  const entryCards = [];

  // ── Convergence-profit cards FIRST (75-97¢ high-probability side) ─────────
  // Must run before entry loop so high-probability markets become convergence,
  // not watered-down entry cards.
  const convMarkets = allMarkets.filter(m => isConvergenceOpportunity(m, nowMs));
  const convTickers = new Set();
  for (const m of convMarkets) {
    const closeMs = new Date(m.close_time).getTime();
    const minsToClose = Math.round((closeMs - nowMs) / 60000);
    if (minsToClose <= 0) continue;

    const yesAsk = m.yes_ask || 0;
    const noAsk = m.no_ask || 0;
    const favSide = yesAsk >= noAsk ? "yes" : "no";
    const favAsk = favSide === "yes" ? yesAsk : noAsk;
    const profitCents = 100 - favAsk;
    const denom = yesAsk + noAsk;
    const yesPct = denom > 0 ? Math.round((yesAsk / denom) * 100) : 50;

    const reason = `${profitCents}¢ profit if correct · ${minsToClose < 60 ? minsToClose + "m" : Math.round(minsToClose/60) + "h"} to close · buy ${favSide.toUpperCase()} at ${favAsk}¢`;

    convTickers.add(m.ticker);
    convCards.push({
      kind: "convergence",
      action: "buy",
      ticker: m.ticker,
      title: m.title || m.ticker,
      yesLabel: m.yes_sub_title || "YES",
      noLabel: m.no_sub_title || "NO",
      yesCents: yesAsk,
      noCents: noAsk,
      yesPct,
      favSide,
      favLabel: favSide === "yes" ? (m.yes_sub_title || "YES") : (m.no_sub_title || "NO"),
      favAsk,
      conviction: favAsk,
      profitCents,
      reason,
      minsToClose,
      close: m.close_time,
      urgencyLevel: minsToClose <= 15 ? "critical" : minsToClose <= 60 ? "hot" : "normal",
      convergenceScore: favAsk * 10 + Math.max(0, 480 - minsToClose)
    });
  }

  // ── Entry cards (balanced markets, 4-74¢ range) ────────────────────────────
  // Phase 1: only include high-conviction entries (≥65%) from winning categories
  for (const m of markets) {
    if (convTickers.has(m.ticker)) continue; // already a convergence card
    const closeMs = new Date(m.close_time).getTime();
    const minsToClose = Math.round((closeMs - nowMs) / 60000);
    if (minsToClose <= 0) continue;

    const score = scoreIntraday(m, nowMs);
    const conviction = Math.round(Math.min(99, 40 + (score || 0) / 3));

    // Phase 1: skip low-conviction entries
    if (conviction < MIN_ENTRY_CONVICTION) continue;

    // P0-3: gate on realized fee-inclusive EXPECTANCY, not win-rate — a 54%-win category that
    // loses −45¢/trade (tiny wins, full losses) must be suppressed, and an unproven category
    // (no trade history) is not presented until it earns a positive expectancy.
    if (!categoryProfitable(m.ticker)) continue;

    const yesAsk = m.yes_ask || 0;
    const noAsk = m.no_ask || 0;
    const denom = yesAsk + noAsk;
    const yesPct = denom > 0 ? Math.round((yesAsk / denom) * 100) : 50;

    let favSide = "yes";
    if ((m.yes_ask || 99) > (m.no_ask || 99)) favSide = "no";

    const spread = Math.abs(yesAsk - noAsk);
    const reason = [
      `${minsToClose}m to close`,
      `${spread}¢ spread`,
      yesAsk === noAsk ? "even odds" : (yesPct > 50 ? "YES favored" : "NO favored")
    ].join(" · ");

    entryCards.push({
      kind: "entry",
      action: "buy",
      ticker: m.ticker,
      title: m.title || m.ticker,
      yesLabel: m.yes_sub_title || "YES",
      noLabel: m.no_sub_title || "NO",
      yesCents: yesAsk,
      noCents: noAsk,
      yesPct,
      favSide,
      favLabel: favSide === "yes" ? (m.yes_sub_title || "YES") : (m.no_sub_title || "NO"),
      favAsk: favSide === "yes" ? yesAsk : noAsk,
      conviction,
      reason,
      minsToClose,
      close: m.close_time,
      urgencyLevel: minsToClose <= 5 ? "critical" : minsToClose <= 30 ? "hot" : "normal",
      convergenceScore: score
    });
  }

  convCards.sort((a, b) => b.convergenceScore - a.convergenceScore);
  entryCards.sort((a, b) => b.convergenceScore - a.convergenceScore);

  // For crypto: convergence cards are effectively "exits" (lock in profits)
  // Entry cards are new positions
  const allCards = exitsOnly ? convCards : [...convCards, ...entryCards];

  return {
    count: allCards.length,
    convergenceCount: convCards.length,
    entryCount: entryCards.length,
    generatedAt: new Date().toISOString(),
    note: exitsOnly
      ? "CONVERGENCE PROFITS ONLY — lock in gains on 80-90¢ markets. No new entries shown."
      : "Crypto intraday markets — convergence-profit + short-window entry signals.",
    cards: allCards.slice(0, limit)
  };
}

module.exports = { getCryptoSuggestions, isShortWindowMarket, isConvergenceOpportunity };
