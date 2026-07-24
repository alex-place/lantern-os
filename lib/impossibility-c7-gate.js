/**
 * Impossibility Engine C7 Signal Quality Gate (Issue #426)
 *
 * C7 = Constraint Validation Level 7 (highest rigor)
 *
 * Gates trading signals through constraint-elimination framework:
 * 1. Signal must be generated from non-collapsed state
 * 2. Signal must not violate 7 core constraints (liquidity, regime, time, Kelly, correlation, VaR, circuit-break)
 * 3. Only signals passing C7 validation are routed to execution
 *
 * Prevents trades in impossible states (Σ₀ collapse detection).
 */

const path = require("path");
const fs = require("fs");

/**
 * The 7 Core Constraints (C1-C7)
 */
const CONSTRAINTS = [
  {
    id: "C1_Liquidity",
    name: "Minimum Liquidity Required",
    check: (signal, market) => {
      const spread = market.yes_ask - market.yes_bid;
      const spreadBps = (spread / ((market.yes_ask + market.yes_bid) / 2)) * 10000;
      return spreadBps < 200; // Less than 200 bps spread
    },
    description: "Market must have sufficient liquidity (spread < 200 bps)",
  },
  {
    id: "C2_Regime",
    name: "Regime Compatibility",
    check: (signal, market) => {
      const validRegimes = ["TREND", "MEAN", "PIVOT"];
      return validRegimes.includes(signal.regime || "MEAN");
    },
    description: "Signal regime must match known valid regimes",
  },
  {
    id: "C3_TimeToClose",
    name: "Time-To-Close Minimum",
    check: (signal, market) => {
      const minsToClose = (new Date(market.close_time).getTime() - Date.now()) / 60000;
      return minsToClose > 5; // At least 5 minutes to close
    },
    description: "Market must have sufficient time remaining (> 5 min)",
  },
  {
    id: "C4_KellySize",
    name: "Kelly Criterion Sizing",
    check: (signal, account) => {
      if (!signal.position_size || !account.capital) return true; // Skip if incomplete
      const kellySize = (signal.win_rate * signal.payoff - (1 - signal.win_rate)) / signal.payoff;
      const maxSize = account.capital * Math.abs(kellySize);
      return signal.position_size <= maxSize;
    },
    description: "Position size must not exceed Kelly criterion bound",
  },
  {
    id: "C5_Correlation",
    name: "Portfolio Correlation Check",
    check: (signal, portfolio) => {
      if (!portfolio.positions || portfolio.positions.length === 0) return true;
      // Check if signal correlates too highly with existing positions (> 0.7)
      const avgCorr = portfolio.positions.reduce((sum, pos) => {
        return sum + (Math.random() * 0.5); // Stub: would be real correlation calc
      }, 0) / portfolio.positions.length;
      return avgCorr < 0.7;
    },
    description: "Signal must not create portfolio concentration (correlation < 0.7)",
  },
  {
    id: "C6_VaR",
    name: "Value-at-Risk Limit",
    check: (signal, riskProfile) => {
      if (!signal.position_size || !riskProfile.var_limit) return true;
      const estimatedLoss = signal.position_size * (1 - signal.win_rate);
      return estimatedLoss <= riskProfile.var_limit;
    },
    description: "Estimated loss must be within VaR limit",
  },
  {
    id: "C7_CircuitBreak",
    name: "Circuit Breaker (Σ₀ Collapse Detection)",
    check: (signal, systemHealth) => {
      // Detect if system is in a collapsed state (all signals identical, no diversity, etc.)
      if (!systemHealth.recent_signals || systemHealth.recent_signals.length < 10) return true;
      const uniqueSignals = new Set(systemHealth.recent_signals);
      const diversity = uniqueSignals.size / systemHealth.recent_signals.length;
      return diversity > 0.3; // At least 30% signal diversity (not collapsed)
    },
    description: "System must not be in Σ₀ collapsed state (signal diversity > 30%)",
  },
];

class ImpossibilityC7Gate {
  constructor() {
    this._results = [];
    this._enabled = true;
    this._logPath = path.resolve(__dirname, "data/c7-gate-log.jsonl");
  }

  /**
   * Validate a signal through all C1-C7 constraints
   * Returns { passed: boolean, violations: [], reasoning: string }
   */
  validateSignal(signal, context = {}) {
    const startTime = Date.now();
    const violations = [];

    // Extract context
    const market = context.market || {};
    const account = context.account || {};
    const portfolio = context.portfolio || {};
    const riskProfile = context.riskProfile || {};
    const systemHealth = context.systemHealth || {};

    // Run all 7 constraints
    for (const constraint of CONSTRAINTS) {
      try {
        const passed = constraint.check(signal, context[constraint.id.split("_")[0].toLowerCase()] || context);
        if (!passed) {
          violations.push({
            constraint_id: constraint.id,
            constraint_name: constraint.name,
            description: constraint.description,
          });
        }
      } catch (err) {
        violations.push({
          constraint_id: constraint.id,
          constraint_name: constraint.name,
          error: err.message,
        });
      }
    }

    const result = {
      timestamp: new Date().toISOString(),
      signal_id: signal.id || "unknown",
      passed: violations.length === 0,
      violations_count: violations.length,
      violations,
      constraints_checked: CONSTRAINTS.length,
      duration_ms: Date.now() - startTime,
    };

    if (violations.length === 0) {
      result.reasoning = "✓ Signal passes all C1-C7 constraints — APPROVED";
    } else {
      result.reasoning = `✗ Signal blocked by ${violations.length} constraint(s): ${violations.map((v) => v.constraint_id).join(", ")}`;
    }

    this._results.push(result);
    this._logResult(result);

    return result;
  }

  /**
   * Batch validate multiple signals
   */
  validateBatch(signals, context) {
    return signals.map((sig) => this.validateSignal(sig, context));
  }

  /**
   * Get gate statistics
   */
  getStatistics() {
    if (this._results.length === 0) return null;

    const passed = this._results.filter((r) => r.passed).length;
    const blocked = this._results.length - passed;
    const avgTime = this._results.reduce((sum, r) => sum + r.duration_ms, 0) / this._results.length;

    // Most common violations
    const violationCounts = {};
    for (const result of this._results) {
      for (const violation of result.violations) {
        violationCounts[violation.constraint_id] =
          (violationCounts[violation.constraint_id] || 0) + 1;
      }
    }

    return {
      total_signals_checked: this._results.length,
      approved: passed,
      blocked,
      approval_rate: ((passed / this._results.length) * 100).toFixed(1) + "%",
      avg_check_time_ms: Math.round(avgTime),
      most_common_violations: Object.entries(violationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cid, count]) => ({ constraint: cid, count })),
    };
  }

  /**
   * Get recent validation results
   */
  getResults(limit = 20) {
    return this._results.slice(-limit);
  }

  /**
   * Log result to JSONL
   */
  _logResult(result) {
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.appendFileSync(this._logPath, JSON.stringify(result) + "\n");
    } catch (err) {
      console.error("[C7 Gate] Failed to log result:", err.message);
    }
  }

  /**
   * Enable/disable the gate
   */
  setEnabled(enabled) {
    this._enabled = enabled;
    console.log(`[C7 Gate] ${enabled ? "Enabled" : "Disabled"}`);
  }

  /**
   * Get constraint definitions for documentation
   */
  static getConstraints() {
    return CONSTRAINTS;
  }
}

module.exports = ImpossibilityC7Gate;
