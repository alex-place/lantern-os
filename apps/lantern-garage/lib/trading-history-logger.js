/**
 * Trading History Logger (P3: Trade History Persistence)
 *
 * Simple JSONL-based logging for:
 * - Trades (entry, exit, P&L per trade)
 * - Signals (all generated signals with confidence)
 *
 * Complements CSF memory logging; provides simple queryable history
 * for dream-chat integration and dashboard references.
 *
 * Files:
 * - data/trading/trades.jsonl
 * - data/trading/signals.jsonl
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const TRADES_LOG_PATH = path.resolve(__dirname, "../../data/trading/trades.jsonl");
const SIGNALS_LOG_PATH = path.resolve(__dirname, "../../data/trading/signals.jsonl");

/**
 * Ensure trading data directory exists
 */
function _ensureDir() {
  const dir = path.dirname(TRADES_LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Log a trade execution (entry + exit with P&L)
 * @param {object} tradeData - { entry_symbol, entry_price, entry_qty, exit_price, exit_qty?, pnl, pnl_pct, duration_mins, regime, strategy_id, position_id }
 */
async function logTrade(tradeData) {
  try {
    _ensureDir();

    const record = {
      timestamp: new Date().toISOString(),
      entry_symbol: tradeData.entry_symbol,
      entry_price: tradeData.entry_price,
      entry_qty: tradeData.entry_qty,
      exit_price: tradeData.exit_price,
      exit_qty: tradeData.exit_qty || tradeData.entry_qty,
      pnl: parseFloat(tradeData.pnl).toFixed(2),
      pnl_pct: parseFloat(tradeData.pnl_pct).toFixed(2),
      duration_mins: tradeData.duration_mins,
      regime: tradeData.regime || "UNKNOWN",
      strategy_id: tradeData.strategy_id,
      position_id: tradeData.position_id,
    };

    await appendJsonlQueued(TRADES_LOG_PATH, record, { rotate: true }); // per-trade hot path (#872)
    console.log(`[trading-history] Logged trade: ${record.entry_symbol} ${record.pnl_pct}% P&L`);
  } catch (e) {
    console.error(`[trading-history] Failed to log trade:`, e.message);
  }
}

/**
 * Log a generated signal
 * @param {object} signalData - { symbol, direction, confidence, regime, catalyst, price, market_time, ai_model }
 */
async function logSignal(signalData) {
  try {
    _ensureDir();

    const record = {
      timestamp: new Date().toISOString(),
      signal_id: signalData.signal_id || `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      symbol: signalData.symbol,
      direction: signalData.direction, // BUY, SELL, HOLD
      confidence: parseFloat(signalData.confidence).toFixed(3),
      regime: signalData.regime,
      catalyst: signalData.catalyst || "",
      price: signalData.price,
      market_time: signalData.market_time,
      ai_model: signalData.ai_model || "unknown",
      source: signalData.source || "trading-system",
    };

    await appendJsonlQueued(SIGNALS_LOG_PATH, record, { rotate: true }); // per-signal hot path (#872)
    console.log(`[trading-history] Logged signal: ${record.symbol} ${record.direction} (${record.confidence})`);
  } catch (e) {
    console.error(`[trading-history] Failed to log signal:`, e.message);
  }
}

/**
 * Query trade history
 * @param {object} opts - { symbol?, limit, since_date? }
 */
function getTradeHistory(opts = {}) {
  try {
    if (!fs.existsSync(TRADES_LOG_PATH)) {
      return [];
    }

    const limit = opts.limit || 20;
    const symbol = opts.symbol?.toUpperCase();
    const sinceDate = opts.since_date ? new Date(opts.since_date) : null;

    const lines = fs
      .readFileSync(TRADES_LOG_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(l => l.length > 0)
      .slice(-limit);

    return lines
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(trade => {
        if (symbol && trade.entry_symbol !== symbol) return false;
        if (sinceDate && new Date(trade.timestamp) < sinceDate) return false;
        return true;
      })
      .reverse(); // Newest first
  } catch (e) {
    console.error(`[trading-history] Failed to read trade history:`, e.message);
    return [];
  }
}

/**
 * Query signal history
 * @param {object} opts - { symbol?, limit, min_confidence? }
 */
function getSignalHistory(opts = {}) {
  try {
    if (!fs.existsSync(SIGNALS_LOG_PATH)) {
      return [];
    }

    const limit = opts.limit || 20;
    const symbol = opts.symbol?.toUpperCase();
    const minConfidence = opts.min_confidence ? parseFloat(opts.min_confidence) : 0;

    const lines = fs
      .readFileSync(SIGNALS_LOG_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(l => l.length > 0)
      .slice(-limit);

    return lines
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(signal => {
        if (symbol && signal.symbol !== symbol) return false;
        if (parseFloat(signal.confidence) < minConfidence) return false;
        return true;
      })
      .reverse(); // Newest first
  } catch (e) {
    console.error(`[trading-history] Failed to read signal history:`, e.message);
    return [];
  }
}

/**
 * Get trade statistics summary
 */
function getTradeStats(opts = {}) {
  const trades = getTradeHistory({ limit: 100, ...opts });

  if (trades.length === 0) {
    return {
      total_trades: 0,
      winning_trades: 0,
      losing_trades: 0,
      win_rate: 0,
      avg_pnl: 0,
      avg_pnl_pct: 0,
      total_pnl: 0,
    };
  }

  const pnls = trades.map(t => parseFloat(t.pnl_pct));
  const winning = pnls.filter(p => p > 0).length;
  const losing = pnls.filter(p => p < 0).length;

  return {
    total_trades: trades.length,
    winning_trades: winning,
    losing_trades: losing,
    win_rate: ((winning / trades.length) * 100).toFixed(1) + "%",
    avg_pnl: (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2),
    avg_pnl_pct: (pnls.reduce((a, b) => a + parseFloat(b), 0) / pnls.length).toFixed(2) + "%",
    total_pnl: pnls.reduce((a, b) => a + b, 0).toFixed(2),
  };
}

module.exports = {
  logTrade,
  logSignal,
  getTradeHistory,
  getSignalHistory,
  getTradeStats,
  TRADES_LOG_PATH,
  SIGNALS_LOG_PATH,
};
