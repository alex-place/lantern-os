/**
 * Kalshi Win Rate Tracker — historical profitability by market type.
 * Ingests paper-positions ledger, computes win% per category to inform entry filtering.
 *
 * Categories: crypto (KXBTC*), sports (KXMVE*), etc.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../data/kalshi");
const PAPER_FILE = path.join(KALSHI_DIR, "paper-positions.jsonl");

function getCategory(ticker) {
  if (!ticker) return "unknown";
  if (ticker.startsWith("KXBTC") || ticker.startsWith("KXETH") ||
      ticker.startsWith("KXSOL") || ticker.startsWith("KXXRP") ||
      ticker.startsWith("KXDOGE") || ticker.startsWith("KXBNB") ||
      ticker.startsWith("KXHYPE")) return "crypto";
  if (ticker.startsWith("KXMVE")) return "sports";
  if (ticker.startsWith("KXMVC")) return "crypto-multi";
  return "other";
}

function readLedger() {
  if (!fs.existsSync(PAPER_FILE)) return [];
  try {
    return fs.readFileSync(PAPER_FILE, "utf8")
      .trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function computeWinRate() {
  const ledger = readLedger();
  const byCategory = {};
  const byTicker = {};
  const positions = {};

  // Index open positions by ID
  for (const entry of ledger) {
    if (entry.event === "open") {
      positions[entry.id] = entry;
    }
  }

  // Match closes to opens, compute outcome
  for (const entry of ledger) {
    if (entry.event === "close" && entry.pnlPct !== null) {
      const open = positions[entry.id];
      if (!open) continue;

      const isWin = entry.pnlPct > 0;
      const cat = getCategory(open.ticker);
      const ticker = open.ticker;

      // By category
      if (!byCategory[cat]) byCategory[cat] = { wins: 0, losses: 0, trades: 0, profitSum: 0, lossSum: 0 };
      byCategory[cat].trades += 1;
      byCategory[cat].profitSum += Math.max(0, entry.pnlPct);
      byCategory[cat].lossSum += Math.max(0, -entry.pnlPct);
      if (isWin) byCategory[cat].wins += 1;
      else byCategory[cat].losses += 1;

      // By ticker
      if (!byTicker[ticker]) byTicker[ticker] = { wins: 0, losses: 0, trades: 0 };
      byTicker[ticker].trades += 1;
      if (isWin) byTicker[ticker].wins += 1;
      else byTicker[ticker].losses += 1;
    }
  }

  // Compute win rates
  const stats = {};
  for (const [cat, data] of Object.entries(byCategory)) {
    const winRate = data.trades > 0 ? Math.round((data.wins / data.trades) * 100) : 0;
    const avgProfit = data.wins > 0 ? Math.round(data.profitSum / data.wins) : 0;
    const avgLoss = data.losses > 0 ? Math.round(data.lossSum / data.losses) : 0;
    const expectancy = (winRate / 100) * avgProfit - ((100 - winRate) / 100) * avgLoss;
    stats[cat] = {
      trades: data.trades,
      wins: data.wins,
      losses: data.losses,
      winRate,
      avgProfit,
      avgLoss,
      expectancy: Math.round(expectancy)
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    categories: stats,
    byTicker: Object.fromEntries(
      Object.entries(byTicker).map(([t, d]) => [
        t, {
          trades: d.trades,
          wins: d.wins,
          winRate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0
        }
      ])
    )
  };
}

function getWinRate(ticker) {
  const stats = computeWinRate();
  const cat = getCategory(ticker);
  return stats.categories[cat]?.winRate ?? 0;
}

function getCategoryStats(category) {
  const stats = computeWinRate();
  return stats.categories[category] || null;
}

module.exports = { computeWinRate, getWinRate, getCategoryStats, getCategory };
