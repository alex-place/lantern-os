/**
 * TradingTesseract — 5-dimension asset evaluation engine (Trading Phase 4, issue #325).
 *
 * Node/CommonJS port of src/trading_agents/trading_tesseract.py. Same 5 dimensions,
 * same scoring tables, same confidence weights, same action thresholds.
 *
 * Evaluates each watchlist asset across five dimensions and produces a
 * { asset, cube, confidence, action, evaluated_at } recommendation for the Signal Panel.
 *
 * IMPORTANT: NOT related to src/csf/status_cube.py (Three Doors). Names are distinct.
 *
 * Dimensions
 *   1. time         realtime / intraday / session / eod
 *   2. market       bullish / bearish / neutral / volatile / calm
 *   3. signal       strong / moderate / weak / invalid
 *   4. layer        scanner / riley / mft / risk / claude / execution
 *   5. asset_state  watching / active / in_trade / closed / rejected
 */

"use strict";

// ── Dimension value sets ────────────────────────────────────────────────────
const TIME_DIMS   = ["realtime", "intraday", "session", "eod"];
const MARKET_DIMS = ["bullish", "bearish", "neutral", "volatile", "calm"];
const SIGNAL_DIMS = ["strong", "moderate", "weak", "invalid"];
const LAYER_DIMS  = ["scanner", "riley", "mft", "risk", "claude", "execution"];
const ASSET_DIMS  = ["watching", "active", "in_trade", "closed", "rejected"];

// Confidence weights per dimension
const DIM_WEIGHTS = {
  time:        0.10,
  market:      0.30,
  signal:      0.35,
  layer:       0.10,
  asset_state: 0.15,
};

// Per-value confidence contributions (0.0-1.0)
const SIGNAL_SCORES = { strong: 1.0, moderate: 0.6, weak: 0.3, invalid: 0.0 };
const MARKET_SCORES = { bullish: 1.0, neutral: 0.5, calm: 0.5, volatile: 0.35, bearish: 0.1 };
const STATE_SCORES  = { watching: 0.5, active: 0.8, in_trade: 0.9, closed: 0.0, rejected: 0.0 };
const LAYER_SCORES  = { claude: 1.0, mft: 0.85, riley: 0.75, scanner: 0.6, risk: 0.5, execution: 0.4 };
const TIME_SCORES   = { realtime: 1.0, intraday: 0.8, session: 0.6, eod: 0.4 };

// ── helpers ─────────────────────────────────────────────────────────────────

// Mirror Python float(x or 0.0): coerce to number, non-finite / null / "" → 0.0.
function num(x) {
  if (x === null || x === undefined || x === "") return 0.0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0.0;
}

function upper(x) {
  return String(x === null || x === undefined ? "" : x).toUpperCase();
}

function lower(x) {
  return String(x === null || x === undefined ? "" : x).toLowerCase();
}

// ── Dimension classifiers ───────────────────────────────────────────────────

// Infer time dimension from data recency and market-hours flag.
function classifyTime(zonesData, marketStatus) {
  if (marketStatus.market_open) {
    const tsStr = zonesData.timestamp || zonesData.updated_at;
    if (tsStr) {
      const ts = new Date(String(tsStr).replace("Z", "+00:00"));
      if (!Number.isNaN(ts.getTime())) {
        const ageS = (Date.now() - ts.getTime()) / 1000;
        if (ageS < 60) return "realtime";
        if (ageS < 3600) return "intraday";
        return "session";
      }
    }
    return "intraday";
  }
  return "eod";
}

// Derive market regime from VIX regime + SPY trend.
function classifyMarket(marketStatus) {
  const vixRegime = upper(marketStatus.vix_regime);
  if (vixRegime === "HIGH" || vixRegime === "EXTREME") return "volatile";
  const spyChange = num(marketStatus.spy_day_change_pct);
  if (spyChange > 0.8) return "bullish";
  if (spyChange < -0.8) return "bearish";
  if (vixRegime === "CALM") return "calm";
  return "neutral";
}

// Grade the latest agent signal for this asset.
function classifySignal(asset, zonesData, agentLogEntries) {
  // Check agent-log for a recent entry for this asset (last 50, most-recent first).
  const recent = agentLogEntries.slice(-50);
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const sym = entry.symbol || entry.asset || entry.ticker || "";
    if (upper(sym) === upper(asset)) {
      const strength = lower(entry.signal_strength || entry.strength || "");
      if (SIGNAL_DIMS.includes(strength)) return strength;
      // Infer from score/confidence
      const score = num(entry.score || entry.confidence);
      if (score >= 0.75) return "strong";
      if (score >= 0.45) return "moderate";
      if (score > 0.0) return "weak";
    }
  }

  // Fall back to zone density.
  const assetZones = (zonesData && typeof zonesData === "object" && zonesData[asset]) || {};
  if (!Object.keys(assetZones).length) return "invalid";
  const top = num(assetZones.top || assetZones.resistance);
  const bot = num(assetZones.bottom || assetZones.support);
  const mid = num(assetZones.mid || assetZones.entry_price);
  if (top > 0 && bot > 0 && mid > 0) {
    const spreadPct = mid ? (top - bot) / mid : 0.0;
    if (spreadPct < 0.02) return "strong";
    if (spreadPct < 0.05) return "moderate";
    return "weak";
  }
  return "weak";
}

// Identify which agent layer produced the most recent signal for this asset.
function classifyLayer(agentLogEntries, asset) {
  const recent = agentLogEntries.slice(-50);
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const sym = entry.symbol || entry.asset || entry.ticker || "";
    if (upper(sym) === upper(asset)) {
      const agent = lower(entry.agent || entry.layer || "");
      if (LAYER_DIMS.includes(agent)) return agent;
      if (agent.includes("claude")) return "claude";
      if (agent.includes("mft") || agent.includes("multi")) return "mft";
      if (agent.includes("riley")) return "riley";
      if (agent.includes("risk")) return "risk";
      if (agent.includes("execut")) return "execution";
    }
  }
  return "scanner";
}

// Infer asset state from portfolio positions.
function classifyAssetState(asset, marketStatus) {
  const positions = marketStatus.positions || [];
  for (const pos of positions) {
    const sym = pos.symbol || pos.ticker || "";
    if (upper(sym) === upper(asset)) {
      const qty = num(pos.qty || pos.quantity);
      return qty !== 0 ? "in_trade" : "closed";
    }
  }
  return "watching";
}

// ── Confidence & action derivation ──────────────────────────────────────────

// Weighted average of per-dimension scores.
function computeConfidence(cube) {
  const scores = {
    signal:      SIGNAL_SCORES[cube.signal] !== undefined ? SIGNAL_SCORES[cube.signal] : 0.0,
    market:      MARKET_SCORES[cube.market] !== undefined ? MARKET_SCORES[cube.market] : 0.5,
    asset_state: STATE_SCORES[cube.asset_state] !== undefined ? STATE_SCORES[cube.asset_state] : 0.0,
    layer:       LAYER_SCORES[cube.layer] !== undefined ? LAYER_SCORES[cube.layer] : 0.5,
    time:        TIME_SCORES[cube.time] !== undefined ? TIME_SCORES[cube.time] : 0.5,
  };
  let total = 0;
  for (const k of Object.keys(scores)) total += DIM_WEIGHTS[k] * scores[k];
  const clamped = Math.min(1.0, Math.max(0.0, total));
  // Match Python round(x, 4) (banker's rounding is not needed here at 4 dp for these inputs).
  return Math.round(clamped * 1e4) / 1e4;
}

// Map (confidence, cube state) to a recommended action. Conservative rule-set, not ML.
function deriveAction(confidence, cube) {
  if (cube.signal === "invalid") return "skip";
  if (cube.asset_state === "closed" || cube.asset_state === "rejected") return "skip";
  if (cube.market === "volatile" && confidence < 0.55) return "hold";
  if (confidence >= 0.72 && (cube.market === "bullish" || cube.market === "neutral" || cube.market === "calm")) return "buy";
  if (confidence >= 0.55) return "watch";
  if (cube.market === "bearish" && (cube.signal === "weak" || cube.signal === "invalid")) return "skip";
  return "hold";
}

// ── TradingTesseract ────────────────────────────────────────────────────────

/**
 * Evaluates a single asset across 5 dimensions and returns a structured
 * recommendation. Thread-safe: no shared mutable state between calls.
 */
class TradingTesseract {
  /**
   * @param {string} asset            ticker symbol, e.g. "AAPL"
   * @param {object|null} zonesData   dict keyed by symbol (scan_market / get_zones output)
   * @param {object|null} marketStatus get_market_status output
   * @param {Array|null} agentLogEntries agent-log records (most recent last)
   * @param {string} [evaluatedAt]    optional ISO timestamp; defaults to now
   * @returns {{asset:string, cube:object, confidence:number, action:string, evaluated_at:string}}
   */
  evaluate(asset, zonesData, marketStatus, agentLogEntries, evaluatedAt) {
    zonesData        = zonesData || {};
    marketStatus     = marketStatus || {};
    agentLogEntries  = agentLogEntries || [];

    const cube = {
      time:        classifyTime(zonesData, marketStatus),
      market:      classifyMarket(marketStatus),
      signal:      classifySignal(asset, zonesData, agentLogEntries),
      layer:       classifyLayer(agentLogEntries, asset),
      asset_state: classifyAssetState(asset, marketStatus),
    };

    const confidence = computeConfidence(cube);
    const action     = deriveAction(confidence, cube);

    return {
      asset:        upper(asset),
      cube,
      confidence,
      action,
      evaluated_at: evaluatedAt || new Date().toISOString(),
    };
  }

  /** Evaluate all assets in a watchlist and return sorted by confidence desc. */
  evaluateWatchlist(watchlist, zonesData, marketStatus, agentLogEntries, evaluatedAt) {
    const results = (watchlist || []).map((asset) =>
      this.evaluate(asset, zonesData, marketStatus, agentLogEntries, evaluatedAt)
    );
    return results.sort((a, b) => b.confidence - a.confidence);
  }
}

// Convenience module-level functions (fresh instance; stateless anyway).
function evaluate(asset, zonesData, marketStatus, agentLogEntries, evaluatedAt) {
  return new TradingTesseract().evaluate(asset, zonesData, marketStatus, agentLogEntries, evaluatedAt);
}

function evaluateWatchlist(watchlist, zonesData, marketStatus, agentLogEntries, evaluatedAt) {
  return new TradingTesseract().evaluateWatchlist(watchlist, zonesData, marketStatus, agentLogEntries, evaluatedAt);
}

module.exports = {
  TradingTesseract,
  Tesseract: TradingTesseract, // alias
  evaluate,
  evaluateWatchlist,
  // exported for tests / introspection
  TIME_DIMS, MARKET_DIMS, SIGNAL_DIMS, LAYER_DIMS, ASSET_DIMS,
  DIM_WEIGHTS,
};

// ── self-test ───────────────────────────────────────────────────────────────
if (require.main === module) {
  const zonesData = {
    timestamp: new Date().toISOString(),   // fresh → "realtime"
    AAPL: { mid: 190.0, top: 192.0, bottom: 188.5, type: "range", strength: 0.8, touches: 3, triggered_entry: false },
  };
  const marketStatus = {
    market_open: true,
    vix: 14.2,
    vix_regime: "CALM",
    spy_day_change_pct: 1.1,               // > 0.8 → "bullish"
    positions: [],
  };
  const agentLog = [
    { time: new Date().toISOString(), agent: "claude", body: "strong long setup", symbol: "AAPL", signal_strength: "strong" },
  ];

  const tt = new TradingTesseract();
  const result = tt.evaluate("aapl", zonesData, marketStatus, agentLog);
  console.log("=== TradingTesseract self-test ===");
  console.log("asset:       ", result.asset);
  console.log("cube:        ", JSON.stringify(result.cube));
  console.log("confidence:  ", result.confidence);
  console.log("action:      ", result.action);
  console.log("evaluated_at:", result.evaluated_at);

  // watchlist sanity: second asset has no data → should rank lower
  const wl = evaluateWatchlist(["AAPL", "TSLA"], zonesData, marketStatus, agentLog);
  console.log("\n=== watchlist (sorted by confidence desc) ===");
  for (const r of wl) console.log(`  ${r.asset}  conf=${r.confidence}  action=${r.action}  signal=${r.cube.signal}`);
}
