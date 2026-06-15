const kalshi = require("./kalshi-api");
const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const PAPER_LEDGER_PATH = path.join(KALSHI_DIR, "paper-positions.jsonl");

function loadPaperPositions() {
  try {
    if (!fs.existsSync(PAPER_LEDGER_PATH)) return [];
    const lines = fs.readFileSync(PAPER_LEDGER_PATH, "utf-8").split("\n").filter(l => l.trim());
    return lines.map(line => { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) {
    console.error("[Dashboard] Failed to load positions:", e.message);
    return [];
  }
}

function aggregatePositions(positions) {
  const grouped = {};
  for (const pos of positions) {
    const ticker = pos.ticker || "unknown";
    if (!grouped[ticker]) {
      grouped[ticker] = { ticker, positions: [], totalQuantity: 0, totalCost: 0, avgEntryPrice: 0, side: null };
    }
    const qty = parseFloat(pos.quantity || 0);
    const cost = parseFloat(pos.cost || 0);
    grouped[ticker].positions.push(pos);
    grouped[ticker].totalQuantity += qty;
    grouped[ticker].totalCost += cost;
    grouped[ticker].side = qty > 0 ? "yes" : qty < 0 ? "no" : null;
  }
  for (const ticker in grouped) {
    const group = grouped[ticker];
    if (group.totalQuantity !== 0) {
      group.avgEntryPrice = Math.round((group.totalCost / Math.abs(group.totalQuantity)) * 100) / 100;
    }
  }
  return grouped;
}

async function enrichWithMarketPrices(aggregated) {
  const enriched = [];
  for (const ticker in aggregated) {
    const group = aggregated[ticker];
    try {
      const mktRes = await kalshi.getMarket(ticker);
      if (!mktRes.ok || !mktRes.data?.market) {
        enriched.push({ ...group, currentPrice: null, pnl: null, pnlPct: null, marketStatus: "error" });
        continue;
      }
      const market = mktRes.data.market;
      const yesPrice = parseFloat(market.yes_bid || market.yes_ask || 0) / 100;
      const noPrice = parseFloat(market.no_bid || market.no_ask || 0) / 100;
      const currentPrice = group.side === "yes" ? yesPrice : noPrice;
      const pnl = (currentPrice - group.avgEntryPrice) * Math.abs(group.totalQuantity);
      const pnlPct = group.avgEntryPrice > 0
        ? Math.round(((currentPrice - group.avgEntryPrice) / group.avgEntryPrice) * 10000) / 100 : 0;
      enriched.push({
        ...group, currentPrice, yesPrice, noPrice, pnl: Math.round(pnl * 100) / 100, pnlPct,
        marketStatus: market.status || "unknown", closeTime: market.close_time,
        timeTillClose: market.close_time ? Math.round((new Date(market.close_time).getTime() - Date.now()) / 60000) : null,
        spread: Math.abs(yesPrice - noPrice)
      });
    } catch (e) {
      console.error(`[Dashboard] Error for ${ticker}:`, e.message);
      enriched.push({ ...group, currentPrice: null, pnl: null, pnlPct: null, marketStatus: "error" });
    }
  }
  return enriched;
}

function calculatePortfolioStats(enrichedPositions) {
  let totalCost = 0, totalValue = 0, totalUnrealizedPnL = 0, positionsCount = 0, winningPositions = 0, losingPositions = 0;
  for (const pos of enrichedPositions) {
    if (pos.totalQuantity === 0) continue;
    totalCost += Math.abs(pos.totalCost);
    if (pos.currentPrice !== null) {
      const value = pos.currentPrice * Math.abs(pos.totalQuantity);
      totalValue += value;
      totalUnrealizedPnL += (pos.pnl || 0);
      positionsCount++;
      if (pos.pnl > 0) winningPositions++;
      else if (pos.pnl < 0) losingPositions++;
    }
  }
  const roi = totalCost > 0 ? Math.round((totalUnrealizedPnL / totalCost) * 10000) / 100 : 0;
  const winRate = positionsCount > 0 ? Math.round((winningPositions / positionsCount) * 10000) / 100 : 0;
  return { totalCost: Math.round(totalCost * 100) / 100, totalValue: Math.round(totalValue * 100) / 100,
    totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100, roi, winRate, positionsCount, winningPositions, losingPositions };
}

async function buildDashboard() {
  const positions = loadPaperPositions();
  if (positions.length === 0) {
    return {
      status: "no_positions", message: "No positions loaded", positions: [],
      stats: { totalCost: 0, totalValue: 0, totalUnrealizedPnL: 0, roi: 0, winRate: 0, positionsCount: 0, winningPositions: 0, losingPositions: 0 },
      generatedAt: new Date().toISOString()
    };
  }
  const aggregated = aggregatePositions(positions);
  const enriched = await enrichWithMarketPrices(aggregated);
  const stats = calculatePortfolioStats(enriched);
  return { status: "ready", positions: enriched, stats, generatedAt: new Date().toISOString() };
}

function getRecentTrades(limit = 20) {
  const tradeLogPath = path.join(KALSHI_DIR, "convergence-train.jsonl");
  try {
    if (!fs.existsSync(tradeLogPath)) return [];
    const lines = fs.readFileSync(tradeLogPath, "utf-8").split("\n").filter(l => l.trim());
    return lines.map(line => { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean).slice(-limit).reverse();
  } catch (e) {
    console.error("[Dashboard] Failed to load trades:", e.message);
    return [];
  }
}

function calculatePerformanceMetrics(trades) {
  if (trades.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, expectancy: 0 };
  }
  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const winRate = Math.round((wins / trades.length) * 10000) / 100;
  const winTrades = trades.filter(t => t.won);
  const loseTrades = trades.filter(t => !t.won);
  const avgWinPct = winTrades.length > 0 ? Math.round(winTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0) / winTrades.length * 100) / 100 : 0;
  const avgLossPct = loseTrades.length > 0 ? Math.round(loseTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0) / loseTrades.length * 100) / 100 : 0;
  const totalWinPnL = winTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0);
  const totalLosePnL = Math.abs(loseTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0));
  const profitFactor = totalLosePnL > 0 ? Math.round((totalWinPnL / totalLosePnL) * 100) / 100 : totalWinPnL > 0 ? 999 : 0;
  const expectancy = (winRate / 100) * avgWinPct - ((100 - winRate) / 100) * Math.abs(avgLossPct);
  return { totalTrades: trades.length, wins, losses, winRate, avgWinPct, avgLossPct, profitFactor, expectancy: Math.round(expectancy * 100) / 100 };
}

module.exports = { buildDashboard, getRecentTrades, calculatePerformanceMetrics, loadPaperPositions, aggregatePositions, calculatePortfolioStats, enrichWithMarketPrices };
