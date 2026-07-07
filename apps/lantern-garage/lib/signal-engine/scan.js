/**
 * signal-engine/scan.js — deterministic market scan (Node port of the "Riley"
 * technical path from src/trading_agents/agents.py).
 *
 * This replaces the Python `scan_all`/`scan_ticker` for the trader UI. It uses
 * ONLY deterministic technical analysis (SR zones, RSI, candle patterns, market
 * structure, tesseract) fed by keyless Yahoo bars — no Grok/Claude LLM calls.
 * Autonomous buy/sell *decisioning* is layered on top by the Σ₀ convergence
 * council (see lib/sigma0-trader-council.js), per ADR — this module just Observes.
 *
 * Output contract matches what cli.py's action_scan_market returned, so
 * /api/trading/zones and stock-trader.html keep working unchanged:
 *   { signals:[...], zones:{TICKER:{mid,top,bottom,type,strength,touches,triggered_entry}},
 *     logs:[{time,agent,body,symbol}], timestamp, watchlist_count, signals_count }
 */
"use strict";

const yahoo = require("../market-data-yahoo");
const { rsi, adaptiveRsiThresholds } = require("./indicators");
const { findSrZones } = require("./sr-zones");
const { detectCandlePatterns } = require("./candles");
const { checkMarketStructureShift } = require("./market-structure");
const tesseract = require("./tesseract");
const ev = require("./convergence-ev");
const { targetR } = require("./profiles");
const tradingNews = require("../trading-news"); // directional news sentiment (external anchor)

// Derive a candidate trade direction from zone posture, falling back to RSI
// mean-reversion. (In the Python flow Grok proposed the direction; here it's
// deterministic: support → look long, resistance → look short.)
function deriveDirection(sr, rsiVal, thresholds) {
  if (sr.in_zone) {
    if (sr.zone_type === "SUPPORT") return "BULLISH";
    if (sr.zone_type === "RESISTANCE") return "BEARISH";
  }
  const nz = sr.nearest_zone || {};
  if (nz.type === "SUPPORT") return "BULLISH";
  if (nz.type === "RESISTANCE") return "BEARISH";
  if (rsiVal <= thresholds.oversold) return "BULLISH";
  if (rsiVal >= thresholds.overbought) return "BEARISH";
  return "NEUTRAL";
}

// Deterministic composite gate — ported from agents.py `riley_strategy_gate`
// (proximity gate → context-aware RSI adjustment → structure/candle/touch
// boosts → total_score → PERFECT/GOOD/WAIT/NO). Returns a 0..100 confidence.
function rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending }) {
  const reasons = [];
  let boost = 0;

  const nearest = sr.nearest_zone || {};
  const tier = nearest.recency || "older";
  let proximityLimit =
    { today: 3.0, weekly: 3.0, recent: 2.0, older: 1.5, structural: 2.5 }[tier] || 2.0;
  if ((sr.zone_strength || 0) >= 70) proximityLimit += 0.5;

  if (!sr.in_zone && (sr.dist_to_nearest ?? 99) > proximityLimit) {
    return {
      approved: false,
      quality: "NO",
      confidence: 0,
      boost: 0,
      reason: `not near a zone (nearest ${Number(sr.dist_to_nearest || 0).toFixed(1)}% > ${proximityLimit.toFixed(1)}%)`,
      actionable: false,
    };
  }

  // Context-aware RSI adjustment (weights differ trending vs ranging).
  const wConfirm = trending ? 5 : 15;
  const wNeutral = trending ? 0 : -5;
  const wOppose = trending ? -5 : -20;
  let rsiAdj = 0;
  const r = Math.round(rsiVal);
  if (sr.in_zone && direction === "BEARISH" && sr.zone_type === "SUPPORT") {
    if (rsiVal >= thresholds.overbought) { rsiAdj = wConfirm; reasons.push(`RSI ${r} overbought@support — short confirm`); }
    else if (rsiVal < 40) { rsiAdj = -20; reasons.push(`RSI ${r} oversold@support — risky short`); }
    else { rsiAdj = wNeutral; reasons.push(`RSI ${r}@support`); }
    if (rsiVal > 80) rsiAdj += 10;
  } else if (sr.in_zone && direction === "BULLISH" && sr.zone_type === "RESISTANCE") {
    if (rsiVal <= thresholds.oversold) { rsiAdj = wConfirm; reasons.push(`RSI ${r} oversold@resistance — long confirm`); }
    else if (rsiVal >= thresholds.overbought) { rsiAdj = wOppose; reasons.push(`RSI ${r} overbought@resistance — risky long`); }
    else { rsiAdj = wNeutral; reasons.push(`RSI ${r}@resistance`); }
    if (rsiVal < 20) rsiAdj += 10;
  }
  boost += rsiAdj;

  // Structure confidence base, boosted by a confirming candle (str≥65 → +30%).
  let structConf = struct.strength || 0;
  if (candle.pattern && candle.confirms && candle.strength >= 65) {
    structConf = Math.min(100, structConf + Math.trunc(candle.strength * 0.3));
  }

  if (sr.in_zone) { boost += 8; reasons.push(`in ${sr.zone_type} zone (str ${sr.zone_strength})`); }
  const touches = nearest.touches || sr.touches || 0;
  if (touches >= 3) { boost += 5; reasons.push(`${touches} touches`); }
  else if (touches >= 2) { boost += 3; reasons.push("2 touches"); }
  if (struct.structureShifted) { boost += 15; reasons.push(`structure shift (${struct.shiftType})`); }
  if (struct.exhaustive) { boost += 5; reasons.push("exhaustive move"); }
  if (candle.pattern && candle.confirms) { boost += 4; reasons.push(`entry candle (${candle.pattern})`); }

  const totalScore = structConf + (sr.zone_strength || 0) / 2;
  let quality = "NO";
  let approved = false;
  if (totalScore >= 80 && sr.in_zone) { quality = "PERFECT"; approved = true; }
  else if (totalScore >= 55 && (sr.in_zone || (sr.dist_to_nearest ?? 99) < 1.0)) { quality = "GOOD"; approved = true; }
  else if (totalScore >= 35) { quality = "WAIT"; }

  const confidence = Math.max(0, Math.min(100, Math.round(totalScore + boost)));
  return {
    approved,
    quality,
    confidence,
    boost,
    reason: reasons.join(" | ") || "no valid setup",
    actionable: quality !== "NO" && direction !== "NEUTRAL",
  };
}

// Map a confirming candle's strength to an A/B/C grade for the EV layer.
function candleGrade(candle) {
  if (!candle || !candle.pattern || !candle.confirms) return "C";
  if (candle.strength >= 85) return "A";
  if (candle.strength >= 70) return "B";
  return "C";
}

// Σ₀ EV verdict for a signal — the deterministic ENTER/SKIP + Kelly-style sizing
// that replaced the Python Grok/Claude entry loop. Pure over the computed TA plus
// (optionally) real news sentiment; the grok/claude council inputs stay neutral.
// `news_sentiment` ∈ [-1,1] is an EXTERNAL anchor (Σ₀): the EV layer signs it to
// the direction and weights it lightly (WEIGHTS.news), so one headline can nudge
// but never dominate the TA evidence.
function convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment = 0 }) {
  const evInput = {
    direction,
    news_sentiment,
    in_zone: sr.in_zone,
    zone_strength: sr.zone_strength,
    zone_touches: (sr.nearest_zone && sr.nearest_zone.touches) || sr.touches || 0,
    structure_shifted: struct.structureShifted,
    structure_conf: struct.strength,
    pattern_grade: candleGrade(candle),
    trend_aligned:
      (direction === "BULLISH" && marketStatus.market === "BULLISH") ||
      (direction === "BEARISH" && marketStatus.market === "BEARISH"),
    trend_conflicts:
      (direction === "BULLISH" && marketStatus.market === "BEARISH") ||
      (direction === "BEARISH" && marketStatus.market === "BULLISH"),
    target_r: targetR(t),
  };
  try {
    const c = ev.scoreConvergence(evInput);
    return {
      decision: c.decision,
      p_win: c.p_win,
      ev_r: c.ev_r,
      target_r: c.target_r,
      size_mult: ev.edgeRiskMultiplier(c.p_win, c.target_r),
    };
  } catch (_e) {
    return null;
  }
}

// Per-ticker zones (for /api/trading/zones single-ticker style reads).
async function getZones(ticker) {
  const q = (await yahoo.getQuotes([ticker]))[0] || { price: 0 };
  const b = (await yahoo.getBars(ticker, "15m")).bars || [];
  const sr = findSrZones(ticker, q.price, b);
  return {
    ticker,
    support: sr.support,
    resistance: sr.resistance,
    mid: sr.mid,
    type: sr.type,
    strength: sr.strength,
    touches: sr.touches,
    trend: sr.trend,
    volatility: sr.volatility,
    zones: sr.zones,
    available: b.length >= 10,
  };
}

// Full watchlist scan → { signals, zones, logs, ... } (the scanMarket contract).
async function scanAll(watchlist) {
  const list = Array.isArray(watchlist) ? watchlist : [];
  const nowIso = new Date().toISOString();

  const marketStatus = await yahoo.getMarketStatus().catch(() => ({}));
  const trending = marketStatus.market === "BULLISH" || marketStatus.market === "BEARISH";
  const quotes = await yahoo.getQuotes(list).catch(() => []);
  const priceOf = {};
  for (const q of quotes) priceOf[q.ticker] = q.price;
  const bars15 = ((await yahoo.getBarsMulti(list, "15m").catch(() => ({ bars: {} }))).bars) || {};
  const bars1h = ((await yahoo.getBarsMulti(list, "1h").catch(() => ({ bars: {} }))).bars) || {};

  const signals = [];
  const zones = {};
  const logs = [];

  for (const t of list) {
    const price = priceOf[t] || 0;
    const b15 = (bars15[t] && bars15[t].bars) || [];
    const b1h = (bars1h[t] && bars1h[t].bars) || [];
    if (!price || b15.length < 10) {
      logs.push({ time: nowIso, agent: "RILEY", symbol: t, body: `${t} — insufficient data (price ${price}, ${b15.length} bars)` });
      continue;
    }

    const sr = findSrZones(t, price, b15);
    const thresholds = adaptiveRsiThresholds(b1h.map((b) => b.close));
    const rsiVal = rsi(b15.map((b) => b.close)) ?? 50;
    const direction = deriveDirection(sr, rsiVal, thresholds);
    const struct = checkMarketStructureShift(b15, direction);
    const candle = detectCandlePatterns(b15, direction);
    const gate = rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending });

    // Tesseract cross-check (5-dimension eval) — advisory action alongside the gate.
    const zData = {
      [t]: { mid: sr.mid, top: sr.resistance, bottom: sr.support, type: sr.type, strength: sr.strength, touches: sr.touches, triggered_entry: gate.approved },
    };
    let tess = {};
    try { tess = tesseract.evaluate(t, zData, marketStatus, logs, nowIso) || {}; } catch (_e) { tess = {}; }

    zones[t] = { mid: sr.mid, top: sr.resistance, bottom: sr.support, type: sr.type, strength: sr.strength, touches: sr.touches, triggered_entry: gate.approved };

    if (gate.actionable) {
      // External anchor (Σ₀): directional news sentiment for this ticker, signed
      // into the EV verdict. Impact-weighted score in [-100,100] → [-1,1]. Only
      // computed for gate-passing tickers (cheap; a few per scan).
      let newsSent = { label: "neutral", impact_weighted_score: 0, n: 0 };
      try { newsSent = tradingNews.symbolSentiment(t, { windowHours: 48 }); } catch (_e) { /* fail-soft */ }
      const news_sentiment = (Number(newsSent.impact_weighted_score) || 0) / 100;
      const convergence = convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment });
      signals.push({
        symbol: t,
        direction,
        confidence: gate.confidence,
        entry_price: price,
        support: sr.support,
        resistance: sr.resistance,
        zone_mid: sr.mid,
        quality: gate.quality,
        rsi: Math.round(rsiVal),
        structure: struct.shift,
        candle: candle.pattern || null,
        tesseract: tess.action || null,
        convergence, // Σ₀ EV verdict: { decision:'ENTER'|'SKIP', p_win, ev_r, size_mult }
        news: { label: newsSent.label, score: newsSent.impact_weighted_score, n: newsSent.n }, // external anchor
        reasons: gate.reason,
      });
    }
    logs.push({ time: nowIso, agent: "RILEY", symbol: t, body: `${t} ${direction} ${gate.quality} conf=${gate.confidence} — ${gate.reason}` });
  }

  signals.sort((a, b) => b.confidence - a.confidence);
  return {
    signals,
    zones,
    logs,
    timestamp: nowIso,
    watchlist_count: list.length,
    signals_count: signals.length,
  };
}

module.exports = { scanAll, getZones, deriveDirection, rileyGate, candleGrade, convergenceVerdict };
