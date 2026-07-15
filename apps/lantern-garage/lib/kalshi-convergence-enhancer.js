/**
 * Kalshi Convergence Enhancer — continuous self-improvement loop.
 *
 * Combines:
 * - Historical trade data (convergence-train.jsonl)
 * - Web search for market context/news
 * - Real-time market state
 * - ML feedback to improve future predictions
 *
 * Loop: poll trades → search for context → update model → improve thresholds
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const CONVERGENCE_LOG = path.join(KALSHI_DIR, "convergence-train.jsonl");
const CONVERGENCE_CONTEXT = path.join(KALSHI_DIR, "convergence-context.json");
const TRAINING_INTERVAL = 30000;  // retrain every 30s when new data arrives

class ConvergenceEnhancer {
  constructor() {
    this.enhancing = false;
    this.lastTrainedCount = 0;
    this.context = this.loadContext();
  }

  /**
   * Load or initialize context cache.
   */
  loadContext() {
    try {
      if (fs.existsSync(CONVERGENCE_CONTEXT)) {
        return JSON.parse(fs.readFileSync(CONVERGENCE_CONTEXT, "utf8"));
      }
    } catch (e) {
      console.warn("[ConvergenceEnhancer] Failed to load context");
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      searchCache: {},      // ticker → {searchResults, timestamp}
      marketInsights: {},   // ticker → {trend, catalyst, confidence}
      convergencePredictions: {}  // ticker → {predicted outcome, confidence}
    };
  }

  /**
   * Save context to disk.
   */
  saveContext() {
    try {
      fs.mkdirSync(KALSHI_DIR, { recursive: true });
      this.context.generatedAt = new Date().toISOString();
      fs.writeFileSync(CONVERGENCE_CONTEXT, JSON.stringify(this.context, null, 2), "utf8");
    } catch (e) {
      console.error("[ConvergenceEnhancer] Failed to save context:", e.message);
    }
  }

  /**
   * Start continuous enhancement loop.
   */
  start() {
    if (this.enhancing) return;
    this.enhancing = true;
    console.log("[ConvergenceEnhancer] Starting continuous enhancement loop (30s interval)...");
    this.enhance();
  }

  /**
   * Stop enhancement loop.
   */
  stop() {
    this.enhancing = false;
    console.log("[ConvergenceEnhancer] Stopped enhancement loop");
  }

  /**
   * Main enhancement cycle.
   */
  async enhance() {
    if (!this.enhancing) return;

    try {
      // 1. Check if new trades logged
      const newTradesCount = await this.countTrades();
      if (newTradesCount > this.lastTrainedCount) {
        const newCount = newTradesCount - this.lastTrainedCount;
        console.log(`[ConvergenceEnhancer] Detected ${newCount} new trades, enhancing...`);

        // 2. Get recent trades and extract tickers
        const recentTrades = await this.getRecentTrades(newCount);
        const tickers = [...new Set(recentTrades.map(t => t.ticker))];

        // 3. Search for market context on new tickers
        for (const ticker of tickers) {
          await this.searchMarketContext(ticker);
        }

        // 4. Analyze convergence patterns
        await this.analyzeConvergence(recentTrades);

        this.lastTrainedCount = newTradesCount;
        this.saveContext();
      }
    } catch (e) {
      console.error("[ConvergenceEnhancer] Enhancement error:", e.message);
    }

    // Schedule next cycle
    if (this.enhancing) {
      setTimeout(() => this.enhance(), TRAINING_INTERVAL);
    }
  }

  /**
   * Count trades in convergence log.
   */
  async countTrades() {
    if (!fs.existsSync(CONVERGENCE_LOG)) return 0;
    try {
      const lines = fs.readFileSync(CONVERGENCE_LOG, "utf8").trim().split("\n");
      return lines.filter(l => l.trim()).length;
    } catch {
      return 0;
    }
  }

  /**
   * Get N most recent trades.
   */
  async getRecentTrades(limit) {
    if (!fs.existsSync(CONVERGENCE_LOG)) return [];
    try {
      const lines = fs.readFileSync(CONVERGENCE_LOG, "utf8").trim().split("\n");
      return lines
        .filter(l => l.trim())
        .slice(-limit)
        .map(l => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Search for market context via web (mocked for now).
   * In production: call actual web search API.
   */
  async searchMarketContext(ticker) {
    if (this.context.searchCache[ticker]) {
      // Cache hit - skip
      return;
    }

    try {
      // Extract base symbol (e.g., KXBTC → BTC)
      const symbol = ticker.replace(/KX/, "").replace(/15M|CROSS|SPORTS|MULTI/, "");

      // Mock search result (in production, use actual web search)
      const mockResults = await this.getMockSearchResults(symbol);

      this.context.searchCache[ticker] = {
        results: mockResults,
        timestamp: new Date().toISOString(),
        trend: this.analyzeTrend(mockResults),
        catalyst: this.extractCatalyst(mockResults)
      };

      console.log(`[ConvergenceEnhancer] Cached context for ${ticker}: ${this.context.searchCache[ticker].trend}`);
    } catch (e) {
      console.error(`[ConvergenceEnhancer] Search error for ${ticker}:`, e.message);
    }
  }

  /**
   * Mock web search (replace with actual API calls in production).
   */
  async getMockSearchResults(symbol) {
    // In production: use WebSearch tool or API
    const trendMap = {
      BTC: "bullish (strong institutional adoption, ETF growth)",
      ETH: "mixed (upgrade pressure, macro uncertainty)",
      SOL: "bullish (ecosystem growth, adoption)",
      XRP: "neutral (regulatory clarity awaited)",
      DOGE: "meme-driven (no fundamental catalyst)",
    };

    return [
      { title: `${symbol} Market Update`, trend: trendMap[symbol] || "uncertain" },
      { title: `${symbol} Technical Analysis`, signal: "wait for confirmation" }
    ];
  }

  /**
   * Analyze trend from search results.
   */
  analyzeTrend(results) {
    if (!results || results.length === 0) return "neutral";
    const text = results.map(r => r.trend || r.title || "").join(" ").toLowerCase();
    if (text.includes("bullish") || text.includes("up")) return "bullish";
    if (text.includes("bearish") || text.includes("down")) return "bearish";
    return "neutral";
  }

  /**
   * Extract market catalyst from results.
   */
  extractCatalyst(results) {
    const catalysts = [];
    for (const r of results || []) {
      if (r.catalyst) catalysts.push(r.catalyst);
      if (r.signal) catalysts.push(r.signal);
    }
    return catalysts[0] || "no immediate catalyst";
  }

  /**
   * Analyze convergence patterns and predict future outcomes.
   */
  async analyzeConvergence(trades) {
    if (!trades || trades.length === 0) return;

    // Group by ticker
    const byTicker = {};
    for (const trade of trades) {
      if (!byTicker[trade.ticker]) {
        byTicker[trade.ticker] = [];
      }
      byTicker[trade.ticker].push(trade);
    }

    // Analyze patterns per ticker
    for (const [ticker, tickerTrades] of Object.entries(byTicker)) {
      const analysis = this.analyzeTickerPattern(ticker, tickerTrades);
      this.context.convergencePredictions[ticker] = analysis;

      if (analysis.confidence >= 70) {
        console.log(`[ConvergenceEnhancer] High-confidence prediction for ${ticker}:`);
        console.log(`  Expected: ${analysis.expected} (${analysis.confidence}% confidence)`);
      }
    }
  }

  /**
   * Analyze single ticker's convergence pattern.
   */
  analyzeTickerPattern(ticker, trades) {
    if (trades.length < 3) {
      return { expected: "insufficient data", confidence: 0 };
    }

    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const winRate = (wins / trades.length) * 100;
    const avgPnl = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;

    // Confidence: higher win rate + better avg = higher confidence
    let confidence = Math.min(95, winRate + Math.abs(avgPnl) * 0.5);

    // Prediction: if win rate >60%, predict next trade will converge correctly
    let expected = "uncertain";
    if (winRate >= 70) expected = "likely converges";
    else if (winRate <= 40) expected = "likely diverges";
    else expected = "coin flip";

    return {
      ticker,
      trades: trades.length,
      winRate: Math.round(winRate),
      avgPnl: Math.round(avgPnl),
      expected,
      confidence: Math.round(confidence)
    };
  }

  /**
   * Get current predictions for a ticker.
   */
  getPrediction(ticker) {
    return this.context.convergencePredictions[ticker] || null;
  }

  /**
   * Get market context (search cache + insights).
   */
  getContext(ticker) {
    return {
      searchCache: this.context.searchCache[ticker],
      prediction: this.context.convergencePredictions[ticker]
    };
  }

  /**
   * Get enhancement status.
   */
  getStatus() {
    return {
      enhancing: this.enhancing,
      totalCached: Object.keys(this.context.searchCache).length,
      predictions: Object.keys(this.context.convergencePredictions).length,
      generatedAt: this.context.generatedAt
    };
  }
}

let enhancer = null;

function getEnhancer() {
  if (!enhancer) {
    enhancer = new ConvergenceEnhancer();
  }
  return enhancer;
}

// P0-5 (docs/TRADER-ANALYSIS-2026-07.md): DISABLED. The enhancer's "web search" is a static
// hardcoded dict and its input file doesn't exist — a self-referential loop entrenching a
// heuristic. Inert no-op (called from boot AND the API route) until backed by a real signal.
function startEnhancing() {
  /* P0-5: inert no-op — the static-dict mock enhancement loop is never started. */
}

function stopEnhancing() {
  getEnhancer().stop();
}

module.exports = {
  getEnhancer,
  startEnhancing,
  stopEnhancing
};
