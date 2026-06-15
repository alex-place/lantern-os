"use strict";
const assert = require("assert");
const path = require("path");
const dashboardModule = require(path.join(__dirname, "../apps/lantern-garage/lib/kalshi-realtime-dashboard"));

const mockPositions = [
  { ticker: "KXMLBGAME1", quantity: 10, cost: 500, side: "yes" },
  { ticker: "KXMLBGAME1", quantity: 5, cost: 250, side: "yes" },
  { ticker: "KXMLBGAME2", quantity: -8, cost: 400, side: "no" }
];

const mockTrades = [
  { ticker: "KXMLBGAME1", side: "yes", pnlPct: 5.5, won: true, pnl: 50 },
  { ticker: "KXMLBGAME2", side: "no", pnlPct: -2.3, won: false, pnl: -20 },
  { ticker: "KXMLBGAME3", side: "yes", pnlPct: 8.1, won: true, pnl: 75 }
];

describe("Kalshi Real-Time Dashboard", function () {
  it("should aggregate positions by ticker", function () {
    const aggregated = dashboardModule.aggregatePositions(mockPositions);
    assert.strictEqual(Object.keys(aggregated).length, 2);
  });

  it("should calculate performance metrics", function () {
    const metrics = dashboardModule.calculatePerformanceMetrics(mockTrades);
    assert.strictEqual(metrics.totalTrades, 3);
    assert.strictEqual(metrics.wins, 2);
    assert.strictEqual(metrics.winRate, 66.67);
  });
});
