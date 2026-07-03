"use strict";
/**
 * signal-engine.test.js — unit tests for the Node deterministic signal engine
 * that replaced the Python src/trading_agents scan path.
 *
 * Pure-function tests only (no network): the live scanAll() is exercised
 * separately against Yahoo. Run: node --test test/signal-engine.test.js
 */
const { test } = require("node:test");
const assert = require("node:assert");

const { rsi, rsiSeries, adaptiveRsiThresholds, RSI_FALLBACK } = require("../lib/signal-engine/indicators");
const { findSrZones } = require("../lib/signal-engine/sr-zones");
const { detectCandlePatterns } = require("../lib/signal-engine/candles");
const { checkMarketStructureShift } = require("../lib/signal-engine/market-structure");
const tesseract = require("../lib/signal-engine/tesseract");
const ev = require("../lib/signal-engine/convergence-ev");
const { deriveDirection, rileyGate, convergenceVerdict } = require("../lib/signal-engine/scan");

// ── helpers ──────────────────────────────────────────────────────────────────
function bar(close, o, h, l, v = 1000) {
  return {
    timestamp: "2026-07-03T00:00:00.000Z",
    open: o ?? close,
    high: h ?? Math.max(o ?? close, close) + 0.1,
    low: l ?? Math.min(o ?? close, close) - 0.1,
    close,
    volume: v,
  };
}
// ~120 fifteen-min bars bouncing between support 98 and resistance 102.
function bouncingBars(n = 120) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + 2 * Math.sin(i / 3);
    out.push(bar(c, c - 0.05, c + 0.15, c - 0.15));
  }
  return out;
}

// ── indicators ───────────────────────────────────────────────────────────────
test("rsi: steadily rising closes → RSI near 100", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.ok(rsi(closes) >= 99, `expected ~100, got ${rsi(closes)}`);
});

test("rsi: steadily falling closes → RSI near 0", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.ok(rsi(closes) <= 1, `expected ~0, got ${rsi(closes)}`);
});

test("adaptiveRsiThresholds: short data falls back", () => {
  assert.deepStrictEqual(adaptiveRsiThresholds([1, 2, 3]), { ...RSI_FALLBACK });
});

test("adaptiveRsiThresholds: oversold < median < overbought", () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + 6 * Math.sin(i / 5) + (i % 7));
  const t = adaptiveRsiThresholds(closes);
  assert.ok(t.oversold <= t.median && t.median <= t.overbought, JSON.stringify(t));
});

// ── sr-zones ─────────────────────────────────────────────────────────────────
test("findSrZones: locates support ~98 and resistance ~102", () => {
  const sr = findSrZones("TEST", 100, bouncingBars());
  assert.ok(Array.isArray(sr.zones) && sr.zones.length > 0, JSON.stringify(sr));
  // The bars bounce 98↔102, so the zone set must contain both a support near 98
  // and a resistance near 102 (top-level support/resistance reflect the *nearest*
  // zone to price, which is a separate summary field).
  const sup = sr.zones.find((z) => z.type === "SUPPORT" && Math.abs(z.level - 98) < 1.2);
  const res = sr.zones.find((z) => z.type === "RESISTANCE" && Math.abs(z.level - 102) < 1.2);
  const dump = JSON.stringify(sr.zones.map((z) => [z.type, z.level]));
  assert.ok(sup, "expected a support zone near 98; zones=" + dump);
  assert.ok(res, "expected a resistance zone near 102; zones=" + dump);
});

test("findSrZones: empty bars → NEUTRAL, no throw", () => {
  const sr = findSrZones("TEST", 100, []);
  assert.strictEqual(sr.type, "NEUTRAL");
  assert.strictEqual(sr.support, null);
});

// ── candles ──────────────────────────────────────────────────────────────────
test("detectCandlePatterns: insufficient bars is graceful", () => {
  const r = detectCandlePatterns([bar(100)], "BULLISH");
  assert.strictEqual(r.pattern, null);
  assert.strictEqual(r.strength, 0);
});

// ── market structure ─────────────────────────────────────────────────────────
test("checkMarketStructureShift: clean uptrend confirms BULLISH", () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(100 + i * 0.5));
  const s = checkMarketStructureShift(bars, "BULLISH");
  assert.ok(["CONFIRM", "NEUTRAL"].includes(s.shift));
  assert.ok(typeof s.strength === "number");
});

// ── tesseract (parity anchor) ────────────────────────────────────────────────
test("tesseract.evaluate: returns cube/confidence/action", () => {
  const zones = { AAPL: { mid: 100, top: 101, bottom: 99, type: "SUPPORT", strength: 90, touches: 3 } };
  const mkt = { market_open: true, vix: 15, vix_regime: "CALM", market: "BULLISH", spy_day_change_pct: 0.5 };
  const r = tesseract.evaluate("AAPL", zones, mkt, [], "2026-07-03T00:00:00.000Z");
  assert.ok(r.cube && typeof r.confidence === "number");
  assert.ok(["buy", "watch", "hold", "skip"].includes(r.action));
});

// ── convergence-ev ───────────────────────────────────────────────────────────
test("convergence-ev.scoreConvergence: strong evidence → ENTER", () => {
  // Raw Riley signal fields (the shape scan.js will pass in Phase 3).
  const strong = {
    direction: "BULLISH", grok_conf: 85, claude_conf: 80,
    in_zone: true, zone_strength: 80, zone_touches: 3,
    structure_shifted: true, structure_conf: 75, pattern_grade: "A",
    trend_aligned: true, news_sentiment: 0.6, backtest_winrate: 0.55, target_r: 3.0,
  };
  const r = ev.scoreConvergence(strong);
  assert.strictEqual(r.decision, "ENTER");
  assert.ok(r.p_win >= ev.P_MIN && r.ev_r >= ev.EV_MIN, JSON.stringify(r));
});

test("convergence-ev.edgeRiskMultiplier: bounded [0.5,1.5]", () => {
  assert.strictEqual(ev.edgeRiskMultiplier(0.5), 1.0);
  assert.ok(ev.edgeRiskMultiplier(0.99) <= 1.5);
  assert.ok(ev.edgeRiskMultiplier(0.01) >= 0.5);
});

// ── scan composite (deriveDirection + rileyGate) ─────────────────────────────
test("deriveDirection: at support → BULLISH, at resistance → BEARISH", () => {
  const t = { oversold: 35, overbought: 65 };
  assert.strictEqual(deriveDirection({ in_zone: true, zone_type: "SUPPORT" }, 50, t), "BULLISH");
  assert.strictEqual(deriveDirection({ in_zone: true, zone_type: "RESISTANCE" }, 50, t), "BEARISH");
});

test("rileyGate: far from any zone → NO / not actionable", () => {
  const g = rileyGate({
    sr: { in_zone: false, dist_to_nearest: 9, zone_strength: 0, nearest_zone: null, zone_type: "NONE", touches: 0 },
    rsiVal: 50, thresholds: { oversold: 35, overbought: 65 },
    struct: { strength: 0, structureShifted: false, exhaustive: false, shift: "NEUTRAL" },
    candle: { pattern: null, confirms: false, strength: 0 },
    direction: "BULLISH", trending: false,
  });
  assert.strictEqual(g.quality, "NO");
  assert.strictEqual(g.actionable, false);
});

test("convergenceVerdict: strong bullish setup → ENTER with sized conviction", () => {
  const v = convergenceVerdict({
    t: "AAPL", direction: "BULLISH",
    sr: { in_zone: true, zone_strength: 90, touches: 3, nearest_zone: { touches: 3 } },
    struct: { structureShifted: true, strength: 80 },
    candle: { pattern: "DOUBLE_BOTTOM", confirms: true, strength: 85 },
    marketStatus: { market: "BULLISH" },
  });
  assert.ok(v && v.decision === "ENTER", JSON.stringify(v));
  assert.ok(v.size_mult >= 1.0 && v.size_mult <= 1.5, `size_mult ${v && v.size_mult}`);
});

test("convergenceVerdict: counter-trend, no evidence → SKIP", () => {
  const v = convergenceVerdict({
    t: "AAPL", direction: "BULLISH",
    sr: { in_zone: false, zone_strength: 0, touches: 0, nearest_zone: null },
    struct: { structureShifted: false, strength: 0 },
    candle: { pattern: null, confirms: false, strength: 0 },
    marketStatus: { market: "BEARISH" }, // BULLISH signal into a BEARISH tape → trend conflict
  });
  assert.ok(v && v.decision === "SKIP", JSON.stringify(v));
});

test("rileyGate: strong in-zone + structure shift → high-confidence actionable", () => {
  const g = rileyGate({
    sr: { in_zone: true, dist_to_nearest: 0, zone_strength: 100, zone_type: "SUPPORT", touches: 3, nearest_zone: { recency: "today", touches: 3 } },
    rsiVal: 32, thresholds: { oversold: 35, overbought: 65 },
    struct: { strength: 90, structureShifted: true, exhaustive: false, shiftType: "BULLISH_SWING_BREAK" },
    candle: { pattern: "DOUBLE_BOTTOM", confirms: true, strength: 80 },
    direction: "BULLISH", trending: false,
  });
  assert.ok(g.actionable, JSON.stringify(g));
  assert.ok(g.confidence >= 70, `confidence ${g.confidence}`);
  assert.strictEqual(g.quality, "PERFECT");
});
