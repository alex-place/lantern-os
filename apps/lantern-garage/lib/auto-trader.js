'use strict';

const fs = require('fs');
const path = require('path');
const yahoo = require('./market-data-yahoo');
const { macd, rsi, emaSeries } = require('./signal-engine/indicators');

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
  cooldownMs: 45 * 60000,  // don't re-ENTER the same symbol within 45 min (anti-churn)
  minPrice: 1,             // skip sub-$1 names
  stopPct: 2,              // protective stop % below entry (broker-side STP)
  maxDailyLossPct: 2,      // halt NEW entries once day P&L ≤ -this% of equity
  // ── Anti-churn (added after a 103-fill/-$1k whipsaw day) ──────────────────
  minHoldMin: 20,          // don't signal-EXIT a long within N min of entering
  exitMinPwin: 0.6,        // only exit on a STRONG bearish signal (p_win ≥ this)
  persistScans: 2,         // act only after the same direction holds N consecutive scans
  persistWindowMs: 200000, // …seen within this window (≈3 scans) — else it's stale
  // ── Momentum / trailing exits — capture the peak instead of round-tripping it ──
  trailPct: 3,             // trailing stop: exit a long if price falls this % from its PEAK
  trailArmPct: 1.5,        // …but arm the trail only once the position has gained ≥ this %
                           //    (so it locks GAINS; the entry−stopPct broker stop covers losses)
  takeProfitPct: 0,        // hard take-profit % (0 = off — let the trailing stop run)
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
    minHoldMs: n('TRADER_MIN_HOLD_MIN', DEFAULTS.minHoldMin) * 60000,    // anti-churn: min hold before exit
    exitMinPwin: n('TRADER_EXIT_MIN_PWIN', DEFAULTS.exitMinPwin),        // anti-churn: exit only on strong bearish
    persistScans: n('TRADER_PERSIST_SCANS', DEFAULTS.persistScans),      // anti-churn: N consecutive scans
    persistWindowMs: n('TRADER_PERSIST_WINDOW_MS', DEFAULTS.persistWindowMs),
    requirePersist: process.env.TRADER_REQUIRE_PERSIST !== '0',          // on by default
    allowShorts: process.env.TRADER_ALLOW_SHORTS === '1',
    enabled: process.env.TRADER_AUTO_EXECUTE === '1',
    // ── Exit management (trailing stop / take-profit / momentum death) ──────────
    trailPct: n('TRADER_TRAIL_PCT', DEFAULTS.trailPct),
    trailArmPct: n('TRADER_TRAIL_ARM_PCT', DEFAULTS.trailArmPct),
    takeProfitPct: n('TRADER_TAKE_PROFIT_PCT', DEFAULTS.takeProfitPct),
    momentumExit: process.env.TRADER_MOMENTUM_EXIT !== '0',              // on unless disabled
    // Manage/close held positions (trailing/TP/momentum) WITHOUT opening new ones.
    // Lets the user protect open positions without arming full autopilot entries.
    manageExits: process.env.TRADER_MANAGE_EXITS === '1',
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

// Per-symbol state (in-process; a restart clears it — safe, just re-checks).
const _lastOrderAt = new Map(); // sym -> last order ts (re-entry cooldown)
const _entryAt = new Map();     // sym -> ts we opened the long (min-hold before exit)
const _dirStreak = new Map();   // sym -> { dir, count, at } (signal-persistence filter)
const _peak = new Map();        // sym -> highest price seen since entry (trailing stop)

/** Close a held long at market: cancel its resting stop, clear per-symbol state,
 *  log the realized outcome, and record it on `out`. Shared by every exit path. */
async function closeLong(bridge, userId, sym, qty, hp, reason, out, now, { extended = false, refPrice = 0 } = {}) {
  // Regular hours: a market SELL closes instantly. Pre/post market: IBKR rejects market
  // orders outside RTH, so use a marketable LIMIT (≈0.2% below the last print, to cross
  // the wider extended-hours spread) with outsideRTH=true so the exit still fills.
  const order = (extended && refPrice > 0)
    ? { ticker: sym, side: 'sell', qty, type: 'limit', limitPrice: Math.round(refPrice * 0.998 * 100) / 100, outsideRth: true }
    : { ticker: sym, side: 'sell', qty, type: 'market' };
  const r = await bridge.placeIBKROrder(userId, order).catch((e) => ({ status: 'error', reason: e.message }));
  await cancelRestingStops(bridge, userId, sym);
  _entryAt.delete(sym); _peak.delete(sym); _lastOrderAt.set(sym, now);
  logTrade({ event: 'exit', symbol: sym, qty, entry: hp.avg_entry_price ?? null, exit: hp.current_price ?? null, pnl: hp.unrealized_pl ?? null, pnl_pct: hp.pnl_pct ?? null, reason, status: r && r.status });
  out.executed.push({ symbol: sym, action: 'exit_long', qty, reason, result: r });
  return r;
}

/**
 * Exit held LONGS on their own merits every scan — independent of whether a new
 * scan signal fired — so a winner that peaks and fades doesn't round-trip:
 *   1. take-profit  — close at a hard +% target (off by default).
 *   2. trailing stop — once up ≥ trailArmPct, close if price falls trailPct from the PEAK.
 *   3. momentum death — while in profit, close when the trend rolls over: MACD histogram
 *      negative AND price below its short EMA (and RSI no longer strong). Catches "the
 *      momentum is dying / about to die" before the full bearish signal would fire.
 * Closed symbols are removed from `heldQty` so the entry loop doesn't re-touch them.
 */
async function manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended = false }) {
  const longs = Object.entries(heldPos).filter(([, p]) => (Number(p.qty) || 0) > 0);
  if (!longs.length) return;

  // Recent 15m bars for momentum — one batched fetch for all held longs (fail-soft).
  let bars = {};
  if (c.momentumExit) {
    try { const bm = await yahoo.getBarsMulti(longs.map(([s]) => s), '15m'); bars = (bm && bm.bars) || {}; } catch (_e) { bars = {}; }
  }

  for (const [sym, p] of longs) {
    const qty = Number(p.qty) || 0;
    const cur = Number(p.current_price) || 0;
    const entry = Number(p.avg_entry_price || p.avg_fill_price) || 0;
    if (!(qty > 0) || !(cur > 0) || !(entry > 0)) continue;

    // Min-hold: never churn a just-opened long — the broker stop still protects it.
    const entryAt = _entryAt.get(sym) || 0;
    if (entryAt && (now - entryAt) < c.minHoldMs) continue;

    const pnlPct = ((cur - entry) / entry) * 100;
    const peak = Math.max(_peak.get(sym) || 0, cur, entry);   // running high-water mark
    _peak.set(sym, peak);
    const peakGainPct = ((peak - entry) / entry) * 100;         // best gain reached
    const dropFromPeakPct = peak > 0 ? ((peak - cur) / peak) * 100 : 0;

    // 1) Hard take-profit.
    if (c.takeProfitPct > 0 && pnlPct >= c.takeProfitPct) {
      await closeLong(bridge, userId, sym, qty, p, `take_profit (+${pnlPct.toFixed(1)}%)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }
    // 2) Trailing stop — only after the position has run up (locks GAINS, not losses).
    if (c.trailPct > 0 && peakGainPct >= c.trailArmPct && dropFromPeakPct >= c.trailPct) {
      await closeLong(bridge, userId, sym, qty, p, `trailing_stop (−${dropFromPeakPct.toFixed(1)}% from peak +${peakGainPct.toFixed(1)}%)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }
    // 3) Momentum death — fading winner: MACD histogram negative + below short EMA.
    if (c.momentumExit && pnlPct > 0) {
      const closes = ((bars[sym] && bars[sym].bars) || []).map((b) => b.close).filter((x) => x > 0);
      if (closes.length >= 30) {
        const m = macd(closes);
        const ema9 = emaSeries(closes, 9);
        const e9 = ema9[ema9.length - 1];
        const last = closes[closes.length - 1];
        const r = rsi(closes);
        if (m && m.histogram < 0 && last < e9 && (r == null || r < 55)) {
          await closeLong(bridge, userId, sym, qty, p, `momentum_died (MACD hist<0, <EMA9${r != null ? `, RSI ${Math.round(r)}` : ''})`, out, now, { extended, refPrice: cur });
          delete heldQty[sym]; continue;
        }
      }
    }
  }
}

/**
 * Execute the ENTER verdicts from a scan against the user's IBKR account.
 * @param {object} scan   result of traderAgent.scanMarket() — { signals: [...] }
 * @param {object} deps   { bridge, userId, now?, caps? }
 * @returns {Promise<{executed:Array, skipped:Array, enabled:boolean, reason?:string}>}
 */
async function runAutoTrade(scan, { bridge, userId, now = Date.now(), caps = {}, extended = false } = {}) {
  const c = cfg();
  const out = { executed: [], skipped: [], enabled: c.enabled, manageExits: c.manageExits };
  // Either arm entries+exits (TRADER_AUTO_EXECUTE) or exits-only (TRADER_MANAGE_EXITS).
  if (!c.enabled && !c.manageExits) { out.reason = 'TRADER_AUTO_EXECUTE!=1 and TRADER_MANAGE_EXITS!=1 — nothing to do'; return out; }
  if (!bridge || !userId) { out.reason = 'no bridge/userId'; return out; }

  const signals = (scan && Array.isArray(scan.signals)) ? scan.signals : [];
  const enters = signals.filter((s) => s && s.convergence && s.convergence.decision === 'ENTER');

  // Broker truth: current account + open positions (never trade blind). Fetched
  // BEFORE the no-signals early-return so the stop-reconciliation below runs every
  // scan even when there are no new ENTER signals.
  const account = await bridge.getIBKRAccount(userId).catch(() => null);
  if (!account || !(account.equity > 0)) { out.reason = 'account/equity unavailable'; return out; }
  const positions = await bridge.getIBKRPositions(userId).catch(() => []);
  const heldQty = {};
  const heldPos = {}; // full position (for realized-P&L logging on exit)
  for (const p of (positions || [])) { const k = String(p.symbol).toUpperCase(); heldQty[k] = Number(p.qty) || 0; heldPos[k] = p; }

  // ── Re-protect naked longs: any held long that's lost its protective stop (the
  //    stop was consumed/cancelled while the position stayed open) gets a fresh GTC
  //    SELL STP. Runs every scan so a long is never left unprotected. ──
  try {
    const openOrders = await bridge.getIBKROpenOrders(userId).catch(() => []);
    const hasStop = (sym) => (openOrders || []).some((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || '') && /sell/i.test(o.side || '') &&
      /submit|pending|presubmit/i.test(o.status || ''));
    for (const [sym, p] of Object.entries(heldPos)) {
      const qty = Number(p.qty) || 0;
      if (qty > 0 && !hasStop(sym)) {
        const entry = Number(p.avg_entry_price || p.avg_fill_price || p.current_price) || 0;
        const stop = stopPriceFor(entry, c.stopPct);
        if (stop) {
          const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc', equity: account.equity }).catch((e) => ({ status: 'error', reason: e.message }));
          (out.reprotected = out.reprotected || []).push({ symbol: sym, qty, stop, status: sr && sr.status });
        }
      }
    }
  } catch (_e) { /* fail-soft — the daily-loss breaker still guards the account */ }

  // ── Manage held longs on their own merits (trailing stop / take-profit / momentum
  //    death) — runs every scan, independent of new ENTER signals. This is what stops
  //    a winner from peaking and giving it all back. ──
  try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended }); } catch (_e) { /* fail-soft */ }

  // Entries require the full autopilot arm; exits-only mode stops here.
  if (!c.enabled) { out.reason = 'exit-management only (TRADER_MANAGE_EXITS) — entries off'; return out; }

  if (!enters.length) { out.reason = 'no ENTER signals'; return out; }

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

    // ── Signal persistence (anti-churn): require the SAME direction to hold for
    //    `persistScans` consecutive scans before acting, so single-scan RSI/zone
    //    noise can't whipsaw the position in and out (103 fills/-$1k in one day). ──
    const streak = _dirStreak.get(sym);
    const fresh = streak && (now - streak.at) < c.persistWindowMs;
    const count = fresh && streak.dir === s.direction ? streak.count + 1 : 1;
    _dirStreak.set(sym, { dir: s.direction, count, at: now });
    const persistent = !c.requirePersist || count >= c.persistScans;

    // ── BEARISH: only ever CLOSE a long we already hold. NEVER open or deepen a
    //    short (longs-only). Critically, cancel the resting protective stop when we
    //    close — an orphaned GTC stop would otherwise fire on the now-flat position
    //    and open an unintended short (this is what put JPM/META short). ──
    if (!bullish) {
      if (held > 0) {
        // Anti-churn gates on the signal-exit (the broker stop still protects the
        // downside independently): (1) don't dump a long we just opened, (2) only
        // exit on a STRONG bearish read, (3) require it to persist across scans.
        const entryAt = _entryAt.get(sym) || 0;
        if (entryAt && now - entryAt < c.minHoldMs) { out.skipped.push({ ...record, why: `min-hold (${Math.round((now - entryAt) / 60000)}<${Math.round(c.minHoldMs / 60000)}min) — stop still protects` }); continue; }
        if ((s.convergence.p_win || 0) < c.exitMinPwin) { out.skipped.push({ ...record, why: `bearish too weak to exit (p_win ${s.convergence.p_win} < ${c.exitMinPwin})` }); continue; }
        if (!persistent) { out.skipped.push({ ...record, why: `awaiting ${c.persistScans} consecutive bearish scans (persistence)` }); continue; }
        const exOrder = (extended && price > 0)
          ? { ticker: sym, side: 'sell', qty: held, type: 'limit', limitPrice: Math.round(price * 0.998 * 100) / 100, outsideRth: true }
          : { ticker: sym, side: 'sell', qty: held, type: 'market' };
        const r = await bridge.placeIBKROrder(userId, exOrder).catch((e) => ({ status: 'error', reason: e.message }));
        await cancelRestingStops(bridge, userId, sym);
        _entryAt.delete(sym);
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
    if (!persistent) { out.skipped.push({ ...record, why: `awaiting ${c.persistScans} consecutive bullish scans (persistence)` }); continue; }
    if (opened >= c.maxNewPerScan) { out.skipped.push({ ...record, why: 'max new/scan reached' }); continue; }
    // Defensive: on a stray short, clear any stale resting orders before re-entering.
    if (held < 0) await cancelRestingStops(bridge, userId, sym);

    const sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxPositionPct: c.maxPositionPct });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }

    const enOrder = (extended && price > 0)
      ? { ticker: sym, side: 'buy', qty, type: 'limit', limitPrice: Math.round(price * 1.002 * 100) / 100, outsideRth: true, equity: account.equity }
      : { ticker: sym, side: 'buy', qty, type: 'market', equity: account.equity };
    const r = await bridge.placeIBKROrder(userId, enOrder).catch((e) => ({ status: 'error', reason: e.message }));
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
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') { _entryAt.set(sym, now); opened += 1; } }
  }
  return out;
}

/** Test/ops helper: clear the per-symbol state. */
function _resetCooldowns() { _lastOrderAt.clear(); _entryAt.clear(); _dirStreak.clear(); }

module.exports = { runAutoTrade, sizePosition, cfg, _resetCooldowns };
