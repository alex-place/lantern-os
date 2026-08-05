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
const { rsi, adaptiveRsiThresholds, macd, priceVsSma, volumeRatio, atr } = require("./indicators");
const sectors = require("./sectors");
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
// TREND OVERRIDE (opt-in, ZONE_TREND_DIR=1 / opts.trendDir).
//
// The zone rules below are pure MEAN-REVERSION: nearest zone is resistance ->
// BEARISH. In an UPTREND price sits near its highs by definition, so the nearest
// zone is essentially always resistance and the read is permanently BEARISH —
// on exactly the instruments that are going up. Measured 2026-08-05: GLD read
// BEARISH on all 49 intraday bars while climbing +2.0%, and a 2,338-sample
// forward-return test found BULLISH reads followed by -0.003% vs BEARISH by
// +0.009%/+0.029% — i.e. the primitive was mildly INVERTED, not merely noisy.
//
// This does not delete the mean-reversion read; it declines to call a rising
// market bearish purely because there is overhead resistance. In a confirmed
// uptrend, resistance above is a TARGET, not a short signal.
function _isUptrend(closes) {
  if (!Array.isArray(closes) || closes.length < 50) return false;
  const sma = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const px = closes[closes.length - 1];
  const s20 = sma(20), s50 = sma(50);
  return px > s20 && s20 > s50;          // price above a rising short MA stack
}

function deriveDirection(sr, rsiVal, thresholds, opts = {}) {
  const trendDir = opts.trendDir ?? (process.env.ZONE_TREND_DIR === "1");
  const up = trendDir && _isUptrend(opts.closes);
  if (sr.in_zone) {
    if (sr.zone_type === "SUPPORT") return "BULLISH";
    // In an uptrend, trading INSIDE a resistance zone is the breakout, not the
    // rejection — the zone is being consumed. Overbought still vetoes the chase.
    if (sr.zone_type === "RESISTANCE") return up && rsiVal < thresholds.overbought ? "BULLISH" : "BEARISH";
  }
  const nz = sr.nearest_zone || {};
  if (nz.type === "SUPPORT") return "BULLISH";
  if (nz.type === "RESISTANCE") return up && rsiVal < thresholds.overbought ? "BULLISH" : "BEARISH";
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
function convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment = 0, volume_ratio, macd_hist, ma_signal, earnings_surprise, sector_trend }) {
  const evInput = {
    direction,
    news_sentiment,
    volume_ratio,          // Tier-1: volume-spike confirmation
    macd_hist,             // Tier-1: MACD histogram (momentum)
    ma_signal,             // Tier-1: price vs MA (momentum)
    earnings_surprise,     // Tier-2: last EPS surprise vs consensus (signed %)
    sector_trend,          // Tier-2: sector ETF trend (signed fraction)
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

  // Tier-2 sector strength: fetch each needed sector ETF's daily bars ONCE and
  // compute its trend, then look up per ticker (many tickers share a sector).
  const sectorMom = {}; // etf -> signed momentum fraction
  try {
    const etfs = sectors.etfsFor(list);
    if (etfs.length) {
      const etfBars = ((await yahoo.getBarsMulti(etfs, "1d").catch(() => ({ bars: {} }))).bars) || {};
      for (const e of etfs) sectorMom[e] = sectors.sectorMomentum((etfBars[e] && etfBars[e].bars) || []);
    }
  } catch (_e) { /* fail-soft: sector signal stays neutral */ }

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
    const _closes15 = b15.map((b) => b.close);
    const rsiVal = rsi(_closes15) ?? 50;
    // closes feed the ZONE_TREND_DIR override — without them the trend can't be
    // judged and deriveDirection silently falls back to pure mean-reversion.
    const direction = deriveDirection(sr, rsiVal, thresholds, { closes: _closes15 });
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

      // Tier-1 confirmation inputs from the 15m bars: volume spike, MACD histogram,
      // price-vs-MA. Each feeds the EV model as a weighted signal.
      const closes15 = b15.map((b) => b.close);
      const volume_ratio = volumeRatio(b15);
      const m = macd(closes15);
      const macd_hist = m ? m.histogram : 0;
      const ma_signal = priceVsSma(closes15, 20);
      // Tier-2: last reported EPS surprise vs consensus (keyless Yahoo; cached 6h).
      let earn = null;
      try { earn = await yahoo.getEarningsSurprise(t); } catch (_e) { /* fail-soft */ }
      const earnings_surprise = earn ? earn.surprisePct : null;
      const secEtf = sectors.sectorFor(t);
      const sector_trend = secEtf && sectorMom[secEtf] != null ? sectorMom[secEtf] : null;
      const convergence = convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment, volume_ratio, macd_hist, ma_signal, earnings_surprise, sector_trend });

      // ── Trend/regime filter (TRADER_REGIME_FILTER, on by default) ──────────────
      // The engine buys oversold DIPS; in a downtrend that's catching a falling knife —
      // walk-forward backtests showed this is where the edge is destroyed (single-stock
      // longs 26% win / PF 0.65). Only take a BULLISH entry when the name is trend-aligned:
      // price above its SMA-50 (on the 15m scan bars) AND MACD histogram positive. Same
      // gate the backtest used to flip the book from negative to positive expectancy.
      // Fail-open on insufficient history (SMA-50 unknown → don't block on price alone).
      if (process.env.TRADER_REGIME_FILTER !== '0' && direction === 'BULLISH' && convergence && convergence.decision === 'ENTER') {
        const sma50 = closes15.length >= 50 ? closes15.slice(-50).reduce((s, x) => s + x, 0) / 50 : null;
        const trendOk = (sma50 == null || price > sma50) && macd_hist > 0;
        if (!trendOk) { convergence.decision = 'SKIP'; convergence.skip_reason = 'regime_filter: not trend-aligned (need price>SMA50 & MACD hist>0)'; }
      }

      // Trade plan (framework Step 6): ATR-based risk unit, R-multiple targets, and
      // an ATR-scaled holding-horizon estimate. Levels prefer real S/R when close.
      const a = atr(b15);
      const r2 = (x) => Math.round(x * 100) / 100;
      const dirUp = direction === "BULLISH";
      const risk = Math.max((a || 0) * 2, price * 0.015);
      let stopPx = dirUp ? price - risk : price + risk;
      // Prefer a real S/R level for the stop ONLY when it's a sensible distance
      // (≥0.5% so the risk isn't near-zero, <6% so it isn't absurdly wide).
      const near = (lvl) => Math.abs(price - lvl) / price;
      if (dirUp && sr.support > 0 && sr.support < price && near(sr.support) >= 0.005 && near(sr.support) < 0.06) stopPx = sr.support;
      if (!dirUp && sr.resistance > price && near(sr.resistance) >= 0.005 && near(sr.resistance) < 0.06) stopPx = sr.resistance;
      const riskAbs = Math.max(Math.abs(price - stopPx), price * 0.008); // floor risk at 0.8%
      const tr = (convergence && convergence.target_r) || 2;
      const dailyMove = (a || price * 0.005) * 5.1; // 15m ATR → ~daily (√26)
      const holdDays = Math.max(1, Math.min(15, Math.round((tr * riskAbs) / dailyMove)));

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
        earnings: earn ? { surprise_pct: earn.surprisePct, quarter: earn.quarter } : null, // Tier-2
        sector: secEtf ? { etf: secEtf, trend_pct: sector_trend != null ? r2(sector_trend * 100) : null } : null, // Tier-2
        volume_ratio: r2(volume_ratio),
        atr: r2(a || price * 0.005),   // 15m ATR — the support-entry gate measures zone distance in this unit
        plan: { stop: r2(stopPx), target1: r2(dirUp ? price + tr * riskAbs : price - tr * riskAbs), target2: r2(dirUp ? price + tr * 1.7 * riskAbs : price - tr * 1.7 * riskAbs), hold_days: holdDays },
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
