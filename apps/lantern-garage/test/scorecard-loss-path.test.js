"use strict";
/**
 * scorecard-loss-path.test.js — losses must reach the ledger and the scorecard.
 *
 * The autopilot logged an exit only when IT decided to exit. Wins exit by decision
 * (take-profit / momentum-died); losses exit at the broker when the resting
 * protective stop fills — no decision, no log row. So the ledger collected wins and
 * dropped losses, and the scorecard truthfully summarized a lie: 100% win rate.
 *
 * These tests pin the two halves of the fix: auto-trader reconstructs an external
 * close into the ledger, and the scorecard stops counting unfilled attempts and
 * stops treating a profit-only exit as a risk-capable one.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { computeScorecard, reasonFamily } = require("../lib/trader-scorecard");
const _round2 = (n) => Math.round(n * 100) / 100;

test("a stop-out landed as a reconstructed exit counts as a LOSS", () => {
  const s = computeScorecard([
    { symbol: "AAPL", pnl: 120, pnl_pct: 2.0, reason: "take_profit_R (+1R)", status: "placed" },
    { symbol: "NVDA", pnl: -80, pnl_pct: -1.6, reason: "closed_externally (protective stop)", status: "reconstructed", estimated: true },
  ]);
  assert.strictEqual(s.trades, 2);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1, "the stop-out must register as a loss");
  assert.strictEqual(s.winRate, 50);
  assert.strictEqual(s.totalRealized, 40);
  assert.strictEqual(s.estimatedTrades, 1, "and be flagged as mark-priced, not a fill");
});

test("profitFactor is finite once losses land", () => {
  const s = computeScorecard([
    { pnl: 100, reason: "take_profit_R", status: "placed" },
    { pnl: -50, reason: "closed_externally", status: "reconstructed" },
  ]);
  assert.strictEqual(s.profitFactor, 2, "100 / |-50|");
});

test("rejected/frozen attempts are excluded - no phantom trades or P&L", () => {
  const spam = Array.from({ length: 44 }, () => (
    { symbol: "SOXS", pnl: 9.05, reason: "take_profit_R (+26.5%)", status: "error" }
  ));
  const s = computeScorecard([...spam, { symbol: "SPY", pnl: -25, reason: "signal_exit", status: "placed" }]);
  assert.strictEqual(s.trades, 1, "44 failed attempts are not 44 trades");
  assert.strictEqual(s.failedAttempts, 44, "but they are reported, not hidden");
  assert.strictEqual(s.totalRealized, -25, "and contribute no P&L");
  assert.strictEqual(s.losses, 1);
});

test("take_profit_R is profit-only - it cannot inflate riskExitWinRate", () => {
  assert.strictEqual(reasonFamily("take_profit_R (+1R)"), "take_profit_R");
  const s = computeScorecard([
    { pnl: 50, reason: "take_profit_R (+1R)", status: "placed" },
    { pnl: 50, reason: "take_profit_R (+1R)", status: "placed" },
    { pnl: -30, reason: "signal_exit", status: "placed" },
  ]);
  assert.strictEqual(s.byReason.take_profit_R.profitOnly, true);
  assert.strictEqual(s.riskExitTrades, 1, "only the signal_exit can actually lose");
  assert.strictEqual(s.riskExitWinRate, 0, "and it lost - not 66% diluted by profit-takers");
});

test("an all-wins ledger still reports honestly rather than hiding the shape", () => {
  const s = computeScorecard([{ pnl: 10, reason: "take_profit_R", status: "placed" }]);
  assert.strictEqual(s.losses, 0);
  assert.strictEqual(s.profitFactor, Infinity, "no losses yet -> Infinity, not a fake number");
  assert.strictEqual(s.riskExitTrades, 0, "and zero risk-capable exits to judge");
});

test("re-decisions of one open position collapse into a single round-trip", () => {
  // The real shape: one 838.8-share SOXS position re-exited five times, each row
  // re-booking the whole unrealized P&L as realized (~$86k that never existed).
  const dup = [61.48, 60.91, 61.72, 62.14, 69.46].map((px) => ({
    symbol: "SOXS", qty: 838.8, entry: 42.65003005, exit: px,
    pnl: (px - 42.65003005) * 838.8, reason: "take_profit_R", status: "placed",
  }));
  const s = computeScorecard(dup);
  assert.strictEqual(s.trades, 1, "five rows describe ONE position");
  assert.strictEqual(s.duplicateExits, 4);
  assert.strictEqual(s.totalRealized, _round2((69.46 - 42.65003005) * 838.8), "the LAST decision wins, not the sum of all five");
  assert.ok(s.totalRealized < 25000, "not the ~$86k sum of all five");
});

test("genuinely separate trades in the same symbol are NOT collapsed", () => {
  const s = computeScorecard([
    { symbol: "SPY", qty: 10, entry: 400.0, exit: 410, pnl: 100, reason: "signal_exit", status: "placed" },
    { symbol: "SPY", qty: 10, entry: 420.5, exit: 415, pnl: -55, reason: "signal_exit", status: "placed" },
  ]);
  assert.strictEqual(s.trades, 2, "different entry prices = different round-trips");
  assert.strictEqual(s.duplicateExits, 0);
  assert.strictEqual(s.losses, 1);
});
