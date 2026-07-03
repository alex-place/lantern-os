/**
 * signal-engine — Node deterministic trading signal engine.
 *
 * A keyless, Python-free replacement for the "Riley" technical path that used
 * to live in src/trading_agents (agents.py / cli.py). All TA is computed in Node
 * from Yahoo bars (lib/market-data-yahoo.js). Autonomous decisioning is layered
 * on by the Σ₀ convergence council, not here — this engine only Observes.
 *
 * Public API:
 *   scanAll(watchlist)  -> { signals, zones, logs, timestamp, watchlist_count, signals_count }
 *   getZones(ticker)    -> { ticker, support, resistance, mid, type, strength, touches, trend, volatility, zones }
 */
"use strict";

const scan = require("./scan");

module.exports = {
  scanAll: scan.scanAll,
  getZones: scan.getZones,
  // Sub-modules exposed for the Σ₀ council (Phase 3) + unit tests.
  indicators: require("./indicators"),
  srZones: require("./sr-zones"),
  candles: require("./candles"),
  marketStructure: require("./market-structure"),
  tesseract: require("./tesseract"),
  convergenceEv: require("./convergence-ev"),
};
