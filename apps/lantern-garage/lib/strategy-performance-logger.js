/**
 * Strategy Performance Logger — Phase A Integration
 *
 * Logs trade outcomes + performance metrics for strategy fitness evaluation.
 * Used by kalshi-suggest.js (entry suggestions) and trading.js (execution).
 *
 * Schema: { timestamp, commit_hash, strategy_id, regime, pnl, drawdown,
 *           stability, position_id, market, is_live }
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");

const PERF_LOG_PATH = path.resolve(__dirname, "../../data/csf_memory/strategy-performance.jsonl");

/**
 * Get current commit hash for reproducibility tracking
 */
function getCurrentCommitHash() {
  try {
    const { execSync } = require("child_process");
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    return hash || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Log a single trade's performance metrics
 */
async function logPerformance(params) {
  try {
    const {
      strategy_id,
      regime,
      pnl = 0,
      drawdown = 0,
      stability = 0,
      position_id,
      market,
      is_live = false
    } = params;

    // Ensure log directory exists
    const dir = path.dirname(PERF_LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const record = {
      timestamp: new Date().toISOString(),
      commit_hash: getCurrentCommitHash(),
      strategy_id,
      regime,
      pnl: parseFloat(pnl).toFixed(2),
      drawdown: parseFloat(drawdown).toFixed(2),
      stability: parseFloat(stability).toFixed(1),
      position_id,
      market,
      is_live
    };

    // Append to JSONL log (non-blocking)
    await appendJsonlQueued(PERF_LOG_PATH, record, { rotate: true }); // #872

    console.log(`[strategy-performance-logger] Logged: ${strategy_id} / ${regime} / ${record.pnl}% PnL`);
  } catch (e) {
    console.error(`[strategy-performance-logger] Failed to log performance:`, e.message);
  }
}

/**
 * Get aggregated strategy fitness metrics
 */
function getStrategyFitness(strategy_id = null, regime = null, limit = 50) {
  try {
    if (!fs.existsSync(PERF_LOG_PATH)) {
      return { pnl: 0, drawdown: 0, stability: 0, count: 0, trades: [] };
    }

    const lines = fs
      .readFileSync(PERF_LOG_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(l => l.length > 0)
      .slice(-limit);

    const trades = lines
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Filter by strategy_id and regime if provided
    const filtered = trades.filter(t => {
      if (strategy_id && t.strategy_id !== strategy_id) return false;
      if (regime && t.regime !== regime) return false;
      return true;
    });

    if (filtered.length === 0) {
      return { pnl: 0, drawdown: 0, stability: 0, count: 0, trades: [] };
    }

    const pnl = filtered.reduce((sum, t) => sum + parseFloat(t.pnl), 0) / filtered.length;
    const drawdown = filtered.reduce((sum, t) => sum + parseFloat(t.drawdown), 0) / filtered.length;
    const stability = filtered.reduce((sum, t) => sum + parseFloat(t.stability), 0) / filtered.length;

    return {
      pnl: parseFloat(pnl.toFixed(2)),
      drawdown: parseFloat(drawdown.toFixed(2)),
      stability: parseFloat(stability.toFixed(1)),
      count: filtered.length,
      trades: filtered
    };
  } catch (e) {
    console.error(`[strategy-performance-logger] Failed to read fitness:`, e.message);
    return { pnl: 0, drawdown: 0, stability: 0, count: 0, trades: [] };
  }
}

/**
 * Pick the best-performing strategy for a regime from the candidate ids.
 * Returns { strategy_id, fitness, score }. On cold start (no logged trades)
 * every candidate scores 0 and the first id is returned — a valid object so the
 * deck renders instead of throwing. Score rewards pnl, penalises drawdown.
 */
function getBestStrategyForRegime(regime, strategyIds = []) {
  const ids = Array.isArray(strategyIds) && strategyIds.length ? strategyIds : ["default"];
  let best = null;
  for (const id of ids) {
    const fitness = getStrategyFitness(id, regime);
    const score = fitness.count > 0 ? fitness.pnl - Math.abs(fitness.drawdown) * 0.5 : 0;
    if (!best || score > best.score) best = { strategy_id: id, fitness, score };
  }
  return best;
}

/**
 * Clear all performance logs (debug only)
 */
function clearPerformanceLog() {
  try {
    if (fs.existsSync(PERF_LOG_PATH)) {
      fs.unlinkSync(PERF_LOG_PATH);
      console.log(`[strategy-performance-logger] Cleared log`);
    }
  } catch (e) {
    console.error(`[strategy-performance-logger] Failed to clear log:`, e.message);
  }
}

module.exports = {
  logPerformance,
  getStrategyFitness,
  getBestStrategyForRegime,
  clearPerformanceLog,
  PERF_LOG_PATH
};
