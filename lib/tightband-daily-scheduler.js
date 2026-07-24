/**
 * Tight-Band Daily Analysis Scheduler (Issue #425)
 *
 * Schedules daily market analysis in tight bands:
 * - Pre-market analysis (6 AM)
 * - Mid-day rebalance (12 PM)
 * - Close analysis (4 PM)
 * - Post-market synthesis (8 PM)
 *
 * Each band runs regime analysis + signal quality checks + position updates.
 */

const path = require("path");
const fs = require("fs");

const ANALYSIS_BANDS = [
  {
    id: "pre_market",
    name: "Pre-Market Analysis",
    hour: 6,
    minute: 0,
    description: "Overnight market moves, regime setup for the day",
    actions: ["regime_scan", "signal_quality_check", "prep_watches"],
  },
  {
    id: "mid_day",
    name: "Mid-Day Rebalance",
    hour: 12,
    minute: 0,
    description: "Check position drift, rebalance if needed",
    actions: ["position_check", "drift_analysis", "rebalance_signal"],
  },
  {
    id: "close",
    name: "Close Analysis",
    hour: 16,
    minute: 0,
    description: "Daily close patterns, next-day setup",
    actions: ["close_pattern", "regime_confirm", "next_day_setup"],
  },
  {
    id: "post_market",
    name: "Post-Market Synthesis",
    hour: 20,
    minute: 0,
    description: "Synthesize day lessons, update models",
    actions: ["daily_synthesis", "lesson_update", "model_refresh"],
  },
];

const ANALYSIS_LOG_PATH = path.resolve(__dirname, "data/analysis-bands.jsonl");

class TightBandScheduler {
  constructor() {
    this._scheduled = new Map();
    this._results = [];
    this._enabled = false;
  }

  /**
   * Start the scheduler — schedule all daily analysis bands
   */
  start() {
    if (this._enabled) return;
    this._enabled = true;

    console.log("[TightBand] Starting daily analysis scheduler");

    for (const band of ANALYSIS_BANDS) {
      this._scheduleBand(band);
    }

    console.log(`[TightBand] Scheduled ${ANALYSIS_BANDS.length} daily analysis bands`);
  }

  /**
   * Schedule a single analysis band
   */
  _scheduleBand(band) {
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(band.hour, band.minute, 0, 0);

    // If the time has passed today, schedule for tomorrow
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    const delayMs = nextRun.getTime() - now.getTime();

    console.log(
      `[TightBand] ${band.name} scheduled for ${nextRun.toLocaleTimeString()} (in ${Math.round(delayMs / 60000)} min)`
    );

    // Set up recurring schedule (daily)
    const timeoutId = setTimeout(() => {
      this._runBand(band);
      // Reschedule for next day
      const nextDay = new Date();
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(band.hour, band.minute, 0, 0);
      const nextDelayMs = nextDay.getTime() - new Date().getTime();
      this._scheduleBand(band); // This will reschedule properly
    }, delayMs);

    this._scheduled.set(band.id, { timeoutId, band, nextRun });
  }

  /**
   * Execute a single analysis band
   */
  async _runBand(band) {
    const startTime = Date.now();
    console.log(`\n[TightBand] Executing ${band.name}...`);

    const result = {
      timestamp: new Date().toISOString(),
      band_id: band.id,
      band_name: band.name,
      actions: [],
    };

    // Execute each action in the band
    for (const action of band.actions) {
      try {
        const actionResult = await this._executeAction(action);
        result.actions.push({
          action,
          status: "success",
          data: actionResult,
        });
        console.log(`  ✓ ${action}`);
      } catch (err) {
        result.actions.push({
          action,
          status: "error",
          error: err.message,
        });
        console.error(`  ✗ ${action}: ${err.message}`);
      }
    }

    result.duration_ms = Date.now() - startTime;
    this._results.push(result);

    // Log result to JSONL
    this._logResult(result);

    console.log(`[TightBand] ${band.name} completed in ${result.duration_ms}ms\n`);
  }

  /**
   * Execute a single action (stub for integration)
   */
  async _executeAction(action) {
    // Placeholder: In production, these would be real analysis functions
    const actions = {
      regime_scan: async () => ({
        regimes_detected: ["TREND", "MEAN", "PIVOT"],
        confidence: 0.85,
      }),
      signal_quality_check: async () => ({
        signals_analyzed: 42,
        quality_score: 0.78,
      }),
      prep_watches: async () => ({
        watchlist_updated: true,
        count: 15,
      }),
      position_check: async () => ({
        positions_open: 3,
        drift_detected: false,
      }),
      drift_analysis: async () => ({
        avg_drift: 0.02,
        max_drift: 0.08,
        rebalance_needed: false,
      }),
      rebalance_signal: async () => ({
        signal_generated: false,
        reason: "drift within tolerance",
      }),
      close_pattern: async () => ({
        pattern: "consolidation",
        next_direction: "neutral",
      }),
      regime_confirm: async () => ({
        current_regime: "MEAN",
        confidence: 0.82,
      }),
      next_day_setup: async () => ({
        recommendation: "neutral bias",
        key_levels: [45, 50, 55],
      }),
      daily_synthesis: async () => ({
        trades_analyzed: 47,
        avg_pnl: 0.012,
        lessons: ["avoid mid-day trades", "regime change signals work"],
      }),
      lesson_update: async () => ({
        lessons_stored: 5,
        model_version: "v2.1",
      }),
      model_refresh: async () => ({
        models_refreshed: 3,
        improvement: 0.03,
      }),
    };

    const actionFn = actions[action];
    if (!actionFn) throw new Error(`Unknown action: ${action}`);

    return await actionFn();
  }

  /**
   * Log analysis result to JSONL
   */
  _logResult(result) {
    try {
      const dir = path.dirname(ANALYSIS_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.appendFileSync(ANALYSIS_LOG_PATH, JSON.stringify(result) + "\n");
    } catch (err) {
      console.error("[TightBand] Failed to log result:", err.message);
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    for (const { timeoutId } of this._scheduled.values()) {
      clearTimeout(timeoutId);
    }
    this._scheduled.clear();
    this._enabled = false;
    console.log("[TightBand] Scheduler stopped");
  }

  /**
   * Get current schedule status
   */
  getStatus() {
    return {
      enabled: this._enabled,
      scheduled_bands: Array.from(this._scheduled.values()).map((s) => ({
        band: s.band.name,
        next_run: s.nextRun.toISOString(),
      })),
      results_count: this._results.length,
    };
  }

  /**
   * Get recent analysis results
   */
  getResults(limit = 10) {
    return this._results.slice(-limit);
  }
}

module.exports = TightBandScheduler;
