/**
 * trading-guard.js — the hard safety gate in front of every real broker order.
 *
 * Default posture is DRY: no real order is EVER placed unless every gate below
 * is explicitly cleared. This is the Act-stage guard for the Node trader that
 * replaced the Python/Alpaca path (ADR-0020). It shares the Kalshi trader's
 * global kill-switch so one file halts ALL live trading (stocks + markets).
 *
 * Gates (ALL must pass to place a real order):
 *   1. No global halt file: data/kalshi/LIVE-KILL-SWITCH or data/kalshi/TRADING-PAUSED.
 *   2. TRADER_LIVE=1              — master arm switch (default unset/0 = dry run).
 *   3. notional ≤ the per-position cap (TRADER_MAX_POSITION_PCT of equity, default
 *      14%; falls back to the flat MAX_ORDER_NOTIONAL, $2000, when equity is unknown)
 *      and qty ≤ MAX_ORDER_QTY — a share-count SANITY ceiling (default 100000), not
 *      the real limit. Notional governs; a fractional-share book legitimately places
 *      four-figure share counts on cheap names.
 *   4. Account mode is 'paper', OR mode 'live' AND TRADER_ALLOW_LIVE_ACCOUNT=1
 *      — placing real-money orders on a LIVE account needs a second opt-in.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Same directory + files the Kalshi trader uses, so the kill-switch is shared.
const KALSHI_DIR = path.resolve(__dirname, "..", "..", "..", "data", "kalshi");
const KILL_SWITCH = path.join(KALSHI_DIR, "LIVE-KILL-SWITCH");
const TRADING_PAUSED = path.join(KALSHI_DIR, "TRADING-PAUSED");

function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : dflt;
}

// Which global halt file (if any) is engaged. Fail-safe: a stat error is treated
// as "not halted" only for the specific file — never swallows into "armed".
function haltFile() {
  try { if (fs.existsSync(KILL_SWITCH)) return "LIVE-KILL-SWITCH"; } catch (_e) {}
  try { if (fs.existsSync(TRADING_PAUSED)) return "TRADING-PAUSED"; } catch (_e) {}
  return null;
}

/**
 * Decide whether a real broker order may go through.
 * @param {{mode?:string, qty?:number, price?:number, symbol?:string, side?:string}} o
 *   mode = account mode from IbkrCpapi.inferMode ('paper'|'live'|'unknown').
 * @returns {{allowed:boolean, dry:boolean, reason:string, mode:string, caps:object}}
 */
function orderGate({ mode = "unknown", qty, price, equity } = {}) {
  const maxQty = envInt("MAX_ORDER_QTY", 100000); // share-count sanity ceiling; notional governs
  // Per-position notional cap SCALES WITH THE PORTFOLIO: TRADER_MAX_POSITION_PCT of
  // equity (default 14% → $140k on $1M; must MATCH auto-trader.js maxPositionPct or
  // the guard denies what the sizer produces). Falls back to the flat
  // MAX_ORDER_NOTIONAL only when equity is unknown, so we never place a huge order
  // while blind.
  const maxPositionPct = Number(process.env.TRADER_MAX_POSITION_PCT) || 14;
  const eq = Number(equity) || 0;
  const flatNotional = envInt("MAX_ORDER_NOTIONAL", 2000);
  const maxNotional = eq > 0 ? eq * (maxPositionPct / 100) : flatNotional;
  const caps = { maxQty, maxNotional: Math.round(maxNotional), maxPositionPct, equity: eq || null };
  const q = Number(qty) || 0;
  const px = Number(price) || 0;
  const notional = q * px;
  const deny = (reason) => ({ allowed: false, dry: true, reason, mode, caps });

  const halt = haltFile();
  if (halt) return deny(`global halt engaged (data/kalshi/${halt}) — all live trading stopped`);
  if (!q || q <= 0) return deny("qty must be > 0");
  if (q > maxQty) return deny(`qty ${q} exceeds MAX_ORDER_QTY ${maxQty}`);
  if (px > 0 && notional > maxNotional) return deny(`notional $${notional.toFixed(0)} exceeds cap $${Math.round(maxNotional)} (${eq > 0 ? maxPositionPct + "% of equity" : "flat MAX_ORDER_NOTIONAL — equity unknown"})`);
  if (process.env.TRADER_LIVE !== "1") return deny("TRADER_LIVE=0 — dry run (no real order placed); set TRADER_LIVE=1 to arm");
  if (mode === "unknown") return deny("account mode unknown — refusing to place a real order");
  if (mode === "live" && process.env.TRADER_ALLOW_LIVE_ACCOUNT !== "1") {
    return deny("LIVE (real-money) account — set TRADER_ALLOW_LIVE_ACCOUNT=1 to permit real-money orders");
  }
  return { allowed: true, dry: false, reason: `armed on ${mode} account`, mode, caps };
}

module.exports = { orderGate, haltFile, KILL_SWITCH, TRADING_PAUSED };

if (require.main === module) {
  // Default posture must be dry with no env set.
  console.log("no env      :", orderGate({ mode: "paper", qty: 1, price: 100 }));
  process.env.TRADER_LIVE = "1";
  console.log("armed paper :", orderGate({ mode: "paper", qty: 1, price: 100 }));
  console.log("live acct   :", orderGate({ mode: "live", qty: 1, price: 100 }));
  console.log("over qty    :", orderGate({ mode: "paper", qty: 9999, price: 100 }));
  console.log("over notion :", orderGate({ mode: "paper", qty: 50, price: 100 }));
}
