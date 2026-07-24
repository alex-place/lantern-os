/**
 * signal-engine/profiles.js — per-asset risk profiles.
 * Ported from src/trading_agents/agents.py (ASSET_PROFILES / DEFAULT_PROFILE):
 * style, stop%, take-profit%, min/max size %, confidence threshold, beta.
 * Used to derive the EV gate's reward/risk multiple (target_r = tp / |stop|).
 */
"use strict";

const ASSET_PROFILES = {
  AAPL: { style: "trading", stop: -2.5, tp: 5.0, min: 2.0, max: 5.0, conf: 30, beta: 1.20 },
  AMZN: { style: "trading", stop: -2.5, tp: 5.0, min: 2.0, max: 5.0, conf: 30, beta: 1.15 },
  SPY:  { style: "trading", stop: -1.5, tp: 3.0, min: 2.0, max: 5.0, conf: 30, beta: 1.00 },
  NVDA: { style: "trading", stop: -4.0, tp: 10.0, min: 1.5, max: 4.0, conf: 30, beta: 1.75 },
  INTC: { style: "trading", stop: -3.0, tp: 6.0, min: 1.5, max: 4.0, conf: 30, beta: 0.90 },
  AMD:  { style: "trading", stop: -4.0, tp: 9.0, min: 1.5, max: 4.0, conf: 30, beta: 1.65 },
  TSLA: { style: "trading", stop: -5.0, tp: 12.0, min: 1.0, max: 3.0, conf: 45, beta: 2.00 },
  SHOP: { style: "trading", stop: -5.0, tp: 10.0, min: 1.0, max: 3.0, conf: 45, beta: 1.55 },
  ASML: { style: "trading", stop: -2.5, tp: 6.0, min: 1.0, max: 3.0, conf: 45, beta: 1.45 },
  META: { style: "trading", stop: -2.5, tp: 6.0, min: 1.5, max: 4.0, conf: 45, beta: 1.35 },
  BTCUSD: { style: "trading", stop: -6.0, tp: 15.0, min: 1.0, max: 3.0, conf: 30, beta: 3.00 },
  ETHUSD: { style: "trading", stop: -7.0, tp: 18.0, min: 1.0, max: 3.0, conf: 30, beta: 3.50 },
  SOLUSD: { style: "trading", stop: -8.0, tp: 20.0, min: 1.0, max: 2.5, conf: 30, beta: 4.00 },
  MSFT: { style: "trading", stop: -2.0, tp: 4.0, min: 0.5, max: 8.0, conf: 45, beta: 0.90 },
  JPM:  { style: "trading", stop: -2.0, tp: 4.0, min: 0.5, max: 8.0, conf: 45, beta: 1.10 },
  GLD:  { style: "trading", stop: -1.5, tp: 3.0, min: 0.5, max: 8.0, conf: 45, beta: 0.10 },
};

const DEFAULT_PROFILE = { style: "trading", stop: -4.0, tp: 8.0, min: 1.0, max: 3.0, conf: 60, beta: 1.20 };

function getProfile(ticker) {
  return ASSET_PROFILES[String(ticker || "").toUpperCase()] || DEFAULT_PROFILE;
}

// Reward/risk multiple (tp% / |stop%|) — the EV gate's target_r.
function targetR(ticker) {
  const p = getProfile(ticker);
  const s = Math.abs(p.stop) || 1;
  return Math.round((p.tp / s) * 100) / 100;
}

module.exports = { ASSET_PROFILES, DEFAULT_PROFILE, getProfile, targetR };
