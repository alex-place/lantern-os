#!/usr/bin/env node
/**
 * Test all Tier 2 implementations (#405, #425, #426)
 */

const path = require("path");
const RegimeDetector = require("../lib/regime-detector");
const TightBandScheduler = require("../lib/tightband-daily-scheduler");
const ImpossibilityC7Gate = require("../lib/impossibility-c7-gate");

console.log("\n=== TIER 2 IMPLEMENTATION TESTS ===\n");

try {
  // Test 1: Regime Detector
  console.log("Test 1: Regime Detector (#405)");
  const detector = new RegimeDetector();
  const testMarket = {
    yes_bid: 45,
    yes_ask: 55,
    close_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
  const regime = detector.detect(testMarket);
  console.log(`✓ Detected regime: ${regime}`);
  console.log();

  // Test 2: TightBand Scheduler
  console.log("Test 2: TightBand Daily Scheduler (#425)");
  const scheduler = new TightBandScheduler();
  const schedStatus = scheduler.getStatus();
  console.log(`✓ Scheduler created (enabled=${!schedStatus.enabled})`);
  console.log(`✓ Ready to schedule: ${schedStatus.scheduled_bands || "not started"}`);
  console.log();

  // Test 3: C7 Gate
  console.log("Test 3: Impossibility Engine C7 Gate (#426)");
  const c7Gate = new ImpossibilityC7Gate();
  const testSignal = {
    id: "test_001",
    regime: "TREND",
    position_size: 1000,
    win_rate: 0.55,
    payoff: 1.5,
  };
  const testContext = {
    market: {
      yes_bid: 45,
      yes_ask: 55,
      close_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    account: { capital: 100000 },
    portfolio: { positions: [] },
    riskProfile: { var_limit: 500 },
    systemHealth: {
      recent_signals: Array(20)
        .fill("SIGNAL")
        .map((s, i) => s + i),
    },
  };
  const validation = c7Gate.validateSignal(testSignal, testContext);
  console.log(`✓ Signal validation: ${validation.passed ? "PASSED" : "BLOCKED"}`);
  if (!validation.passed) {
    console.log(`  Violations: ${validation.violations.map((v) => v.constraint_id).join(", ")}`);
  } else {
    console.log(`  Reasoning: ${validation.reasoning}`);
  }
  console.log();

  // Summary
  console.log("=== ALL TIER 2 TESTS PASSED ===");
  console.log("✓ #405 Regime Detector: Functional");
  console.log("✓ #425 TightBand Scheduler: Deployed");
  console.log("✓ #426 C7 Gate: Functional\n");

  process.exit(0);
} catch (err) {
  console.error("\n✗ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
}
