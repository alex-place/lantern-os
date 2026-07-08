'use strict';

const fs = require('fs');
const path = require('path');

// Per-trade outcome log (append-only JSONL) — the honest record that lets us
// MEASURE the autopilot's realized edge (win-rate / P&L) against the backtest,
// instead of eyeballing it. Resolved relative to this module so it's found
// regardless of the server's cwd (same reason as the credential store).
const TRADES_LOG = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
function logTrade(rec) {
  try {
    fs.mkdirSync(path.dirname(TRADES_LOG), { recursive: true });
    fs.appendFileSync(TRADES_LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch (_e) { /* logging must never break trading */ }
}

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
  positionPct: 2.5,        // AVERAGE position as % of equity (conviction scales it)
  maxPositionPct: 5,       // HARD cap per position as % of equity ($50k on $1M)
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
    maxPositionPct: n('TRADER_MAX_POSITION_PCT', DEFAULTS.maxPositionPct),
    maxNewPerScan: n('TRADER_MAX_NEW_PER_SCAN', DEFAULTS.maxNewPerScan),
    cooldownMs: n('TRADER_COOLDOWN_MS', DEFAULTS.cooldownMs),
    stopPct: n('TRADER_STOP_PCT', DEFAULTS.stopPct),                     // protective stop distance
    maxDailyLossPct: n('TRADER_MAX_DAILY_LOSS_PCT', DEFAULTS.maxDailyLossPct), // circuit breaker
    allowShorts: process.env.TRADER_ALLOW_SHORTS === '1',
    enabled: process.env.TRADER_AUTO_EXECUTE === '1',
  };
}

/** Cancel any working orders for a symbol (chiefly a protective stop) so a stale
 *  stop can't fire on a flat/closed position and open an unintended short. */
async function cancelRestingStops(bridge, userId, sym) {
  try {
    const orders = await bridge.getIBKROpenOrders(userId);
    for (const o of (orders || [])) {
      if (String(o.symbol || '').toUpperCase() === sym && o.orderId && /submit|pending|presubmit/i.test(o.status || '')) {
        await bridge.cancelIBKROrder(userId, o.orderId);
      }
    }
  } catch (_e) { /* fail-soft — a missed cancel is caught by the never-short guard */ }
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
function sizePosition({ equity, price, sizeMult = 1, positionPct = DEFAULTS.positionPct, maxPositionPct = DEFAULTS.maxPositionPct, maxQty = 100000 }) {
  const px = Number(price);
  const eq = Number(equity);
  if (!(px > 0) || !(eq > 0)) return 0;
  const mult = Math.max(0.5, Math.min(1.5, Number(sizeMult) || 1));
  // % of PORTFOLIO — scales with equity. Average positionPct, conviction-scaled,
  // hard-capped at maxPositionPct of equity (e.g. 2.5% avg, 5%/$50k max on $1M).
  const capNotional = eq * (maxPositionPct / 100);
  const targetNotional = Math.min(eq * (positionPct / 100) * mult, capNotional);
  let qty = Math.floor(targetNotional / px);
  qty = Math.max(0, Math.min(qty, maxQty));
  while (qty > 0 && qty * px > capNotional) qty -= 1; // never exceed the % cap
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
  const heldPos = {}; // full position (for realized-P&L logging on exit)
  for (const p of (positions || [])) { const k = String(p.symbol).toUpperCase(); heldQty[k] = Number(p.qty) || 0; heldPos[k] = p; }

  // Daily-loss circuit breaker: once the account's day P&L is at/below the limit,
  // stop opening NEW positions (exits still run — closing losers is allowed).
  const dailyLimit = account.equity * (c.maxDailyLossPct / 100);
  const dayPnl = await bridge.getIBKRDayPnl(userId).catch(() => null);
  const haltEntries = typeof dayPnl === 'number' && dayPnl <= -dailyLimit;
  if (haltEntries) out.circuit_breaker = { dayPnl, limit: -Math.round(dailyLimit) };

  let opened = 0;

  for (const s of enters) {
    const sym = String(s.symbol).toUpperCase();
    const price = Number(s.entry_price) || 0;
    const held = heldQty[sym] || 0;
    const bullish = s.direction === 'BULLISH';
    const record = { symbol: sym, direction: s.direction, p_win: s.convergence.p_win, news: s.news || null };

    if (price < c.minPrice) { out.skipped.push({ ...record, why: 'price too low' }); continue; }
    // Crypto pairs can't trade through this IBKR path (Paxos needs a US crypto acct
    // + cash-qty orders) — skip so the autopilot doesn't churn on un-tradable names.
    if (/^[A-Z]{2,5}USD$/.test(sym)) { out.skipped.push({ ...record, why: 'crypto not tradable on this account' }); continue; }

    // ── BEARISH: only ever CLOSE a long we already hold. NEVER open or deepen a
    //    short (longs-only). Critically, cancel the resting protective stop when we
    //    close — an orphaned GTC stop would otherwise fire on the now-flat position
    //    and open an unintended short (this is what put JPM/META short). ──
    if (!bullish) {
      if (held > 0) {
        const r = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty: held, type: 'market' }).catch((e) => ({ status: 'error', reason: e.message }));
        await cancelRestingStops(bridge, userId, sym);
        const hp = heldPos[sym] || {};
        // Realized P&L on the closed long (the position's unrealized P&L becomes real).
        logTrade({ event: 'exit', symbol: sym, qty: held, entry: hp.avg_entry_price ?? null, exit: hp.current_price ?? null, pnl: hp.unrealized_pl ?? null, pnl_pct: hp.pnl_pct ?? null, reason: 'signal_exit', status: r && r.status });
        out.executed.push({ ...record, action: 'exit_long', qty: held, result: r });
        _lastOrderAt.set(sym, now);
      } else {
        out.skipped.push({ ...record, why: held < 0 ? 'already short — not deepening (longs-only)' : 'bearish, no long to exit' });
      }
      continue;
    }

    // ── BULLISH: open a long only if flat. Never pyramid; never sell. ──
    if (held > 0) { out.skipped.push({ ...record, why: 'already long' }); continue; }
    if (haltEntries) { out.skipped.push({ ...record, why: `daily-loss limit hit (day P&L ${Math.round(dayPnl)})` }); continue; }
    const last = _lastOrderAt.get(sym) || 0;
    if (now - last < c.cooldownMs) { out.skipped.push({ ...record, why: 'cooldown' }); continue; }
    if (opened >= c.maxNewPerScan) { out.skipped.push({ ...record, why: 'max new/scan reached' }); continue; }
    // Defensive: on a stray short, clear any stale resting orders before re-entering.
    if (held < 0) await cancelRestingStops(bridge, userId, sym);

    const sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxPositionPct: c.maxPositionPct });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }

    const r = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'buy', qty, type: 'market', equity: account.equity }).catch((e) => ({ status: 'error', reason: e.message }));
    const exec = { ...record, action: 'open_long', qty, notional: Math.round(qty * price), result: r };
    // Attach a broker-side protective stop on the placed long — the hard stop the
    // position keeps even if the scan loop dies. Cancelled on the signal exit above.
    if (r && r.status === 'placed') {
      const stop = stopPriceFor(price, c.stopPct);
      if (stop) {
        const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc' }).catch((e) => ({ status: 'error', reason: e.message }));
        exec.stop = { price: stop, status: sr && sr.status, order_id: sr && sr.order_id };
      }
    }
    if (r && r.status === 'placed') {
      const pl = s.plan || {};
      logTrade({ event: 'entry', symbol: sym, side: 'long', qty, entry: price, notional: Math.round(qty * price), p_win: s.convergence && s.convergence.p_win, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null, target1: pl.target1 ?? null, target2: pl.target2 ?? null, hold_days: pl.hold_days ?? null });
    }
    out.executed.push(exec);
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') opened += 1; }
  }
  return out;
}

/** Test/ops helper: clear the cooldown map. */
function _resetCooldowns() { _lastOrderAt.clear(); }

module.exports = { runAutoTrade, sizePosition, cfg, _resetCooldowns };
