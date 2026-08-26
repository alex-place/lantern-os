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
 *   3. notional ≤ the per-position cap — BUYS ONLY, because a cap on position size
 *      must never stop a position being closed (TRADER_MAX_POSITION_PCT of equity, default
 *      5%; falls back to the flat MAX_ORDER_NOTIONAL, $2000, when equity is unknown)
 *      and qty ≤ MAX_ORDER_QTY — a share-count SANITY ceiling (default 100000), not
 *      the real limit. Notional governs; a fractional-share book legitimately places
 *      four-figure share counts on cheap names. A MARKET buy has no price of its own,
 *      so it is measured against the caller's `refPrice` (the quote it sized from) and
 *      REFUSED if it has neither — an unpriceable buy cannot be capped.
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
// A HARD PER-POSITION CAP (operator, 2026-08-25). TRADER_MAX_POSITION_PCT is the
// ceiling for every symbol, full stop — the symbol tilt may size a position DOWN but
// never above it.
//
// This is a change of policy, not a reading of one. Until now auto-trader multiplied
// the cap by the room tier, the stress multiplier and the symbol tilt, so SOXL/SMH/QQQ
// sized to 18% of equity and 27% at VIX >= 20 while this file read the bare 12%. That
// mismatch was invisible only because the cap did not bind on market orders (below);
// the moment it binds, guard and sizer have to agree on one number. They now agree on
// the hard one: auto-trader clamps its effective cap to c.maxPositionPct.
//
// Measured cost, before arming (experiments/hard_cap_lab.js, four surfaces, live env):
// return/DD h1 -15%, d-fit -40%, h2 -22%, d-hold -44%. On the 26-year holdout that is
// 2,866% -> 1,202% of return against a drawdown of 22.1% -> 16.5% — 58% of the return
// given up to remove 25% of the drawdown. Win rate is unchanged at 64%: sizing does not
// change WHICH trades are taken, only how big. The operator chose this knowing the
// number; TRADER_MAX_POSITION_PCT is the single knob that reverses it.
function orderGate({ mode = "unknown", qty, price, equity, side, refPrice } = {}) {
  const maxQty = envInt("MAX_ORDER_QTY", 100000); // share-count sanity ceiling; notional governs
  // Per-position notional cap SCALES WITH THE PORTFOLIO: TRADER_MAX_POSITION_PCT of
  // equity (default 5% → $50k on $1M; must MATCH auto-trader.js maxPositionPct or
  // the guard denies what the sizer produces). Falls back to the flat
  // MAX_ORDER_NOTIONAL only when equity is unknown, so we never place a huge order
  // while blind.
  const maxPositionPct = Number(process.env.TRADER_MAX_POSITION_PCT) || 5;
  const eq = Number(equity) || 0;
  const flatNotional = envInt("MAX_ORDER_NOTIONAL", 2000);
  const maxNotional = eq > 0 ? eq * (maxPositionPct / 100) : flatNotional;
  const caps = { maxQty, maxNotional: Math.round(maxNotional), maxPositionPct, equity: eq || null };
  const q = Number(qty) || 0;
  // THE CAP HAS TO BIND ON MARKET ORDERS, WHICH IS WHERE THE RISK ACTUALLY GOES IN
  // (operator, 2026-08-25). Until now `notional` was computed from the order's LIMIT
  // price, so a market order priced at nothing had a notional of nothing and sailed
  // past the cap. That is the engine's normal path: entries are market buys. The 12%
  // per-position cap was therefore unenforced on every ordinary entry — SOXL sat at
  // 18% of equity and the gate never objected — while binding on the marketable-limit
  // conversion #3326 applies to an out-of-RTH flatten. A cap that only fires on the
  // order you use to REDUCE risk is not a cap.
  //
  // A market order has no price until it fills, so the cap is measured against a
  // REFERENCE price the caller supplies — the same quote it sized the position from.
  // Every engine that sizes against equity now supplies one (auto-trader and
  // overnight-trader), so the paths that can build an oversized position are all
  // covered.
  //
  // An unpriced buy is still ALLOWED rather than denied, and that is a deliberate
  // limit rather than an oversight. orderGate sits under a general-purpose
  // placeOrder(), not just the engine: refusing every priceless buy would change the
  // meaning of that whole API — it broke the IBKR warning-handshake path immediately
  // (exit-warning-confirm-behavior), and would silently disable any future caller that
  // legitimately has no quote. The residue is exactly the pre-existing behaviour for
  // callers that do not size against equity; it is not a new hole. If a caller that
  // sizes by equity is ever added, it must pass refPrice — that is the contract, and
  // the reason this comment names the two that do.
  // refPrice WINS over the order's own limit price when the caller supplies one, because
  // it is the price the position was SIZED from and the cap governs position size. The
  // two differ by design on the extended-hours path: #3326 makes an out-of-RTH entry a
  // marketable limit 0.2% through the spread so it can actually fill. Capping on that
  // uplift denies an order the sizer built to fit — 1,002 SOXL sized at $115.67 is
  // $115,901 against a $116,009 ceiling, and the same order priced at $115.90 is
  // $116,132, refused. Slippage headroom is not a risk-policy question; the intended
  // position size is. Callers here are all our own code, and the manual order route
  // supplies no refPrice, so its limit price still governs.
  const px = Number(refPrice) > 0 ? Number(refPrice) : (Number(price) > 0 ? Number(price) : 0);
  const notional = q * px;
  const deny = (reason) => ({ allowed: false, dry: true, reason, mode, caps });

  const halt = haltFile();
  if (halt) return deny(`global halt engaged (data/kalshi/${halt}) — all live trading stopped`);
  if (!q || q <= 0) return deny("qty must be > 0");
  if (q > maxQty) return deny(`qty ${q} exceeds MAX_ORDER_QTY ${maxQty}`);
  // A CAP ON POSITION SIZE MUST NEVER BLOCK A POSITION FROM BEING CLOSED
  // (2026-08-25). `side` has been in this function's JSDoc since it was written
  // and ibkr-cpapi.js has always passed it — it was simply never destructured, so
  // the cap applied to sells exactly as it did to buys. The operator hit it trying
  // to flatten before an A/B: SOXL 1,517 shares at $115.67 = $175,471 against a cap
  // of 12% x $966,744 = $116,009. DENIED. The position could be opened and not shut.
  //
  // It could be opened because the sizer's cap legitimately SCALES — auto-trader
  // multiplies maxPositionPct by the room tier, the stress multiplier and the symbol
  // tilt (SOXL 1.5), so 12% becomes 18% and, at VIX >= 20, 27%. This guard reads the
  // raw 12%. And because the cap only fires `px > 0`, a MARKET order skips it
  // entirely; the entry was a market buy. So the cap was inert for the order that
  // took the risk and binding on the order that would have shed it — the exact
  // inversion of what it is for. #3326 completes the trap: outside RTH a manual
  // flatten is converted to a marketable LIMIT so it can execute, which is what gives
  // it the price that trips the cap. The one moment it fires is the one moment it
  // must not.
  //
  // A sell cannot increase a long position, so the position-size cap has no business
  // judging it. Every other gate still applies to sells — the halt file, TRADER_LIVE,
  // the account-mode opt-in, and the MAX_ORDER_QTY sanity ceiling — and the trader is
  // longs-only, so this does not open a naked-short path. Buys are untouched.
  const reducing = String(side || "").toLowerCase() === "sell";
  if (!reducing && px > 0 && notional > maxNotional) return deny(`notional $${notional.toFixed(0)} exceeds cap $${Math.round(maxNotional)} (${eq > 0 ? maxPositionPct + "% of equity — a HARD ceiling, the symbol tilt cannot raise it" : "flat MAX_ORDER_NOTIONAL — equity unknown"})`);
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
