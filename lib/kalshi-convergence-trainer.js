/**
 * Kalshi Convergence Trainer — ML feedback loop from trade outcomes.
 *
 * Ingests trade logs (convergence-train.jsonl) and updates convergence scoring:
 * - Markets that converged correctly get higher weights
 * - Markets that diverged get penalized
 * - Builds historical accuracy per market type
 */

"use strict";

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../data/kalshi");
const CONVERGENCE_LOG = path.join(KALSHI_DIR, "convergence-train.jsonl");
const CONVERGENCE_MODEL = path.join(KALSHI_DIR, "convergence-model.json");

class ConvergenceTrainer {
  constructor() {
    this.model = this.loadModel();
  }

  /**
   * Load or initialize convergence model.
   */
  loadModel() {
    try {
      if (fs.existsSync(CONVERGENCE_MODEL)) {
        const data = JSON.parse(fs.readFileSync(CONVERGENCE_MODEL, "utf8"));
        return data;
      }
    } catch (e) {
      console.warn("[ConvergenceTrainer] Failed to load model, starting fresh");
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      markets: {},           // by ticker
      marketTypes: {},       // by type: crypto, sports, etc.
      entryConvictionBands: {} // by conviction level
    };
  }

  /**
   * Save model to disk.
   */
  saveModel() {
    try {
      fs.mkdirSync(KALSHI_DIR, { recursive: true });
      this.model.generatedAt = new Date().toISOString();
      fs.writeFileSync(CONVERGENCE_MODEL, JSON.stringify(this.model, null, 2), "utf8");
    } catch (e) {
      console.error("[ConvergenceTrainer] Failed to save model:", e.message);
    }
  }

  /**
   * Train on all trades in convergence-train.jsonl.
   */
  async train() {
    if (!fs.existsSync(CONVERGENCE_LOG)) {
      console.log("[ConvergenceTrainer] No training data yet");
      return { trained: 0 };
    }

    let trained = 0;

    try {
      const lines = fs.readFileSync(CONVERGENCE_LOG, "utf8").trim().split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const trade = JSON.parse(line);
          this.processTrade(trade);
          trained++;
        } catch (e) {
          console.warn("[ConvergenceTrainer] Failed to parse trade:", e.message);
        }
      }

      this.saveModel();
      console.log(`[ConvergenceTrainer] Trained on ${trained} trades`);
    } catch (e) {
      console.error("[ConvergenceTrainer] Training error:", e.message);
    }

    return { trained, model: this.model };
  }

  /**
   * Process a single trade outcome.
   */
  processTrade(trade) {
    const { ticker, pnlPct, exitTag, entryConviction, won } = trade;
    const marketType = this.getMarketType(ticker);

    // ── Update by ticker ────────────────────────────────────
    if (!this.model.markets[ticker]) {
      this.model.markets[ticker] = { wins: 0, losses: 0, avgPnl: 0, trades: [] };
    }

    const m = this.model.markets[ticker];
    m.trades.push({ pnlPct, won, exitTag, timestamp: new Date().toISOString() });
    if (m.trades.length > 100) m.trades.shift();  // keep last 100

    if (won) m.wins++;
    else m.losses++;

    const total = m.wins + m.losses;
    m.avgPnl = (m.avgPnl * (total - 1) + pnlPct) / total;
    m.winRate = Math.round((m.wins / total) * 100);
    m.total = total;

    // ── Update by market type ────────────────────────────────
    if (!this.model.marketTypes[marketType]) {
      this.model.marketTypes[marketType] = { wins: 0, losses: 0, trades: 0, avgPnl: 0 };
    }

    const mt = this.model.marketTypes[marketType];
    if (won) mt.wins++;
    else mt.losses++;
    mt.trades++;
    mt.avgPnl = (mt.avgPnl * (mt.trades - 1) + pnlPct) / mt.trades;
    mt.winRate = Math.round((mt.wins / mt.trades) * 100);

    // ── Update by entry conviction band ──────────────────────
    const band = Math.floor(entryConviction / 10) * 10;  // 50-59, 60-69, 70-79, etc.
    const bandKey = `${band}`;

    if (!this.model.entryConvictionBands[bandKey]) {
      this.model.entryConvictionBands[bandKey] = { wins: 0, losses: 0, trades: 0, avgPnl: 0 };
    }

    const cb = this.model.entryConvictionBands[bandKey];
    if (won) cb.wins++;
    else cb.losses++;
    cb.trades++;
    cb.avgPnl = (cb.avgPnl * (cb.trades - 1) + pnlPct) / cb.trades;
    cb.winRate = Math.round((cb.wins / cb.trades) * 100);
  }

  /**
   * Get market type from ticker.
   */
  getMarketType(ticker) {
    if (!ticker) return "unknown";
    if (ticker.startsWith("KXBTC") || ticker.startsWith("KXETH") ||
        ticker.startsWith("KXSOL") || ticker.startsWith("KXXRP") ||
        ticker.startsWith("KXDOGE")) return "crypto";
    if (ticker.startsWith("KXMVE")) return "sports";
    if (ticker.startsWith("INX")) return "index";
    return "other";
  }

  /**
   * Get accuracy score for a ticker (how often did it converge correctly?).
   * Returns 0-100 or null if no history.
   */
  getAccuracy(ticker) {
    const m = this.model.markets[ticker];
    return m ? m.winRate : null;
  }

  /**
   * Get convergence confidence multiplier for market type.
   * Higher = more confident entries; lower = skip.
   */
  getTypeMultiplier(marketType) {
    const mt = this.model.marketTypes[marketType];
    if (!mt || mt.trades < 5) return 1.0;  // Need minimum trades to influence

    // Multiplier: 0.5x if <40% win, 1.0x if 40-60%, 1.5x if >60%
    const wr = mt.winRate;
    if (wr < 40) return 0.5;
    if (wr < 60) return 1.0;
    return 1.5;
  }

  /**
   * Get expected value for an entry at given conviction level.
   */
  getExpectedValue(entryConviction) {
    const band = Math.floor(entryConviction / 10) * 10;
    const bandKey = `${band}`;
    const cb = this.model.entryConvictionBands[bandKey];

    if (!cb || cb.trades < 5) return null;

    const winPct = cb.winRate / 100;
    const ev = winPct * cb.avgPnl - (1 - winPct) * Math.abs(cb.avgPnl);
    return Math.round(ev);
  }

  /**
   * Get full model state.
   */
  getModel() {
    return this.model;
  }

  /**
   * Get summary statistics.
   */
  getSummary() {
    const allTrades = Object.values(this.model.markets)
      .flatMap(m => m.trades || []);

    if (allTrades.length === 0) return null;

    const wins = allTrades.filter(t => t.won).length;
    const total = allTrades.length;

    return {
      totalTrades: total,
      wins,
      winRate: Math.round((wins / total) * 100),
      marketTypes: this.model.marketTypes,
      topMarkets: Object.entries(this.model.markets)
        .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
        .slice(0, 10)
        .map(([ticker, data]) => ({
          ticker,
          trades: data.total,
          winRate: data.winRate,
          avgPnl: Math.round(data.avgPnl)
        }))
    };
  }
}

let trainer = null;

function getTrainer() {
  if (!trainer) {
    trainer = new ConvergenceTrainer();
  }
  return trainer;
}

async function trainModel() {
  return await getTrainer().train();
}

module.exports = {
  getTrainer,
  trainModel
};
