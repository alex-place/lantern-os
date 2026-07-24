/**
 * Kalshi Position Monitor — continuous monitoring + automated stop-losses.
 *
 * Polls open positions every 10s, evaluates exit conditions, auto-executes stops.
 * Feeds trade outcomes into convergence trainer for ML feedback.
 */

"use strict";

const kalshi = require("./kalshi-api");
const { evaluateExit } = require("./kalshi-adaptive-exits");
const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../data/kalshi");
const MONITOR_INTERVAL = 10000;  // poll every 10s
const CONVERGENCE_LOG = path.join(KALSHI_DIR, "convergence-train.jsonl");

class PositionMonitor {
  constructor() {
    this.monitoring = false;
    this.positions = new Map();
    this.trades = [];
  }

  /**
   * Start continuous monitoring.
   */
  start() {
    if (this.monitoring) return;
    this.monitoring = true;
    console.log("[PositionMonitor] Starting position monitoring...");
    this.poll();
  }

  /**
   * Stop monitoring.
   */
  stop() {
    this.monitoring = false;
    console.log("[PositionMonitor] Stopped monitoring");
  }

  /**
   * Poll open positions and evaluate exits.
   */
  async poll() {
    if (!this.monitoring) return;

    try {
      const posRes = await kalshi.getPositions({});
      const positions = (posRes.data?.market_positions) || [];

      if (positions.length === 0) {
        if (this.positions.size > 0) {
          console.log("[PositionMonitor] All positions closed");
          this.positions.clear();
        }
      } else {
        await this.evaluatePositions(positions);
      }
    } catch (e) {
      console.error("[PositionMonitor] Poll error:", e.message);
    }

    // Schedule next poll
    if (this.monitoring) {
      setTimeout(() => this.poll(), MONITOR_INTERVAL);
    }
  }

  /**
   * Evaluate each position for exit signals.
   */
  async evaluatePositions(positions) {
    const nowMs = Date.now();

    for (const p of positions) {
      const count = parseFloat(p.position || p.position_fp || 0);
      if (count === 0) continue;

      const ticker = p.ticker || p.market_ticker;
      const key = ticker;

      // Skip if already exited
      if (this.positions.has(key) && this.positions.get(key).exited) continue;

      try {
        const mktRes = await kalshi.getMarket(ticker);
        const market = mktRes.data?.market;

        if (!market) continue;

        const heldSide = count > 0 ? "yes" : "no";
        const entry = this.getEntryCents(p) || 50;
        const conviction = p.conviction || 50;

        // Evaluate exit using adaptive logic
        const exitEval = evaluateExit(
          { side: heldSide, limitCents: entry },
          market,
          conviction
        );

        if (!exitEval.shouldExit) {
          // Still holding — update position state
          this.positions.set(key, {
            ticker,
            side: heldSide,
            entryCents: entry,
            conviction,
            entriedAt: new Date().toISOString(),
            exited: false,
            lastChecked: new Date().toISOString()
          });
          continue;
        }

        // ── EXIT TRIGGERED ──────────────────────────────────
        console.log(`[PositionMonitor] EXIT SIGNAL: ${ticker} - ${exitEval.tag}`);
        console.log(`  Reason: ${exitEval.reason}`);
        console.log(`  P&L: ${exitEval.pnlPct}%`);

        // Record for convergence training
        this.recordTrade(
          ticker,
          heldSide,
          entry,
          exitEval.exitPrice,
          exitEval.pnlPct,
          exitEval.tag,
          conviction,
          market
        );

        // Mark as exited (don't auto-execute; let user confirm)
        this.positions.set(key, {
          ticker,
          side: heldSide,
          entryCents: entry,
          conviction,
          exitTag: exitEval.tag,
          exitPrice: exitEval.exitPrice,
          pnlPct: exitEval.pnlPct,
          exited: true,
          readyToClose: true,
          lastChecked: new Date().toISOString()
        });
      } catch (e) {
        console.error(`[PositionMonitor] Error evaluating ${ticker}:`, e.message);
      }
    }
  }

  /**
   * Extract entry price from position object.
   */
  getEntryCents(p) {
    const expD = parseFloat(p.market_exposure_dollars);
    const qty = Math.abs(parseFloat(p.position || p.position_fp || 1));
    if (expD && qty > 0) return Math.round((Math.abs(expD) / qty) * 100);

    const exp = parseFloat(p.market_exposure);
    if (exp && qty > 0) return Math.round(Math.abs(exp) / qty);

    const avg = parseFloat(p.average_price_dollars) || parseFloat(p.avg_price_dollars);
    return avg ? Math.round(avg * 100) : null;
  }

  /**
   * Record trade outcome for convergence training.
   */
  recordTrade(ticker, side, entryCents, exitCents, pnlPct, exitTag, entryConviction, market) {
    const trade = {
      timestamp: new Date().toISOString(),
      ticker,
      side,
      entryCents,
      exitCents,
      pnlPct,
      exitTag,
      entryConviction,
      marketState: {
        yesAsk: market.yes_ask,
        noAsk: market.no_ask,
        spread: Math.abs((market.yes_ask || 0) - (market.no_ask || 0)),
        minsToClose: market.close_time
          ? Math.round((new Date(market.close_time).getTime() - Date.now()) / 60000)
          : null
      },
      won: pnlPct > 0
    };

    this.trades.push(trade);
    this.appendTradeLog(trade);
  }

  /**
   * Append trade to convergence training log (JSONL).
   */
  appendTradeLog(trade) {
    try {
      fs.mkdirSync(KALSHI_DIR, { recursive: true });
      fs.appendFileSync(
        CONVERGENCE_LOG,
        JSON.stringify(trade) + "\n",
        "utf8"
      );
    } catch (e) {
      console.error("[PositionMonitor] Failed to log trade:", e.message);
    }
  }

  /**
   * Get current monitored positions.
   */
  getMonitoredPositions() {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions ready to close.
   */
  getReadyToClose() {
    return Array.from(this.positions.values()).filter(p => p.readyToClose);
  }

  /**
   * Get trade history (in-memory).
   */
  getTradeHistory() {
    return this.trades;
  }

  /**
   * Get trade statistics.
   */
  getStats() {
    const trades = this.trades;
    if (trades.length === 0) return null;

    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const winPct = Math.round((wins / trades.length) * 100);
    const avgProfit = trades
      .filter(t => t.won)
      .reduce((sum, t) => sum + t.pnlPct, 0) / (wins || 1);
    const avgLoss = trades
      .filter(t => !t.won)
      .reduce((sum, t) => sum + t.pnlPct, 0) / (losses || 1);

    return {
      totalTrades: trades.length,
      wins,
      losses,
      winPct,
      avgProfit: Math.round(avgProfit),
      avgLoss: Math.round(avgLoss),
      expectancy: Math.round((winPct / 100) * avgProfit - ((100 - winPct) / 100) * Math.abs(avgLoss))
    };
  }
}

let monitor = null;

function getMonitor() {
  if (!monitor) {
    monitor = new PositionMonitor();
  }
  return monitor;
}

function startMonitoring() {
  getMonitor().start();
}

function stopMonitoring() {
  getMonitor().stop();
}

module.exports = {
  getMonitor,
  startMonitoring,
  stopMonitoring
};
