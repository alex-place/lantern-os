'use strict';

/**
 * auto-trader.js — autonomous stock EXECUTION over the Σ₀ scan (Act stage).
 *
 * The scan (signal-engine) produces ENTER/SKIP verdicts; this turns the ENTER
 * ones into real orders on the user's connected IBKR account. It is the missing
 * link that lets the AI trade on its own when the market opens.
 *
 * SAFETY (defense in depth — ALL must hold to place a real order):
 *   1. TRADER_AUTO_EXECUTE=1  — explicit opt-in, SEPARATE from manual TRADER_LIVE.
 *      Off by default: arming manual buy/sell must NOT silently arm the autopilot.
 *   2. Every order still passes the hard guard in trading-guard.js (TRADER_LIVE=1,
 *      caps, kill-switch, live-account double-opt-in) — auto-trade cannot bypass it.
 *   3. Position sizing is bounded by MAX_ORDER_NOTIONAL and TRADER_POSITION_PCT.
 *   4. One position per symbol (no pyramiding); a per-symbol cooldown stops churn.
 *   5. LONGS only by default (BULLISH→buy). A BEARISH signal only SELLS a long we
 *      already hold (a signal-based exit) — never opens a naked short unless
 *      TRADER_ALLOW_SHORTS=1.
 *
 * It is Σ₀-honest: every decision returns [action, evidence, confidence] and is
 * logged, and it never fabricates a fill — the broker result is passed through.
 */

const DEFAULTS = {
  positionPct: 0.2,        // % of equity per new position (before the notional cap)
  maxNewPerScan: 3,        // cap new entries opened in a single scan tick
  cooldownMs: 30 * 60000,  // don't re-order the same symbol within 30 min
  minPrice: 1,             // skip sub-$1 names
  stopPct: 2,              // protective stop % below entry (broker-side STP)
  maxDailyLossPct: 2,      // halt NEW entries once day P&L ≤ -this% of equity
};

function cfg() {
  const n = (name, d) => {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    positionPct: n('TRADER_POSITION_PCT', DEFAULTS.positionPct),
    maxNewPerScan: n('TRADER_MAX_NEW_PER_SCAN', DEFAULTS.maxNewPerScan),
    cooldownMs: n('TRADER_COOLDOWN_MS', DEFAULTS.cooldownMs),
    stopPct: n('TRADER_STOP_PCT', DEFAULTS.stopPct),                     // protective stop distance
    maxDailyLossPct: n('TRADER_MAX_DAILY_LOSS_PCT', DEFAULTS.maxDailyLossPct), // circuit breaker
    allowShorts: process.env.TRADER_ALLOW_SHORTS === '1',
    enabled: process.env.TRADER_AUTO_EXECUTE === '1',
  };
}

/** Protective stop trigger price for a long entry: `stopPct` below entry. */
function stopPriceFor(entry, stopPct) {
  const e = Number(entry);
  if (!(e > 0)) return null;
  return Math.round(e * (1 - Math.max(0.1, stopPct) / 100) * 100) / 100;
}

/**
 * Position size in whole shares. Pure + exported for tests.
 *   base notional = min(equity · positionPct%, maxNotional)   ← never exceeds the cap
 *   notional      = base · sizeMult (conviction, 0.5–1.5)
 *   qty           = clamp(floor(notional / price), 1, maxQty), then re-capped so
 *                   qty·price ≤ maxNotional.
 * Returns 0 when unpriced/negative — the caller then skips.
 */
function sizePosition({ equity, price, sizeMult = 1, positionPct = DEFAULTS.positionPct, maxNotional = 2000, maxQty = 100 }) {
  const px = Number(price);
  const eq = Number(equity);
  if (!(px > 0) || !(eq > 0)) return 0;
  const mult = Math.max(0.5, Math.min(1.5, Number(sizeMult) || 1));
  const base = Math.min(eq * (positionPct / 100), maxNotional);
  let qty = Math.floor((base * mult) / px);
  qty = Math.max(0, Math.min(qty, maxQty));
  while (qty > 0 && qty * px > maxNotional) qty -= 1; // respect notional cap exactly
  return qty;
}

// Per-symbol cooldown state (in-process; a restart clears it — safe, just re-checks).
const _lastOrderAt = new Map();

/**
 * Execute the ENTER verdicts from a scan against the user's IBKR account.
 * @param {object} scan   result of traderAgent.scanMarket() — { signals: [...] }
 * @param {object} deps   { bridge, userId, now?, caps? }
 * @returns {Promise<{executed:Array, skipped:Array, enabled:boolean, reason?:string}>}
 */
async function runAutoTrade(scan, { bridge, userId, now = Date.now(), caps = {} } = {}) {
  const c = cfg();
  const out = { executed: [], skipped: [], enabled: c.enabled };
  if (!c.enabled) { out.reason = 'TRADER_AUTO_EXECUTE!=1 — autopilot off'; return out; }
  if (!bridge || !userId) { out.reason = 'no bridge/userId'; return out; }

  const signals = (scan && Array.isArray(scan.signals)) ? scan.signals : [];
  const enters = signals.filter((s) => s && s.convergence && s.convergence.decision === 'ENTER');
  if (!enters.length) { out.reason = 'no ENTER signals'; return out; }

  // Broker truth: current account + open positions (never trade blind).
  const account = await bridge.getIBKRAccount(userId).catch(() => null);
  if (!account || !(account.equity > 0)) { out.reason = 'account/equity unavailable'; return out; }
  const positions = await bridge.getIBKRPositions(userId).catch(() => []);
  const heldQty = {};
  for (const p of (positions || [])) heldQty[String(p.symbol).toUpperCase()] = Number(p.qty) || 0;

  // Daily-loss circuit breaker: once the account's day P&L is at/below the limit,
  // stop opening NEW positions (exits still run — closing losers is allowed).
  const dailyLimit = account.equity * (c.maxDailyLossPct / 100);
  const dayPnl = await bridge.getIBKRDayPnl(userId).catch(() => null);
  const haltEntries = typeof dayPnl === 'number' && dayPnl <= -dailyLimit;
  if (haltEntries) out.circuit_breaker = { dayPnl, limit: -Math.round(dailyLimit) };

  const maxNotional = Number(caps.maxNotional) || parseFloat(process.env.MAX_ORDER_NOTIONAL) || 2000;
  const maxQty = Number(caps.maxQty) || parseFloat(process.env.MAX_ORDER_QTY) || 100;
  let opened = 0;

  for (const s of enters) {
    const sym = String(s.symbol).toUpperCase();
    const price = Number(s.entry_price) || 0;
    const held = heldQty[sym] || 0;
    const bullish = s.direction === 'BULLISH';
    const record = { symbol: sym, direction: s.direction, p_win: s.convergence.p_win, news: s.news || null };

    if (price < c.minPrice) { out.skipped.push({ ...record, why: 'price too low' }); continue; }

    // BEARISH + we hold a long → SELL to close (signal-based exit).
    if (!bullish && held > 0) {
      const r = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty: held, type: 'market' }).catch((e) => ({ status: 'error', reason: e.message }));
      out.executed.push({ ...record, action: 'exit_long', qty: held, result: r });
      _lastOrderAt.set(sym, now);
      continue;
    }
    // BEARISH + no long → skip unless shorts are explicitly allowed.
    if (!bullish && !(held < 0) && !c.allowShorts) { out.skipped.push({ ...record, why: 'bearish, no long to exit; shorts disabled' }); continue; }
    // Already hold this symbol on the signal's side → no pyramiding.
    if (bullish && held > 0) { out.skipped.push({ ...record, why: 'already long' }); continue; }
    // Daily-loss circuit breaker halts NEW entries (exits above already ran).
    if (haltEntries) { out.skipped.push({ ...record, why: `daily-loss limit hit (day P&L ${Math.round(dayPnl)})` }); continue; }
    // Cooldown.
    const last = _lastOrderAt.get(sym) || 0;
    if (now - last < c.cooldownMs) { out.skipped.push({ ...record, why: 'cooldown' }); continue; }
    // Per-scan new-position cap.
    if (opened >= c.maxNewPerScan) { out.skipped.push({ ...record, why: 'max new/scan reached' }); continue; }

    const sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxNotional, maxQty });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }

    const side = bullish ? 'buy' : 'sell';
    const r = await bridge.placeIBKROrder(userId, { ticker: sym, side, qty, type: 'market' }).catch((e) => ({ status: 'error', reason: e.message }));
    const exec = { ...record, action: bullish ? 'open_long' : 'open_short', qty, notional: Math.round(qty * price), result: r };
    // Attach a broker-side protective stop on a filled/placed long — the hard
    // stop-loss the position keeps even if the scan loop dies. SELL STP below entry.
    if (bullish && r && r.status === 'placed') {
      const stop = stopPriceFor(price, c.stopPct);
      if (stop) {
        const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc' }).catch((e) => ({ status: 'error', reason: e.message }));
        exec.stop = { price: stop, status: sr && sr.status, order_id: sr && sr.order_id };
      }
    }
    out.executed.push(exec);
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') opened += 1; }
  }
  return out;
}

/** Test/ops helper: clear the cooldown map. */
function _resetCooldowns() { _lastOrderAt.clear(); }

module.exports = { runAutoTrade, sizePosition, cfg, _resetCooldowns };
