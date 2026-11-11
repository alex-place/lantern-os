'use strict';

const fs = require('fs');
const path = require('path');
const yahoo = require('./market-data-yahoo');
const { macd, rsi, emaSeries } = require('./signal-engine/indicators');
// The exchange calendar (2026-10-26): the closing-window rules below were written against a 16:00 close. On a 13:00
// early close they move with the close (closeOffset = 180), and session counts skip weekday holidays.
const marketCalendar = require('./market-calendar');

// Per-trade outcome log (append-only JSONL), resolved relative to this module.
// TRADER_TRADES_LOG / TRADER_STATE_FILE override the paths (tests, per-sleeve journals). (H0)
const TRADES_LOG = process.env.TRADER_TRADES_LOG
  ? path.resolve(process.env.TRADER_TRADES_LOG)
  : require('./app-paths').dataPath('lantern-garage', 'trading', 'autopilot-trades.jsonl');
// Per-user attribution: every ledger row carries the account it was traded for. The acting user rides the
// pass's async context (not a module scalar) because the fast-exit loop can interleave with the scan loop. (H1)
const { AsyncLocalStorage } = require('async_hooks');
const _pass = new AsyncLocalStorage();   // { user, gate } of the pass in progress
function logTrade(rec) {
  const _actingUser = (_pass.getStore() || {}).user || null;
  try {
    fs.mkdirSync(path.dirname(TRADES_LOG), { recursive: true });
    fs.appendFileSync(TRADES_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      // `user` first so an explicit rec.user (e.g. a backfill) still wins.
      ...(_actingUser ? { user: _actingUser } : {}),
      ...rec,
    }) + '\n');
  } catch (_e) { /* logging must never break trading */ }
  // Converge stage (#3286): entries and exits are paired into the convergence store from the single ledger
  // write point. Fire-and-forget — a record must never delay or break a trade. (H2)
  try {
    if (rec && (rec.event === 'entry' || rec.event === 'exit')) {
      const tc = require('./trader-convergence');
      const p = rec.event === 'entry' ? tc.recordEntryHypothesis(rec) : tc.recordExitOutcome(rec);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_e) { /* convergence emission is best-effort, always */ }
  // A CONFIRMED exit clears the flat-reading veto (#3282). Only a real fill counts: a reconstructed row is
  // inferred from the same absence the veto distrusts, so letting it clear the veto would be circular. (H3)
  try {
    if (rec && rec.event === 'exit' && rec.symbol
      && (rec.status === 'filled' || rec.source === 'fill')) {
      _lastConfirmedHold.delete(String(rec.symbol).toUpperCase());
    }
  } catch (_e) { /* never break logging */ }
}

// auto-trader.js — autonomous stock EXECUTION over the Σ₀ scan (Act stage).
// Turns the scan's ENTER verdicts into orders on the user's connected broker account.
//
// SAFETY (all must hold to place a real order):
//   1. TRADER_AUTO_EXECUTE=1 — explicit opt-in, separate from manual TRADER_LIVE.
//   2. Every order still passes the hard guard in trading-guard.js.
//   3. Sizing is bounded by MAX_ORDER_NOTIONAL and TRADER_POSITION_PCT.
//   4. One position per symbol (no pyramiding); a per-symbol cooldown stops churn.
//   5. Longs only by default; BEARISH only sells a long we hold (TRADER_ALLOW_SHORTS=1 to short).
// Every decision is logged with its evidence; fills are passed through from the broker, never fabricated.
// History of each rule (dates, incidents, measurements): docs/trading/auto-trader-history.md (Hn ids). (H4)

const DEFAULTS = {
  positionPct: 2.5,        // AVERAGE position as % of equity (conviction scales it)
  maxPositionPct: 5,       // HARD cap per position as % of equity ($50k on $1M)
  maxNewPerScan: 3,        // cap new entries opened in a single scan tick
  cooldownMs: 45 * 60000,  // don't re-ENTER the same symbol within 45 min (anti-churn)
  minPrice: 1,             // skip sub-$1 names
  stopPct: 2,              // protective stop % below entry (broker-side STP)
  maxLossPct: 8,           // HARD max-loss backstop: market-exit a long down ≥ this %
                           //    from entry, REGARDLESS of momentum. Catches a loser whose
                           //    broker stop never placed/filled (gap-down, missing stop) —
                           //    without it, the only loss protection is the entry STP, so a
                           //    position with no stop runs unbounded (the -17% TSLA case).
  maxDailyLossPct: 2,      // halt NEW entries once day P&L ≤ -this% of equity
  // ── Anti-churn (added after a 103-fill/-$1k whipsaw day) ──────────────────
  minHoldMin: 20,          // don't signal-EXIT a long within N min of entering
  exitMinPwin: 0.6,        // only exit on a STRONG bearish signal (p_win ≥ this)
  ibsExit: 0,              // IBS THESIS GATE: in IBS mode a non-bullish read may signal-exit
                           //    only once the session IBS ≥ this (the lab's bounce, 0.6).
                           //    0 = off (legacy: NEUTRAL sells the moment IBS > entry threshold)
  persistScans: 2,         // act only after the same direction holds N consecutive scans
  persistWindowMs: 200000, // …seen within this window (≈3 scans) — else it's stale
  // ── Momentum / trailing exits — capture the peak instead of round-tripping it ──
  trailPct: 2.5,           // BASE trailing stop: exit a long if price falls this % from its PEAK
                           //    (ratcheted TIGHTER as the peak gain grows — see trailTriggerPct)
  trailArmPct: 1.5,        // …but arm the trail only once the position has gained ≥ this %
                           //    (so it locks GAINS; the entry−stopPct broker stop covers losses)
  takeProfitPct: 0,        // hard take-profit % (0 = off — let the trailing stop run)
  takeProfitR: 1,          // R-MULTIPLE take-profit: exit at +takeProfitR × risk (risk =
                           //    stopPct). 0 = off (let the trailing stop run instead).
  // After firing an exit for a symbol, don't re-fire for this long (an unfilled extended-hours
  // limit was re-placed every scan, stacking orders). (H5)
  exitReattemptMin: 8,
};

function cfg() {
  const n = (name, d) => {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    positionPct: n('TRADER_POSITION_PCT', DEFAULTS.positionPct),
    maxPositionPct: n('TRADER_MAX_POSITION_PCT', DEFAULTS.maxPositionPct),
    // Portfolio-level cash reserve (2026-08-06): gross exposure across ALL
    // positions is capped at this % of equity; the rest stays in cash. 0 or
    // >=100 disables. Default 80 = always keep 20% cash.
    maxGrossPct: n('TRADER_MAX_GROSS_PCT', 80),
    maxNewPerScan: n('TRADER_MAX_NEW_PER_SCAN', DEFAULTS.maxNewPerScan),
    cooldownMs: n('TRADER_COOLDOWN_MS', DEFAULTS.cooldownMs),
    stopPct: n('TRADER_STOP_PCT', DEFAULTS.stopPct),                     // protective stop distance
    maxLossPct: n('TRADER_MAX_LOSS_PCT', DEFAULTS.maxLossPct),           // hard max-loss backstop exit
    maxLossRthOnly: process.env.TRADER_MAX_LOSS_RTH_ONLY === '1',        // the backstop decides in regular hours only; off unless '1' (manageHeldExits)
    maxDailyLossPct: n('TRADER_MAX_DAILY_LOSS_PCT', DEFAULTS.maxDailyLossPct), // circuit breaker
    minHoldMs: n('TRADER_MIN_HOLD_MIN', DEFAULTS.minHoldMin) * 60000,    // anti-churn: min hold before exit
    exitReattemptMs: n('TRADER_EXIT_REATTEMPT_MIN', DEFAULTS.exitReattemptMin) * 60000, // anti-churn: min gap between exit attempts on the SAME symbol
    exitMinPwin: n('TRADER_EXIT_MIN_PWIN', DEFAULTS.exitMinPwin),        // anti-churn: exit only on strong bearish
    exitMinSessionMin: n('TRADER_EXIT_MIN_SESSION_MIN', 30),             // 2026-08-24: no signal exit until the session range is this old
    ibsExit: n('TRADER_IBS_EXIT', DEFAULTS.ibsExit),                    // fidelity lab 2026-08-22: hold the washout to its bounce
    persistScans: n('TRADER_PERSIST_SCANS', DEFAULTS.persistScans),      // anti-churn: N consecutive scans
    persistWindowMs: n('TRADER_PERSIST_WINDOW_MS', DEFAULTS.persistWindowMs),
    requirePersist: process.env.TRADER_REQUIRE_PERSIST !== '0',          // on by default
    allowShorts: process.env.TRADER_ALLOW_SHORTS === '1',
    // Zone-ladder exit (#3165): sell at the first resistance zone unless price punches through it, then
    // target the second with the first as the floor (cfg.zoneExit). (H6)
    // ATR-based protective stops: use the signal's own plan stop, clamped to [atrStopMinPct, atrStopMaxPct];
    // flat stopPct is the fallback. Kill: TRADER_ATR_STOPS=0.
    atrStops: process.env.TRADER_ATR_STOPS !== '0',
    // Risk-based sizing: qty = equity*riskPct / (entry-stop). 0 = legacy notional sizing; the maxPositionPct
    // notional cap still binds on top. (H7)
    riskPct: n('TRADER_RISK_PCT', 0.06),
    // Room tiering: entries whose first resistance is >= roomMinR away (A-tier) get full risk; cramped (B-tier)
    // entries get roomBMult x risk. Kill: TRADER_ROOM_TIER=0. (H8)
    roomTier: process.env.TRADER_ROOM_TIER !== '0',
    roomMinR: n('TRADER_ROOM_MIN_R', 1.5),
    roomBMult: n('TRADER_ROOM_B_MULT', 0.5),
    // A+ tier: room AND volume expansion. Held at A's risk until live logging proves it (TRADER_APLUS_MULT). (H9)
    volAplus: n('TRADER_VOL_APLUS', 1.2),
    aplusMult: n('TRADER_APLUS_MULT', 1.0),
    // Target separation: resistances nearer than tgtMinR (in R) are noise, skipped for both the exit ladder and
    // the room tier. Kill: TRADER_TGT_MIN_R=0. (H10)
    tgtMinR: n('TRADER_TGT_MIN_R', 0.5),
    // Minimum stop distance, % of price. On a 3x ETF this is tighter in underlying terms — see
    // TRADER_STOP_MIN_PCT_BY_SYMBOL. (H11)
    stopMinPct: n('TRADER_STOP_MIN_PCT', 3),
    // RR by construction: stop = (distance to first real resistance) / n.
    // 0 disables (stop stays structural). Gated 2:1/3:1/4:1 — all beat off in
    // both windows; 3:1 best on holdout (+0.378%/trade vs +0.334%).
    stopFromTgt: n('TRADER_STOP_FROM_TGT', 3),
    // Max simultaneous open positions. Truncates the left tail (worst days are
    // concurrency x stop width). 0 disables.
    maxConcurrent: n('TRADER_MAX_CONCURRENT', 2),
    // #3317: the last slot(s) are reserved for conviction — sub-threshold
    // signals fill only up to (cap − reserve). 0 disables. Not lab-gateable
    // (no p_win on daily bars); every refusal writes an audit row instead.
    slotReserve: n('TRADER_SLOT_RESERVE', 1),
    slotReservePwin: n('TRADER_SLOT_RESERVE_PWIN', 0.55),
    // EOD de-carry: leveraged holdings are flattened into the close (stops cannot protect through a gap).
    // Kill: TRADER_EOD_DECARRY=0. (H12)
    eodDecarry: process.env.TRADER_EOD_DECARRY !== '0',
    // Session-end flat. TRADER_EOD_FLAT: 'weekend' = flat every long into the last close before a weekend;
    // 'all' = every close; 'off' (default) = hold. TRADER_EOD_FLAT_MIN = start minute (default the de-carry clock). (H13)
    eodFlat: String(process.env.TRADER_EOD_FLAT || 'off').trim().toLowerCase(),
    eodFlatMin: n('TRADER_EOD_FLAT_MIN', n('TRADER_DECARRY_MIN', 950)),
    // TRADER_MAX_HOLD_SESSIONS (default off): flatten a position at the close of its Nth session. (H14)
    maxHoldSessions: n('TRADER_MAX_HOLD_SESSIONS', 0),
    decarryMin: n('TRADER_DECARRY_MIN', 950),                       // 15:50 ET
    decarrySyms: new Set(String(process.env.TRADER_DECARRY_SYMBOLS
      || 'TQQQ,SQQQ,SOXL,SOXS,SPXL,SPXS,TNA,TZA')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    // Carry on a down day: the de-carry stands aside for TRADER_CARRY_DOWNDAY_SYMBOLS (default the inverse
    // family) when SPY's regular session is at/below TRADER_CARRY_DOWNDAY_SPY_PCT. Unset = off. (H15)
    carryDownDayPct: (() => { const v = Number(process.env.TRADER_CARRY_DOWNDAY_SPY_PCT); return Number.isFinite(v) && v < 0 ? v : 0; })(),
    carryDownDaySyms: new Set(String(process.env.TRADER_CARRY_DOWNDAY_SYMBOLS || 'SQQQ,SOXS,SPXS,TZA,FAZ')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    // Positions below this % of equity are DUST and never consume a
    // concurrency slot (nor do unclosable ones). 0 counts every row.
    dustPct: n('TRADER_DUST_PCT', 0.1),
    // Minimum reward:risk, measured against the FLOORED stop. 0 disables.
    minEntryRr: n('TRADER_MIN_ENTRY_RR', 1),
    // Max simultaneous positions sharing ONE correlated risk bucket
    // (equity_long / equity_short / metals / per-symbol). 0 disables.
    maxPerBucket: n('TRADER_MAX_PER_BUCKET', 0),
    // Regime sizing: when SPY's first-30m close position <= regimeR30Max (trend-down day), post-10:00 long
    // entries carry regimeSizeMult x risk. Size only; inverse family exempt. (0,1) enables; 0 = off. (H16)
    regimeSizeMult: n('TRADER_REGIME_SIZE_MULT', 0),
    regimeR30Max: n('TRADER_REGIME_R30_MAX', 0.15),
    // Trail past R2 instead of selling AT it (lab 2026-08-08, Monday-config
    // gate: OOS +0.733%/trade vs +0.328 selling at R2, both windows, WR flat).
    // A mark through R2 upgrades the runner to a ratcheting floor at
    // peak*(1 - r2TrailPct%), never below R2. 0 keeps the fixed R2 sell.
    r2Trail: n('TRADER_R2_TRAIL', 0),
    r2TrailPct: n('TRADER_R2_TRAIL_PCT', 1),
    // Trading days a stopped-out symbol stays barred from re-entry (0 disables).
    stopCooldownDays: n('TRADER_STOP_COOLDOWN_DAYS', 1),
    // Daily circuit breaker: after this many stop FILLS in one ET session, no
    // new entries for the rest of it (0 disables). Exits are never blocked.
    stopBreaker: n('TRADER_STOP_BREAKER', 2),
    atrStopMinPct: n('TRADER_ATR_STOP_MIN_PCT', 1),
    atrStopMaxPct: n('TRADER_ATR_STOP_MAX_PCT', 6),
    // Per-symbol stop scaling, e.g. "SPY:0.65,QQQ:0.8". Kill: TRADER_STOP_SCALE_SYMBOLS="". (H17)
    stopScale: (() => {
      const m = new Map();
      for (const part of String(process.env.TRADER_STOP_SCALE_SYMBOLS ?? 'SPY:0.65').split(',')) {
        const [sym, k] = part.split(':');
        const v = parseFloat(k);
        if (sym && Number.isFinite(v) && v > 0.2 && v <= 1) m.set(sym.trim().toUpperCase(), v);
      }
      return m;
    })(),
    // Support-entry gate: enter only within supEntryAtr ATRs of the support zone top, stop under the zone
    // (bottom - 0.25 ATR). Kill: TRADER_SUP_ENTRY=0; scope: TRADER_SUP_ENTRY_SYMBOLS. (H18)
    supEntry: process.env.TRADER_SUP_ENTRY !== '0',
    supEntryAtr: n('TRADER_SUP_ENTRY_ATR', 0.5),
    supEntrySyms: new Set(String(process.env.TRADER_SUP_ENTRY_SYMBOLS || 'SPY,QQQ,GLD,SMH,TLT,SQQQ,SOXS,SPXS')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    zoneExit: process.env.TRADER_ZONE_EXIT !== '0',
    // Ladder for every entry (#3285): default 'all'; set TRADER_ZONE_EXIT_SYMBOLS to a list only to restrict. (H19)
    zoneExitSyms: (String(process.env.TRADER_ZONE_EXIT_SYMBOLS || 'all').trim().toLowerCase() === 'all')
      ? 'all'
      : new Set(String(process.env.TRADER_ZONE_EXIT_SYMBOLS)
        .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    // Experimental vol-scaled rung tightening — falsified at defaults; OFF (0), kept for a re-test. (H20)
    ladderVolMult: n('TRADER_LADDER_VOL_MULT', 0),
    enabled: process.env.TRADER_AUTO_EXECUTE === '1',
    // ── Exit management (trailing stop / take-profit / momentum death) ──────────
    trailPct: n('TRADER_TRAIL_PCT', DEFAULTS.trailPct),
    trailArmPct: n('TRADER_TRAIL_ARM_PCT', DEFAULTS.trailArmPct),
    takeProfitPct: n('TRADER_TAKE_PROFIT_PCT', DEFAULTS.takeProfitPct),
    takeProfitR: n('TRADER_TAKE_PROFIT_R', DEFAULTS.takeProfitR),        // R-multiple take-profit (tight target)
    momentumExit: process.env.TRADER_MOMENTUM_EXIT !== '0',              // on unless disabled
    // Momentum-death needs a minimum profit (in R) before it may fire; below it the stop manages risk. (H21)
    momentumMinR: n('TRADER_MOMENTUM_MIN_R', 0.5),
    momentumTf: process.env.TRADER_MOMENTUM_TF || '5m',                  // candle size for the momentum-death read (5m = faster peak capture; 15m = smoother)
    entryKnifeFilter: process.env.TRADER_ENTRY_KNIFE_FILTER !== '0',      // veto buying into still-cratering momentum (falling knife); on by default
    inverseSpyGate: (() => { const v = Number(process.env.TRADER_INVERSE_SPY_GATE); return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0; })(),
    // TRADER_ENTRY_CONFIRM (default off): require N rising closes on the momentum timeframe before an entry
    // (1 = one up bar; 2 = two up bars, no new low between). (H22)
    entryConfirm: (() => { const v = Math.floor(Number(process.env.TRADER_ENTRY_CONFIRM)); return Number.isFinite(v) && v >= 1 && v <= 2 ? v : 0; })(),
    confirmShape: process.env.TRADER_CONFIRM_SHAPE === '1',   // shape-aware turn read: V-bottom fast-track + weak-turn veto (default OFF)
    // Manage/close held positions (trailing/TP/momentum) WITHOUT opening new ones.
    // Lets the user protect open positions without arming full autopilot entries.
    manageExits: process.env.TRADER_MANAGE_EXITS === '1',
  };
}

// cancelRestingStops cancels a symbol's working orders (chiefly its stop) so a stale stop can't fire on a
// flat position and open a short.
// Stop status vocabulary (#3352): classify by COMPLEMENT — WORKING, TERMINAL (cancelled/filled), else FAILED.
// Unknown statuses land in FAILED, the safe side: the re-protect cap stops adding. (H23)
const STOP_WORKING = /submit|pending|presubmit|open|accepted|new|working|held/i;
const STOP_TERMINAL = /cancel|fill|done|expire/i;
/** A stop order that exists but never protected anything (incl. unknown status). */
const isFailedStop = (status) => {
  const v = String(status || '');
  return !STOP_WORKING.test(v) && !STOP_TERMINAL.test(v);
};

// A stop is never cancelled ahead of an order that cannot go out (review H1): while the broker leg says
// sells are refused (halt file, dry account, unknown mode), the pass changes no stop and fires no exit. (H24)
async function _sellGate(bridge, userId) {
  if (bridge && typeof bridge.sellPreflight === 'function') {
    try {
      const g = await bridge.sellPreflight(userId, { qty: 1 });
      if (g && typeof g.allowed === 'boolean') return { allowed: g.allowed, reason: String(g.reason || '') };
      return { allowed: false, reason: 'sell preflight gave no answer' };
    } catch (e) { return { allowed: false, reason: `sell preflight failed: ${e.message}` }; }
  }
  // A bridge without a preflight (a test double, a wrapper that doesn't forward it):
  // the process-wide halt still holds.
  let halt = null;
  try { halt = require('./trading-guard').haltFile(); } catch (_e) { /* guard absent */ }
  return halt ? { allowed: false, reason: `global halt engaged (${halt})` } : { allowed: true, reason: 'no preflight on this bridge' };
}
function _passSellGate() { const st = _pass.getStore(); return (st && st.gate) || null; }
function _setPassSellGate(gate) { const st = _pass.getStore(); if (st) st.gate = gate; }
const _exitsHeldNoted = new Map();   // user -> reason last journaled (one row per change, not per pass)
function _noteExitsHeld(userId, gate, out) {
  if (out) (out.skipped = out.skipped || []).push({ symbol: '*', why: `exits held — ${gate.reason}; no stop is cancelled while orders cannot go out` });
  const k = String(userId || '');
  if (_exitsHeldNoted.get(k) === gate.reason) return;
  _exitsHeldNoted.set(k, gate.reason);
  logTrade({ event: 'exits_held', symbol: '*', reason: gate.reason,
    why: 'orders cannot go out for this account, so exits and stop changes wait; the broker-side stops stay in place' });
}
function _noteExitsResumed(userId) {
  if (_exitsHeldNoted.delete(String(userId || ''))) logTrade({ event: 'exits_resumed', symbol: '*' });
}

async function cancelRestingStops(bridge, userId, sym) {
  // Never strip a stop while orders cannot go out for this account (review H1): the
  // sell or replacement stop that follows would be refused. See _sellGate.
  const gate = _passSellGate() || await _sellGate(bridge, userId);
  if (!gate.allowed) return { cancelled: [], held: gate.reason };
  try {
    const orders = await bridge.getIBKROpenOrders(userId);
    const canceled = [];
    for (const o of (orders || [])) {
      // Cancel WORKING and PARKED stops alike: the resize path calls this to clear
      // duplicates, and a parked/unknown-status duplicate it fails to remove is
      // precisely what accumulated 15 deep. Terminal rows (cancelled/filled) are
      // skipped — cancelling those is a no-op that only burns API calls.
      if (String(o.symbol || '').toUpperCase() === sym && o.orderId && !STOP_TERMINAL.test(String(o.status || ''))) {
        await bridge.cancelIBKROrder(userId, o.orderId);
        canceled.push(String(o.orderId));
      }
    }
    // Settle before selling (#3407): wait (bounded) until cancelled ids leave the working book, because the
    // broker keeps the shares reserved while a cancel is pending. (H25)
    for (let attempt = 0; canceled.length && attempt < 3; attempt++) {
      const open = await bridge.getIBKROpenOrders(userId).catch(() => null);
      if (!Array.isArray(open)) break;                       // unreadable → don't spin
      // STOP_WORKING, not !STOP_TERMINAL: 'pending_cancel' CONTAINS 'cancel',
      // so the terminal test reads it as settled — the exact state where the
      // shares are still reserved. Caught by this fix's own test.
      const stillWorking = open.some((o) => canceled.includes(String(o.orderId))
        && STOP_WORKING.test(String(o.status || '')));
      if (!stillWorking) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    return { cancelled: canceled };
  } catch (_e) { /* fail-soft — a missed cancel is caught by the never-short guard */ }
  return { cancelled: [] };
}

/** Stop distance %% for an entry: the signal's ATR/S-R plan stop when enabled and
 * sane, clamped to [min,max]; else the flat stopPct fallback. */
function stopDistPctFor(price, plan, c, sym) {
  const scale = (sym && c.stopScale && c.stopScale.get(String(sym).toUpperCase())) || 1;
  if (c.atrStops && plan && Number(plan.stop) > 0 && Number(price) > 0) {
    const d = ((price - Number(plan.stop)) / price) * 100;
    if (d > 0) return Math.min(c.atrStopMaxPct, Math.max(c.atrStopMinPct, d * scale));
  }
  return c.stopPct * scale;
}

/** Protective stop trigger price for a long entry: `stopPct` below entry. */
function stopPriceFor(entry, stopPct) {
  const e = Number(entry);
  if (!(e > 0)) return null;
  return Math.round(e * (1 - Math.max(0.1, stopPct) / 100) * 100) / 100;
}

// Position size in whole shares. Pure + exported for tests.
//   base notional = min(equity · positionPct%, maxNotional)
//   notional      = base · sizeMult (conviction, 0.5–1.5)
//   qty           = clamp(floor(notional / price), 1, maxQty), re-capped so qty·price ≤ maxNotional.
// Returns 0 when unpriced/negative — the caller then skips. (H26)
function sizePosition({ equity, price, sizeMult = 1, positionPct = DEFAULTS.positionPct, maxPositionPct = DEFAULTS.maxPositionPct, maxQty = 100000, riskPct = 0, stopDistPct = 0 }) {
  const px = Number(price);
  const eq = Number(equity);
  if (!(px > 0) || !(eq > 0)) return 0;
  const mult = Math.max(0.5, Math.min(1.5, Number(sizeMult) || 1));
  // RISK-BASED (preferred): notional = (equity x risk%) / stopDistance% — every
  // trade carries the SAME risk regardless of symbol or stop width. Conviction
  // still scales it. Falls back to notional sizing when risk/stop are unknown.
  if (riskPct > 0 && stopDistPct > 0) {
    const riskDollars = eq * (riskPct / 100) * mult;
    const capNotionalR = eq * (maxPositionPct / 100);
    const wanted = Math.min(riskDollars / (stopDistPct / 100), capNotionalR);
    let q = Math.floor(wanted / px);
    q = Math.max(0, Math.min(q, maxQty));
    while (q > 0 && q * px > capNotionalR) q -= 1;
    return q;
  }
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
// Adopted hold clock: max_hold's clock for a position with no recorded entry time. Kept separate from
// _entryAt so adoption never makes an old position look freshly entered to other rules. (H27)
const _holdClockAt = new Map();  // sym -> ts max_hold first SAW an untracked position
const _dirStreak = new Map();   // sym -> { dir, count, at } (signal-persistence filter)
const _peak = new Map();        // sym -> highest price seen since entry (trailing stop)
const _trough = new Map();      // sym -> lowest price seen since entry (MAE capture, #3241)
// sym -> { peak, trough, stopDistPct } frozen at exit-order placement, because the
// live maps are cleared there while the fill row is only written later, at broker
// reconcile — without this snapshot every closeLong exit would log null excursions.
const _excursion = new Map();
const _exitAt = new Map();      // sym -> ts of the last exit attempt (don't re-fire while an exit may be resting)
const _exitFailures = new Map();  // sym -> consecutive terminal exit failures
const _unclosable = new Set();    // syms declared unclosable (logged once, no re-attempts)
const _unclosableAt = new Map();  // sym -> ts frozen; after TRADER_UNCLOSABLE_RETRY_MIN the freeze
                                  //   lifts for ONE clean retry cycle (a transient order-path outage
                                  //   must not strand a position's exits until it leaves the book)
const _exitNoOrder = new Map();   // sym -> consecutive scans an IN-FLIGHT exit had NO live sell at
                                  //   the broker (freeze-expiry needs two misses so a fill racing
                                  //   the positions snapshot can't unfreeze into a double-sell)
const _loggedFills = new Set();   // broker order ids already written to the ledger
const _ordersSeenWorking = new Map();   // broker order id -> the last scan that saw it WORKING (the fill-time guard, fill-ledger.js)
// Fills older than this process are not reconciled: after a restart the entry
// price is not in memory, so back-filling only produces pnl:null noise (observed
// 2026-08-07). Their ids are still remembered, so they can never resurface.
const _PROCESS_START = Date.now();
const _exitIntent = new Map();    // sym -> reason for the exit we just ordered (labels the fill row)
const fillLedger = require('./fill-ledger');
const MAX_EXIT_FAILURES = 3;      // structural failure (e.g. fractional-only qty) -> stop
// How long an unclosable freeze holds before one clean retry cycle (default 60 min). (H28)
const _unclosableRetryMs = () => Math.max(5, parseFloat(process.env.TRADER_UNCLOSABLE_RETRY_MIN) || 60) * 60000;
const _stopDistPct = new Map(); // sym -> protective-stop distance % at entry (ATR stops make it per-trade)
// Post-stop re-entry cooldown: after a stop fills, the symbol is barred for the rest of that session plus
// TRADER_STOP_COOLDOWN_DAYS trading days. sym -> ET date (inclusive) through which entries are refused. (H29)
const _stopCooldownThrough = new Map();
// Daily circuit breaker: once TRADER_STOP_BREAKER stop fills land in one ET session, entries are refused
// for the rest of it. (H30)
let _stopFillsDay = null;   // ET date the counter belongs to
let _stopFillsCount = 0;    // stop fills observed that date
function _noteStopFill(ts) {
  const d = _etDate(ts);
  if (_stopFillsDay !== d) { _stopFillsDay = d; _stopFillsCount = 0; }
  _stopFillsCount++;
}
function _breakerTripped(now, k) {
  return k > 0 && _stopFillsDay === _etDate(now) && _stopFillsCount >= k;
}
// Stop attribution threshold (#3281): an external close that gave up >= this fraction of its stop distance
// arms the cooldown + breaker as a stop. <= 0 disables (the explicit > 0 guard at the use site matters:
// `loss <= -(pct * 0)` would attribute every loss).
// _lastConfirmedHold (#3282): sym -> ms the broker last reported it held. Cleared by any exit row (logTrade);
// otherwise it is the reason to distrust a flat reading (feed dropout -> double-size re-entry). (H31)
const _lastConfirmedHold = new Map();
// How long a confirmed holding keeps vetoing an unexplained flat reading. Long
// enough to cover a real dropout (the live one lasted 3.5 minutes), short enough
// that a symbol can never be barred indefinitely by stale state.
function _flatConfirmMs() {
  const raw = process.env.TRADER_FLAT_CONFIRM_SEC;
  if (raw == null || String(raw).trim() === '') return 600000;   // 10 min
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v * 1000 : 600000;
}
// Entries wait out a book that lost positions (review H3): a successful read that came back short with no
// exit on record is kept for exits but stalls entries (sizing and caps would read the dropout as room).
// Per account, bounded by the same window as #3282. (H32)
const _trustedBook = new Map();   // user -> { held: Set<symbol>, suspectSince: ms or 0 }
function _entriesWaitOnBook(userId, heldQty, explained, now) {
  const k = String(userId || '');
  const tb = _trustedBook.get(k) || { held: new Set(), suspectSince: 0 };
  const cur = new Set(Object.keys(heldQty || {}).filter((s) => Number(heldQty[s]) >= 1));
  const lost = [...tb.held].filter((s) => !cur.has(s) && !explained(s));
  const suspect = (cur.size === 0 && lost.length > 0) || (lost.length >= 3 && lost.length > cur.size);
  const ttl = _flatConfirmMs();
  if (suspect && ttl > 0) {
    const started = !tb.suspectSince;
    if (started) tb.suspectSince = now;
    if (now - tb.suspectSince <= ttl) {
      _trustedBook.set(k, tb);
      return { wait: true, started, lost,
        why: `entries wait — ${lost.join(', ')} left the book with no exit or fill on record (${Math.round((now - tb.suspectSince) / 1000)}s ago); a feed dropout, not free room` };
    }
  }
  _trustedBook.set(k, { held: cur, suspectSince: 0 });
  return { wait: false, started: false, lost, why: '' };
}
function _stopAttribFrac() {
  const raw = process.env.TRADER_STOP_ATTRIB_FRAC;
  // An EMPTY value means "unset", not 0. `Number('')` is 0, so a stray
  // `TRADER_STOP_ATTRIB_FRAC=` line in .env would otherwise silently switch a
  // tail defense off — the same silent-inert failure this whole fix is about.
  if (raw == null || String(raw).trim() === '') return 0.9;
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0.9;
}
function _etDate(ts) { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
// Stress multiplier (#3428; Nagel 2012): size UP when the tape is stressed. Either condition arms it (OR);
// scales both the risk target and the notional cap; entries only.
//   TRADER_STRESS_MULT     multiplier (default 1.5 = ON; <= 1 disables)
//   TRADER_STRESS_VIX      prior-session VIX close at/above which it applies (default 25)
//   TRADER_STRESS_SPY_IBS  SPY session IBS at/below which it also arms (default 0 = leg off) (H33)
function _stressCfg() {
  const raw = process.env.TRADER_STRESS_MULT;
  const mult = raw === undefined || String(raw).trim() === '' ? 1.5 : Number(raw);
  return { mult: mult > 1 ? Math.min(2.5, mult) : 1,
    vix: process.env.TRADER_STRESS_VIX === undefined ? 25 : Number(process.env.TRADER_STRESS_VIX),
    spyIbsLvl: process.env.TRADER_STRESS_SPY_IBS === undefined ? 0 : Number(process.env.TRADER_STRESS_SPY_IBS) };
}
// Symbol tilt (#3434): TRADER_SYMBOL_SIZE_MULT="SYM:w,SYM:w,..." (unset = flat) scales the risk target and
// the notional cap together; composes with the room tier and stress. Clamped to [0.25, 2]. (H34)
function _symbolSizeMult(sym, spec = process.env.TRADER_SYMBOL_SIZE_MULT) {
  if (!spec || !sym) return 1;
  const want = String(sym).toUpperCase();
  for (const part of String(spec).split(',')) {
    const [s, w] = part.split(':').map((x) => String(x || '').trim());
    if (s.toUpperCase() === want) { const v = Number(w); return Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.25, v)) : 1; }
  }
  return 1;
}
/** Pure: the multiplier and an auditable reason for one entry. */
function _stressMultiplier({ vixPrior, spyIbs } = {}, cfg = _stressCfg()) {
  if (!(cfg.mult > 1)) return { mult: 1, why: null };
  const why = [];
  if (cfg.vix > 0 && Number.isFinite(Number(vixPrior)) && Number(vixPrior) >= cfg.vix) why.push(`VIX ${Number(vixPrior).toFixed(1)} >= ${cfg.vix}`);
  if (cfg.spyIbsLvl > 0 && Number.isFinite(Number(spyIbs)) && Number(spyIbs) <= cfg.spyIbsLvl) why.push(`SPY IBS ${Number(spyIbs).toFixed(2)} <= ${cfg.spyIbsLvl}`);
  return why.length ? { mult: cfg.mult, why: why.join(' & ') } : { mult: 1, why: null };
}
// Prior-session VIX close, cached per ET date; a failed fetch is retried no
// sooner than 10 minutes later and NEVER blocks trading (null = condition unmet).
const _vixCache = { day: null, value: null, triedAt: 0 };
async function _vixPriorClose(now = Date.now()) {
  const day = _etDate(now);
  if (_vixCache.day === day && (_vixCache.value != null || Date.now() - _vixCache.triedAt < 10 * 60 * 1000)) return _vixCache.value;
  _vixCache.day = day; _vixCache.triedAt = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 12 * 86400;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&period1=${p1}&period2=${p2}`,
      { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    const j = await res.json();
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = (r && r.timestamp) || [], closes = (r && r.indicators && r.indicators.quote[0].close) || [];
    let v = null;
    for (let i = ts.length - 1; i >= 0; i--) { if (_etDate(ts[i] * 1000) < day && closes[i] != null) { v = Number(closes[i]); break; } }
    _vixCache.value = Number.isFinite(v) ? v : null;
  } catch (_e) { _vixCache.value = null; }
  return _vixCache.value;
}
// Entry-hour block (#3427): TRADER_ENTRY_BLOCK_ET="13:30-14:30[,HH:MM-HH:MM...]" — ET windows, half-open;
// unset = off. Entries only. (H35)
function _parseEtWindows(spec) {
  return String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]), label: s };
  }).filter((w) => w && w.to > w.from);
}
function _entryHourBlocked(etMin, spec) {
  if (!spec || !(etMin >= 0)) return null;
  return _parseEtWindows(spec).find((w) => etMin >= w.from && etMin < w.to) || null;
}
// No Friday entries: TRADER_NO_FRIDAY_ENTRIES=1 skips new entries on an ET Friday. Off by default. (H36)
function _noFridayEntry(nowMs) {
  if (process.env.TRADER_NO_FRIDAY_ENTRIES !== '1') return false;
  return new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay() === 5;
}
// Per-symbol entry window: TRADER_SYMBOL_ENTRY_BLOCK_ET="SYM,SYM:HH:MM-HH:MM[;...]" — ET, half-open, entries
// only; unset = off. TRADER_SYMBOL_ENTRY_BLOCK_MODE = shadow (default: journal, let through) | live (skip). (H37)
function _parseSymbolWindows(spec) {
  const out = new Map();
  for (const grp of String(spec || '').split(';').map((g) => g.trim()).filter(Boolean)) {
    const i = grp.indexOf(':'); if (i <= 0) continue;
    const syms = grp.slice(0, i).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const wins = _parseEtWindows(grp.slice(i + 1));
    if (!syms.length || !wins.length) continue;
    for (const sym of syms) out.set(sym, (out.get(sym) || []).concat(wins));
  }
  return out;
}
function _symbolEntryBlocked(sym, etMin, spec) {
  if (!spec || !sym || !(etMin >= 0)) return null;
  const wins = _parseSymbolWindows(spec).get(String(sym).toUpperCase());
  return (wins && wins.find((w) => etMin >= w.from && etMin < w.to)) || null;
}
const _symbolEntryBlockLogged = new Set();   // sym:etDay:hour - one journal row per name per hour
function _symbolEntryBlockJournal(sym, etMin, win, mode, now = Date.now()) {
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const key = `${sym}:${day}:${Math.floor(etMin / 60)}`;
  if (_symbolEntryBlockLogged.has(key)) return false;
  _symbolEntryBlockLogged.add(key);
  logTrade({ event: mode === 'live' ? 'symbol_entry_block' : 'symbol_entry_block_shadow', symbol: sym, et_min: etMin, window: win.label, mode, would_block: true });
  return true;
}
// Entry cadence (#3435): entries decide only at bar boundaries (IBS is a CLOSE phenomenon).
// TRADER_ENTRY_CADENCE_MIN=60 (unset/0 = off), _PHASE = boundary minute offset, _WINDOW = minutes allowed after it.
// The first scan after a boundary decides even if late (up to half a bar); a bar never decides twice.
// _cadenceReentryExempt: a symbol already exited THIS session bypasses the cadence gate only (all other gates
// apply) and never spends the bar. Default off: TRADER_CADENCE_REENTRY=1. (H38)
function _cadenceReentryExempt(sym, nowMs) {
  if (process.env.TRADER_CADENCE_REENTRY !== '1') return false;
  const ea = Number(_exitAt.get(sym)) || 0;
  if (!ea) return false;
  return _etDateStr(ea) === _etDateStr(nowMs);   // same ET session only
}
// A spent bar survives a restart: persisted with the state; the gate ignores a mark from another ET day. (H39)
let _cadenceDecided = { day: null, boundary: null };   // the boundary whose decision was SPENT (an entry placed)
let _pendingCadence = { day: null, boundary: null };   // the boundary this scan is deciding for; promoted only when an entry places
// The bar's decision is spent when the window closes, not on the first fill, so every eligible name competes
// on rank inside the window; outside it (late first scan) the first placement spends the bar. (H40)
function _markCadenceDecided() {
  if (!_pendingCadence.day) return;
  if (_pendingCadence.since != null && _pendingCadence.win != null
      && _pendingCadence.since < _pendingCadence.win) return;   // still inside the decision window — let the rest compete
  _cadenceDecided = { day: _pendingCadence.day, boundary: _pendingCadence.boundary };
  _saveState();   // a restart inside this bar must find it spent
}

// Session IBS of a signal: scan.js puts it on decision_context.ibs (there is no top-level s.ibs). Read both,
// preferring an explicit top-level value. (H41)
function _signalIbs(s) {
  if (!s) return null;                                   // Number(null) is 0 — a nullish signal must not read as IBS 0
  const top = Number(s.ibs);
  if (Number.isFinite(top)) return top;
  const ctx = Number(s.decision_context && s.decision_context.ibs);
  return Number.isFinite(ctx) ? ctx : null;
}
const _etDateStr = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const _etMinOf = (ms) => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
// Minutes elapsed in the REGULAR session (09:30-16:00 ET); null outside it.
// The bounce exit reads a session range, so it needs the session to have one.
function _sessionMinutes(now) {
  const e = marketCalendar.etOf(now);
  if (!marketCalendar.inRegularSession(e.day, e.min)) return null;    // outside regular hours: the extended-hours guard already owns this path
  return e.min - 570;
}
function _entryCadenceBlocked(etMin, cadence, phase = 0, window = 3, decided) {
  const k = Math.floor(Number(cadence));
  if (!(k > 0) || !(etMin >= 0)) return null;
  const ph = ((Math.floor(Number(phase) || 0) % k) + k) % k;
  const win = Math.max(1, Math.floor(Number(window)) || 3);
  const since = (((etMin - ph) % k) + k) % k;   // minutes since the last boundary
  const boundary = etMin - since;
  const next = boundary + k;
  const label = `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
  // decided === undefined: plain window semantics (no tracking). decided === null: tracking, nothing decided yet.
  if (decided !== undefined && decided != null && Number(decided) === boundary) return { next, since, boundary, label, why: 'decided' };   // this bar already had its decision scan
  if (since < win) return null;                                                                                   // inside the window
  if (decided !== undefined && since < k / 2) return null;                                                        // tracking: a late first scan of this bar is still its decision
  return { next, since, boundary, label, why: 'between' };
}
function _nextTradingDates(dateStr, n) {
  // dateStr + n trading days (weekend-skipping; holidays just widen the block,
  // which errs on the safe side for a cooldown).
  const d = new Date(dateStr + 'T12:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
// Deferred extended-hours fills: a price-threshold exit that triggers outside RTH still decides there but
// fills at the next regular-hours scan (extended-hours lows usually revert at the open). max_loss is NOT
// deferred (see TRADER_MAX_LOSS_RTH_ONLY). TRADER_EXT_DEFER_EXITS=0 reverts. (H42)
const _deferredExit = new Map();   // sym -> { reason, decidedAt, decidedPx }
const DEFERRABLE = /^(trailing_stop|take_profit|peak_giveback|r2_trail|zone_)/i;
function _extDeferEnabled() { return process.env.TRADER_EXT_DEFER_EXITS !== '0'; }
function _isDeferrableExit(reason) { return DEFERRABLE.test(String(reason || '').trim()); }
// One max_loss_held row per position per ET day, however many passes see it (a new entry
// price is a new position). A restart can write one more row, which is harmless.
const _maxLossHeldNoted = new Map();   // sym -> `${etDate}|${entry}`
function _noteMaxLossHeld(sym, qty, entry, cur, lossPct, c, now, out) {
  if (out) out.skipped.push({ symbol: sym, why: 'max_loss held: past the cap outside regular hours, TRADER_MAX_LOSS_RTH_ONLY lets it act in regular hours only' });
  const k = `${_etDateStr(now)}|${entry}`;
  if (_maxLossHeldNoted.get(sym) === k) return;
  _maxLossHeldNoted.set(sym, k);
  logTrade({ event: 'max_loss_held', symbol: sym, qty, entry, mark: cur, loss_pct: +lossPct.toFixed(2), cap_pct: c.maxLossPct,
    why: 'past the cap outside regular hours: no order, the stop stays, and the first regular-hours pass reads the price of that moment (TRADER_MAX_LOSS_RTH_ONLY)' });
}

const _zoneLadder = new Map();  // sym -> {r1, r1top, r2, broke} — zone-ladder exit state, set at entry (#3165)
const _exitStatus = new Map();  // sym -> broker status of the last exit order (an UNCONFIRMED exit — e.g. needs_confirmation — keeps the symbol frozen from re-exit until the position actually leaves the book)
// sym -> last broker snapshot { qty, entry, mark, ts } while held; what makes an external close
// reconstructable. Persisted. (H43)
const _lastPos = new Map();
// Last basis seen while held: the reconcile falls back to it when a final partial fill empties the book
// before the sweep re-adopts the symbol. (H44)
const _lastBasis = new Map();   // sym -> { entry, ts, openedAt }
// Feed-flap guard (#3378): two consecutive snapshots must agree before anything irreversible.
//   _absentStreak — a tracked position books as externally closed only after missing twice in a row.
//   _seenStreak   — a stateless position is adopted only after being seen held twice in a row. (H45)
const _absentStreak = new Map();
const _seenStreak = new Map();
// FILL-BASIS CHECK (#3407). The entry row logs the decision-time quote; the
// broker's avg basis is only knowable later. sym -> { quote, ts }; when the
// held position first shows a basis differing by >1bp, ONE entry_fill row
// records both numbers (append-only correction, the ledger never mutates).
const _pendingFillBasis = new Map();
// ── LIMIT SHADOW (#3424, journal-only) — on every entry, record hypothetical resting limits at
// LIMIT_SHADOW_DEPTHS under the touch and mark which the price touched. experiments/limit_shadow_score.js
// reads it. TRADER_LIMIT_SHADOW=0 disables. (H46)
const LIMIT_SHADOW_DEPTHS = [0.0025, 0.005, 0.0075, 0.01];
const _limitShadow = new Map();   // sym -> { touch, ts, date, fills: { depth: fillPx|null } }
function _limitShadowArm(sym, price, now) {
  if (process.env.TRADER_LIMIT_SHADOW === '0' || !(price > 0)) return;
  _limitShadow.set(sym, { touch: price, ts: now, date: _etDate(now),
    fills: Object.fromEntries(LIMIT_SHADOW_DEPTHS.map((d) => [String(d), null])) });
}
function _limitShadowTick(sym, cur, now) {
  const sh = _limitShadow.get(sym);
  if (!sh || !(cur > 0)) return;
  if (_etDate(now) !== sh.date) { _limitShadowClose(sym, 'session_end'); return; }   // the limit works the touch session only
  for (const d of LIMIT_SHADOW_DEPTHS) {
    const k = String(d);
    if (sh.fills[k] != null) continue;
    const lvl = +(sh.touch * (1 - d)).toFixed(4);
    if (cur <= lvl) {
      sh.fills[k] = lvl;
      logTrade({ event: 'limit_shadow_fill', symbol: sym, depth: d, touch_px: sh.touch, fill_px: lvl, mark: cur,
        minutes_after_touch: Math.round((now - sh.ts) / 60000) });
    }
  }
}
function _limitShadowClose(sym, why) {
  const sh = _limitShadow.get(sym);
  if (!sh) return;
  logTrade({ event: 'limit_shadow_close', symbol: sym, touch_px: sh.touch, fills: sh.fills, why });
  _limitShadow.delete(sym);
}
// ── ENTRY RE-QUOTE (2026-10-04). TRADER_ENTRY_REQUOTE=shadow fetches a fresh print beside the market
// order and journals entry_requote / entry_fill rows (drift vs the decision quote, what the cap would have done);
// nothing changes an order. Refuse mode: see the placement site. TRADER_ENTRY_REQUOTE_CAP_BPS (default 5). (H47)
const _requoteShadow = new Map();   // sym -> the entry_requote row's numbers, joined into entry_fill
function requoteRead({ decisionPx, freshPx, capBps = 5 }) {
  const d = Number(decisionPx), f = Number(freshPx), cap = Number(capBps);
  if (!(d > 0) || !(f > 0) || !(cap >= 0)) return null;
  const drift = (f / d - 1) * 1e4;                           // + = the price ran up since the decision (worse for a buy)
  return {
    drift_bps: Math.round(drift * 10) / 10,
    cap_bps: cap,
    limit_px: Math.round(f * (1 + cap / 1e4) * 1e4) / 1e4,   // the marketable limit: the fresh quote plus the cap
    would_refuse: drift > cap,                                // the re-quote guard: the move since the decision ate the cap
  };
}
// ── FIRST LOCK (default off): TRADER_FIRST_LOCK="arm:lock" in percent (e.g. "0.5:0.1"), stepped-floor mode
// only. A position up >= arm but below its first whole step gets its stop raised to entry + lock; a lock only
// rises. TRADER_FIRST_LOCK_SYMBOLS restricts it (the lock must clear the name's round-trip cost). (H48)
function _firstLockCfg(sym) {
  const v = String(process.env.TRADER_FIRST_LOCK || '').split(':').map(Number);
  if (!(v.length === 2 && v[0] > 0 && v[1] >= 0 && v[1] < v[0])) return null;
  const only = String(process.env.TRADER_FIRST_LOCK_SYMBOLS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (only.length && !only.includes(String(sym).toUpperCase())) return null;
  return { arm: v[0], lock: v[1] };
}
function _checkFillBasis(sym, brokerEntry) {
  const p = _pendingFillBasis.get(sym);
  if (!p || !(Number(brokerEntry) > 0)) return;
  _pendingFillBasis.delete(sym);
  const q = Number(p.quote);
  if (!(q > 0)) return;
  const bps = Math.abs(brokerEntry / q - 1) * 1e4;
  const rq = _requoteShadow.get(sym); _requoteShadow.delete(sym);
  if (bps <= 1 && !rq) return;                           // same price — nothing to correct (a shadowed entry always gets its row)
  const fill = Number(brokerEntry);
  logTrade({ event: 'entry_fill', symbol: sym, quote_px: q, fill_px: fill,
    delta_bps: Math.round(bps * 10) / 10,
    ...(rq ? { requote_px: rq.requote_px, fill_vs_requote_bps: Math.round((fill / rq.requote_px - 1) * 1e5) / 10,
      limit_px: rq.limit_px, limit_would_fill: fill <= rq.limit_px, cap_bps: rq.cap_bps, would_refuse: rq.would_refuse } : {}) });
}
// Protective-stop registry (#3379): sym -> { id, px, qty, at } of the stop THIS engine placed. Persisted,
// so the per-order status endpoint can answer "did my stop fill?" when the orders feed doesn't show it. (H49)
const _stopOrders = new Map();
// Breakeven ratchet (#3413): sym -> stop level pinned once up TRADER_BE_RATCHET. Never lowered while held;
// cleared when the position leaves. Persisted. (H50)
const _beStopAt = new Map();
const _gapAuction = new Map();   // sym -> ET day its position was handed to the opening auction (gap_stop_to_open, 2026-10-15)
function _registerStop(sym, r, px, qty) {
  if (r && r.order_id && !/error/i.test(String(r.status || ''))) {
    _stopOrders.set(sym, { id: String(r.order_id), px, qty, at: Date.now() });
  }
}
function _round2(n) { return Math.round(n * 100) / 100; }

// An exit whose broker result is non-terminal (resting / queued / needs_confirmation) has not reduced the
// position: don't re-fire it. placed / error / dry_run are terminal. (H51)
function _isExitInFlight(status) {
  return /needs?[_-]?confirm|pending|presubmit|submitted?|working|accepted/i.test(String(status || ''));
}

// ── Persist the trailing state (_peak, timers, registries) across restarts; snapshot each scan, reload at
// boot. Without it a restart resets every peak. (H52)
const STATE_FILE = process.env.TRADER_STATE_FILE
  ? path.resolve(process.env.TRADER_STATE_FILE)
  : require('./app-paths').dataPath('lantern-garage', 'trading', 'trader-state.json');
// Reconcile the ledger against broker fills: an exit row is written when, and only when, a sell actually
// filled, priced at the fill (the broker is the source of truth). (H53)
function _reconcileFills(orders) {
  const done = new Set();
  try {
    const rows = fillLedger.newExitRows(orders, _loggedFills, (sym) => {
      let lp = _lastPos.get(sym);
      // The last partial of a stop that filled in pieces (SMH 2026-10-09, see _lastBasis): the
      // previous partial's row destroyed the state and the book is now empty, so no sweep
      // re-adopted the symbol. The basis seen while it was held is this position's basis, as
      // long as this engine placed no NEWER entry for the symbol since it was recorded.
      if (!lp) {
        const lb = _lastBasis.get(sym);
        if (lb && Number(lb.entry) > 0 && !((_entryAt.get(sym) || 0) > lb.ts)) lp = { entry: lb.entry, basisFrom: 'last_basis', openedAt: lb.openedAt };
      }
      // Excursions (#3241): the placement snapshot when this exit came from
      // closeLong (which clears the live maps), else the live maps — a protective
      // STP fills without ever passing through closeLong.
      const ex = _excursion.get(sym) || { peak: _peak.get(sym) ?? null, trough: _trough.get(sym) ?? null,
        stopDistPct: _stopDistPct.get(sym) ?? null, openedAt: _entryAt.get(sym) ?? null };
      // openedAt rides along for the ledger's process-start guard: a pre-boot fill of a
      // position we are tracking (entry known, filled after it opened) is our exit, not history.
      return { avg_entry_price: lp && lp.entry, reason: _exitIntent.get(sym), openedAt: _entryAt.get(sym) ?? (lp && lp.openedAt) ?? null, ...ex };
    }, _PROCESS_START, { seenWorkingAt: (id) => _ordersSeenWorking.get(String(id)) ?? null });
    for (const row of rows) {
      // Case-insensitive (#3407): IBKR reports 'Stop', Alpaca reports 'stop'.
      // The exact-case compare cost a cooldown on 2026-08-21 — a real Alpaca
      // stop fill classified as plain 'broker fill', re-entry the same minute.
      const _isStopFill = /^stop$/i.test(String(row.order_type || '')) || /(^|\b)stop\b/i.test(String(row.reason || ''));
      // #3413: a ratcheted stop that FILLED at/above entry is a round trip, not a thesis failure (be_ratchet).
      // The map alone is not proof — the fill price must confirm it. (H54)
      if (_isStopFill && _beStopAt.has(row.symbol) && Number(row.exit) >= Number(row.entry) * 0.998) row.be_ratchet = true;
      logTrade(row);
      done.add(row.symbol);
      // The position left the book at this fill: drop it from _lastPos here, or the deferred sweep would later
      // reconstruct a phantom exit at a stale mark. (H55)
      _lastPos.delete(row.symbol); _absentStreak.delete(row.symbol);
      // #3379: a fill row for our registered stop consumes the registry entry —
      // the same-session path (the feed DID show this fill) needs no lookup.
      const _reg = _stopOrders.get(row.symbol);
      if (_reg && String(row.order_id) === _reg.id) _stopOrders.delete(row.symbol);
      _exitIntent.delete(row.symbol);
      _excursion.delete(row.symbol);   // consumed by the fill row it was frozen for
      // All per-position state dies with the position at this fill (a leaked _peak trail-cut the next entry). (H56)
      _peak.delete(row.symbol); _trough.delete(row.symbol);
      _entryAt.delete(row.symbol); _holdClockAt.delete(row.symbol);
      // A STOP fill arms the re-entry cooldown: today + N trading days.
      const _cdDays = cfg().stopCooldownDays;
      if (_isStopFill) {
        if (row.be_ratchet) {
          // #3413 lab rule, validated with exactly this re-entry policy: a
          // breakeven exit blocks the symbol for the REST OF THE SESSION only,
          // and does NOT feed the daily breaker — the breaker counts real
          // failures, and the loss-reduction lab REJECTED broader stand-downs.
          _stopCooldownThrough.set(row.symbol, _etDate(Date.now()));
          _beStopAt.delete(row.symbol);
        } else {
          _beStopAt.delete(row.symbol);   // a stop fill ends the ratchet either way; never let it mislabel the next position
          if (_cdDays > 0) _stopCooldownThrough.set(row.symbol, _nextTradingDates(_etDate(Date.now()), _cdDays));
          _noteStopFill(Date.now());   // feeds the daily circuit breaker
        }
      }
    }
    for (const id of fillLedger.idsToRemember(orders)) _loggedFills.add(String(id));
  } catch (_e) { /* reconciliation must never break trading */ }
  return done;
}

function _saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      peak: Object.fromEntries(_peak),
      deferredExit: Object.fromEntries(_deferredExit),   // an overnight decision must survive a restart
      trough: Object.fromEntries(_trough),
      excursion: Object.fromEntries(_excursion),   // placement→fill handoff must survive a restart

      entryAt: Object.fromEntries(_entryAt),
      exitAt: Object.fromEntries(_exitAt),
      holdClockAt: Object.fromEntries(_holdClockAt),
      exitStatus: Object.fromEntries(_exitStatus),
      lastOrderAt: Object.fromEntries(_lastOrderAt),
      dirStreak: Object.fromEntries(_dirStreak),
      lastPos: Object.fromEntries(_lastPos),
      // The unclosable freeze (failure count + freeze time) survives a restart; released when the position
      // leaves the book. (H57)
      exitFailures: Object.fromEntries(_exitFailures),
      unclosable: [..._unclosable],
      unclosableAt: Object.fromEntries(_unclosableAt),
      loggedFills: [..._loggedFills].slice(-500),   // bounded: ids only matter within a session
      ordersSeenWorking: Object.fromEntries([..._ordersSeenWorking].slice(-1000)),   // a GTC stop's fill can come after a restart
      zoneLadder: Object.fromEntries(_zoneLadder),
      stopDistPct: Object.fromEntries(_stopDistPct),
      stopCooldownThrough: Object.fromEntries(_stopCooldownThrough),
      stopOrders: Object.fromEntries(_stopOrders),   // #3379: a GTC stop OUTLIVES the process by design
      beStopAt: Object.fromEntries(_beStopAt),       // #3413: the ratchet must not un-ratchet on restart
      gapAuction: Object.fromEntries(_gapAuction),   // a market-on-open hand-off must survive a restart: no stop may be stacked on it
      limitShadow: Object.fromEntries(_limitShadow), // #3424: a restart mid-session must not lose the day's shadow
      stopFills: { day: _stopFillsDay, count: _stopFillsCount },   // breaker survives restarts
      cadenceDecided: { day: _cadenceDecided.day, boundary: _cadenceDecided.boundary },   // a spent entry bar survives restarts
      // A restart DURING a dropout must not hand back a clean slate and let the
      // doubling through on the next scan (#3282).
      lastConfirmedHold: Object.fromEntries(_lastConfirmedHold),
      savedAt: Date.now(),
    }));
  } catch (_e) { /* best-effort — a write failure must never break a scan */ }
}
function _loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(o.peak || {})) _peak.set(k, v);
    for (const [k, v] of Object.entries(o.deferredExit || {})) _deferredExit.set(k, v);
    for (const [k, v] of Object.entries(o.trough || {})) _trough.set(k, v);
    for (const [k, v] of Object.entries(o.excursion || {})) _excursion.set(k, v);
    for (const [k, v] of Object.entries(o.entryAt || {})) _entryAt.set(k, v);
    for (const [k, v] of Object.entries(o.holdClockAt || {})) _holdClockAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitAt || {})) _exitAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitStatus || {})) _exitStatus.set(k, v);
    for (const [k, v] of Object.entries(o.lastOrderAt || {})) _lastOrderAt.set(k, v);
    for (const [k, v] of Object.entries(o.dirStreak || {})) _dirStreak.set(k, v);
    for (const [k, v] of Object.entries(o.lastPos || {})) _lastPos.set(k, v);
    for (const [k, v] of Object.entries(o.exitFailures || {})) _exitFailures.set(k, v);
    for (const s of (o.unclosable || [])) _unclosable.add(s);
    for (const [k, v] of Object.entries(o.unclosableAt || {})) _unclosableAt.set(k, v);
    for (const id of (o.loggedFills || [])) _loggedFills.add(String(id));
    for (const [k, v] of Object.entries(o.ordersSeenWorking || {})) { const t = Number(v); if (Number.isFinite(t)) _ordersSeenWorking.set(k, t); }
    for (const [k, v] of Object.entries(o.zoneLadder || {})) _zoneLadder.set(k, v);
    for (const [k, v] of Object.entries(o.stopDistPct || {})) _stopDistPct.set(k, v);
    for (const [k, v] of Object.entries(o.stopCooldownThrough || {})) _stopCooldownThrough.set(k, v);
    for (const [k, v] of Object.entries(o.stopOrders || {})) _stopOrders.set(k, v);   // #3379: GTC stops outlive the process
    for (const [k, v] of Object.entries(o.beStopAt || {})) _beStopAt.set(k, v);       // #3413
    for (const [k, v] of Object.entries(o.gapAuction || {})) _gapAuction.set(k, v);
    for (const [k, v] of Object.entries(o.limitShadow || {})) _limitShadow.set(k, v); // #3424
    if (o.stopFills && o.stopFills.day) { _stopFillsDay = o.stopFills.day; _stopFillsCount = Number(o.stopFills.count) || 0; }
    if (o.cadenceDecided && o.cadenceDecided.day && Number.isFinite(Number(o.cadenceDecided.boundary)) && o.cadenceDecided.boundary !== null) {
      _cadenceDecided = { day: String(o.cadenceDecided.day), boundary: Number(o.cadenceDecided.boundary) };
    }
    for (const [k, v] of Object.entries(o.lastConfirmedHold || {})) {
      const t = Number(v);
      if (Number.isFinite(t)) _lastConfirmedHold.set(k, t);
    }
  } catch (_e) { /* no snapshot yet / unreadable → start fresh */ }
}
_loadState();

// Operator hold pin (#3318): a pinned symbol keeps every protective exit (stop, ladder, breaker) but
// signal-derived exits (signal_exit, momentum_died) are suppressed with a skip row. Sources, unioned:
// TRADER_PIN (SYM1,SYM2) and pins.json beside the ledger ({"pins":["GLD"]}, re-read on a 2s mtime cache). (H58)
const PIN_FILE = process.env.TRADER_PIN_FILE
  ? path.resolve(process.env.TRADER_PIN_FILE)
  : path.join(path.dirname(TRADES_LOG), 'pins.json');
let _pinCache = { at: 0, set: new Set() };
// SPY's regular-session move today: % from the first 5m close to the latest bar at or before `now` (the carry-on-a-
// down-day gate). One fetch per scan; null when the feed has fewer than two regular bars, and the gate then stands
// aside (the de-carry runs as before).
let _spyMoveAt = 0, _spyMoveV = null;
async function _spySessionMovePct(now) {
  if (_spyMoveAt === now) return _spyMoveV;
  let v = null;
  try {
    const bm = await yahoo.getBarsMulti(['SPY'], '5m');
    const bars = (bm && bm.bars && bm.bars.SPY && bm.bars.SPY.bars) || [];
    const et = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const today = et(now).toDateString();
    const reg = [];
    for (const b of bars) {
      const t = Date.parse(b.timestamp || b.t || b.time); if (!Number.isFinite(t) || t > now) continue;
      const d = et(t); if (d.toDateString() !== today) continue;
      const x = marketCalendar.etOf(t); if (!marketCalendar.inRegularSession(x.day, x.min)) continue;
      reg.push(Number(b.close));
    }
    if (reg.length >= 2 && reg[0] > 0 && reg[reg.length - 1] > 0) v = (reg[reg.length - 1] / reg[0] - 1) * 100;
  } catch (_e) { v = null; }
  _spyMoveAt = now; _spyMoveV = v;
  return v;
}

function _isPinned(sym) {
  const now = Date.now();
  if (now - _pinCache.at > 2000) {
    const set = new Set(String(process.env.TRADER_PIN || '')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
    try {
      const j = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
      for (const s of (Array.isArray(j) ? j : (j && j.pins) || [])) set.add(String(s).toUpperCase());
    } catch (_e) { /* no pin file → env only */ }
    _pinCache = { at: now, set };
  }
  return _pinCache.set.has(String(sym || '').toUpperCase());
}

// How many held rows in a position snapshot does this engine have NO state for? Pure. (#3378) (H59)
function snapshotForeignRows(rows, isKnown) {
  return (rows || []).filter((p) => Math.abs(Number(p && p.qty) || 0) > 0
    && !isKnown(String((p && p.symbol) || '').toUpperCase())).length;
}

/** Round for the ledger — MACD histograms live in the third decimal. */
const r4 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e4) / 1e4 : null);

// The knife READING, not just its verdict — { hist, prev, fires } or null — so the skip row records the
// two numbers the gate decided on (an offline rebuild only reproduces ~70% of fires). (H60)
// isFallingKnife (below) = that reading fires: MACD hist < 0 AND still falling. Fail-open on thin data.
function knifeReading(closes) {
  if (!Array.isArray(closes) || closes.length < 36) return null;     // need 2 MACD reads
  const now = macd(closes);
  const prev = macd(closes.slice(0, -1));
  if (!now || !prev) return null;
  return { hist: now.histogram, prev: prev.histogram,
    fires: now.histogram < 0 && now.histogram < prev.histogram };    // negative AND deepening
}

function isFallingKnife(closes) {
  const r = knifeReading(closes);
  return !!(r && r.fires);
}

// Trading sessions between two instants, ET: weekends AND weekday holidays skipped (the exchange calendar,
// 2026-10-26 — before it a holiday counted as a session, so a Wednesday buy "aged" on Thanksgiving and its max_hold
// sale went into a closed market). Entry day is session 0, so Mon -> next Mon = 5, matching the lab's
// `si >= entrySi + timeoutS` semantics.
function _sessionsHeld(entryMs, nowMs) {
  return marketCalendar.sessionsBetween(marketCalendar.etOf(entryMs).day, marketCalendar.etOf(nowMs).day);
}

// Reversal confirmation read (TRADER_ENTRY_CONFIRM). Pure. Judges TODAY's regular session only.
//   n=1  the last close is above the one before it
//   n=2  two rising closes AND no lower low between them (H61)
function _entryConfirmRead(bars, n, nowMs, shape = false) {
  const need = n + 1;                                  // n rising closes need n+1 bars
  const et = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
  const sess = [];
  for (const b of bars) {
    const d = new Date(new Date(b.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const bd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (bd !== day) continue;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m < 570 || m > 960 - marketCalendar.closeOffset(bd)) continue;   // regular session only (to 13:00 on an early close)
    if (Number(b.close) > 0) sess.push(b);
  }
  const closes = sess.slice(-need).map((b) => +Number(b.close).toFixed(4));
  // ── V-bottom fast-track (shape mode): a capitulation bar (range >= 1.5x the prior ~6 bars' average) then
  // one strong reclaim bar (rising, bar-IBS >= 0.6, back above half the capitulation range, no new low)
  // confirms at once. ── (H62)
  if (shape && sess.length >= 4) {
    const scan = sess.slice(-10);
    let li = 0; for (let i = 1; i < scan.length - 1; i++) if (Number(scan[i].low) < Number(scan[li].low)) li = i;
    const lowBar = scan[li];
    if (li < scan.length - 1) {
      const before = scan.slice(Math.max(0, li - 6), li);
      const avgRange = before.length >= 3 ? before.reduce((s, b) => s + (Number(b.high) - Number(b.low)), 0) / before.length : 0;
      const lowRange = Number(lowBar.high) - Number(lowBar.low);
      const b1 = scan[scan.length - 1];
      const prevClose = scan.length >= 2 ? Number(scan[scan.length - 2].close) : Number(lowBar.close);
      const rising = Number(b1.close) > prevClose;
      const barIbs = (Number(b1.close) - Number(b1.low)) / Math.max(Number(b1.high) - Number(b1.low), 1e-9);
      const reclaim = (Number(b1.close) - Number(lowBar.low)) / Math.max(lowRange, 1e-9);
      const noNewLow = Number(b1.low) >= Number(lowBar.low);
      if (avgRange > 0 && lowRange >= 1.5 * avgRange && rising && barIbs >= 0.6 && reclaim >= 0.5 && noNewLow) {
        return { ok: true, why: `V-bottom fast-track (capitulation ${(lowRange / avgRange).toFixed(1)}x avg range, reclaim ${(reclaim * 100).toFixed(0)}%, bar-IBS ${barIbs.toFixed(2)})`, closes };
      }
    }
  }
  if (sess.length < need) return { ok: false, why: `only ${sess.length} session bar(s) — cannot confirm a turn yet`, closes };
  const w = sess.slice(-need);
  for (let i = 1; i < w.length; i++) {
    if (!(w[i].close > w[i - 1].close)) return { ok: false, why: 'closes not rising — no turn yet', closes };
  }
  if (n >= 2) {
    // "no new low between": the turn bar must not have undercut the prior bar's low
    const last = w[w.length - 1], prev = w[w.length - 2];
    if (Number(last.low) < Number(prev.low)) return { ok: false, why: 'rising close but a NEW LOW under it — a bump, not a turn', closes };
  }
  // ── WEAK-TURN VETO (shape mode): rising closes that reclaimed almost nothing
  //    of the drop are bumps ("repeating pattern"), not a turn — refuse. ──
  if (shape) {
    const pre = sess.slice(-need - 8, -need);
    const swingHigh = pre.length ? Math.max(...pre.map((b) => Number(b.high))) : 0;
    const winLow = Math.min(...w.map((b) => Number(b.low)).filter((x) => x > 0));
    const drop = swingHigh - winLow;
    const reclaimed = Number(w[w.length - 1].close) - winLow;
    if (drop > 0 && reclaimed / drop < 0.25) {
      return { ok: false, why: `turn too weak — reclaimed ${(100 * reclaimed / drop).toFixed(0)}% of the drop (drift, not a turn)`, closes };
    }
  }
  return { ok: true, why: 'confirmed', closes };
}

// Ratcheting trailing-stop distance: the more a winner has run, the tighter we protect it.
// Returns the %-drop-from-peak that triggers the exit, always ≤ the base. (H63)
function trailTriggerPct(peakGainPct, base) {
  if (peakGainPct >= 25) return Math.min(base, 1.25);   // huge winner → lock tight
  if (peakGainPct >= 12) return Math.min(base, 1.75);
  if (peakGainPct >= 6) return Math.min(base, 2.25);
  return base;                                            // small gain → base (room to develop)
}

// An exit refused for RESERVED shares ("insufficient qty available") is retried, not abandoned: the broker
// created no order, so wait, re-run the (idempotent) cancel, and sell again — bounded. Only this explicit
// refusal is retried; any other error keeps the old path, because an order may exist behind it. (H64)
const _QTY_RESERVED_RE = /insufficient (qty|quantity)|qty_available|held_for_orders/i;
function _isQtyReservedReject(r) {
  return !!(r && /error|reject/i.test(String(r.status || '')) && _QTY_RESERVED_RE.test(String(r.reason || r.error || r.message || '')));
}
const _exitKeptOpen = new Set();   // symbols whose exit was refused THIS scan: still held, never re-bought by the entry loop
async function _sellAfterCancel(bridge, userId, sym, order) {
  await cancelRestingStops(bridge, userId, sym);
  let r = await bridge.placeIBKROrder(userId, order).catch((e) => ({ status: 'error', reason: e.message }));
  const maxRetries = Math.max(0, Number(process.env.TRADER_EXIT_QTY_RETRIES ?? 3) || 0);
  const waitMs = Math.max(0, Number(process.env.TRADER_EXIT_QTY_RETRY_MS ?? 1000) || 0);
  let retries = 0;
  while (_isQtyReservedReject(r) && retries < maxRetries) {
    retries++;
    await new Promise((res) => setTimeout(res, waitMs));
    await cancelRestingStops(bridge, userId, sym);
    r = await bridge.placeIBKROrder(userId, order).catch((e) => ({ status: 'error', reason: e.message }));
  }
  return { r, retries, reserved: _isQtyReservedReject(r) };
}
// Still refused after the retries: keep every per-position clock and leave _exitAt unset so the next scan
// retries at once; the error status still feeds the MAX_EXIT_FAILURES backoff. (H65)
function _keepOpenAfterReservedReject(sym, qty, hp, reason, r, retries, refPrice, out, now, extraExecuted = {}) {
  _exitStatus.set(sym, r && r.status);
  _lastOrderAt.set(sym, now);
  _exitKeptOpen.add(sym);
  logTrade({ event: 'exit_intent', symbol: sym, qty, entry: hp.avg_entry_price ?? null, mark: hp.current_price ?? null, reason, status: r && r.status,
    ref_px: Number(refPrice) > 0 ? Number(refPrice) : null,
    error: (r && (r.reason || r.error)) || null, retries, kept_open: true,
    why: 'the broker still held the shares for the cancelled stop -- no order exists; position and its clocks kept, the next scan retries' });
  if (out) out.executed.push({ ...extraExecuted, symbol: sym, action: 'exit_long', qty, reason, result: r });
  return { ...(r || {}), keptOpen: true };
}

/** Close a held long at market: cancel its resting stop, clear per-symbol state,
 *  log the realized outcome, and record it on `out`. Shared by every exit path. */
async function closeLong(bridge, userId, sym, qty, hp, reason, out, now, { extended = false, refPrice = 0 } = {}) {
  // Outside RTH a gain-protecting exit records its decision and fills at the open.
  if (extended && _extDeferEnabled() && _isDeferrableExit(reason)) {
    // Decided on an earlier pass: the fill still waits for the open. This used to fall
    // through and sell on the SECOND extended-hours check (review H2, 2026-09-29), the
    // very dark fill the deferral exists to avoid.
    if (_deferredExit.has(sym)) {
      if (out) out.skipped.push({ symbol: sym, why: `exit_deferred: ${reason} — already decided, filling at the open` });
      return;
    }
    _deferredExit.set(sym, { reason, decidedAt: now, decidedPx: Number(refPrice) || null });
    _saveState();
    logTrade({ event: 'exit_deferred', symbol: sym, qty,
      entry: hp && hp.avg_entry_price != null ? hp.avg_entry_price : null,
      mark: Number(refPrice) || null, reason,
      why: 'extended hours: decision stands, fill deferred to the regular open — extended lows revert 79-88% of the time (2026-08-26)' });
    if (out) out.skipped.push({ symbol: sym, why: `exit_deferred: ${reason} — filling at the open` });
    return;
  }
  // Whole-share exits: the broker rejects fractional sells, so 300.8 sells 300; sub-1 positions keep their
  // raw qty and are the unclosable freeze's job. (H66)
  if (Number(qty) >= 1) qty = Math.floor(Number(qty));
  // RTH: market SELL. Pre/post: marketable LIMIT ~0.2% under the last print with outsideRTH. acceptWarnings:
  // this path only ever sells an existing long, so a broker warning must not leave it unfilled. (H67)
  const order = (extended && refPrice > 0)
    ? { ticker: sym, side: 'sell', qty, type: 'limit', limitPrice: Math.round(refPrice * 0.998 * 100) / 100, outsideRth: true, acceptWarnings: true }
    : { ticker: sym, side: 'sell', qty, type: 'market', acceptWarnings: true };
  // Cancel the resting stop BEFORE selling (sell-first tripped the broker's oversell protection). If the sell
  // then errors, the fast-exit tick re-attaches the stop — unless orders cannot go out (review H1), in which
  // case leave the position, its stop and its exit state untouched. (H68)
  const _gate = _passSellGate() || await _sellGate(bridge, userId);
  if (!_gate.allowed) {
    if (out) out.skipped.push({ symbol: sym, why: `exit held (${reason}) — ${_gate.reason}` });
    return { status: 'held', reason: _gate.reason };
  }
  // A real exit supersedes a decision deferred to the open; left in place, the open's
  // flush would sell the same shares a second time.
  if (_deferredExit.delete(sym)) _saveState();
  const { r, retries, reserved } = await _sellAfterCancel(bridge, userId, sym, order);
  if (reserved) return _keepOpenAfterReservedReject(sym, qty, hp, reason, r, retries, refPrice, out, now);
  // Freeze the excursion run BEFORE clearing per-symbol state — the fill row that
  // needs it is only written later, at broker reconcile (#3241).
  _excursion.set(sym, { peak: _peak.get(sym) ?? null, trough: _trough.get(sym) ?? null, stopDistPct: _stopDistPct.get(sym) ?? null,
    // When the position was opened (#3558). Known all along -- it drives the min-hold
    // and maturity gates -- and thrown away at the exit, so nothing downstream could
    // say how long a trade was held. Snapshotted here for the same reason the
    // excursions are: closeLong clears the live maps before the fill reconciles.
    openedAt: _entryAt.get(sym) ?? null });
  _entryAt.delete(sym); _holdClockAt.delete(sym); _peak.delete(sym); _trough.delete(sym); _lastOrderAt.set(sym, now); _exitAt.set(sym, now);
  _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
  _exitIntent.set(sym, reason);
  logTrade({ event: 'exit_intent', symbol: sym, qty, entry: hp.avg_entry_price ?? null, mark: hp.current_price ?? null, reason, status: r && r.status,
    // the quote the exit was decided on (2026-10-09): exit slippage = ref_px vs the fill, as quote_px vs fill_px on entries
    ref_px: Number(refPrice) > 0 ? Number(refPrice) : null,
    // #3407: keep the broker's words — status:'error' alone cost a diagnosis round trip on 08-21
    error: (r && /error/i.test(String(r.status || '')) && (r.reason || r.error)) || null,
    ...(retries ? { retries } : {}) });
  out.executed.push({ symbol: sym, action: 'exit_long', qty, reason, result: r });
  return r;
}

// Exit held LONGS on their own merits every scan, independent of new signals:
//   1. take-profit  — hard +% target (off by default).
//   2. trailing stop — once up ≥ trailArmPct, close if price falls trailPct from the PEAK.
//   3. momentum death — while in profit, close when MACD hist < 0 and price < short EMA.
// Closed symbols are removed from `heldQty` so the entry loop doesn't re-touch them. (H69)
async function manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended = false, workingSells = new Set(), exclude = new Set(), protectiveOnly = false }) {
  // Flush deferred exits at the first regular-hours scan, before any other exit rule. (H70)
  // Sub-share dust never exits (qty < 1 cannot fill). Safety exits deliberately run on whatever the account
  // truly holds — the foreign-book problem is handled upstream (account pin + foreign-snapshot tell). (#3378)
  if (!extended && _deferredExit.size) {
    for (const [sym, d] of [..._deferredExit.entries()]) {
      const p = heldPos[sym];
      const dq = Math.floor(Number(p && p.qty) || 0);
      _deferredExit.delete(sym);
      if (!(dq >= 1) || exclude.has(sym) || workingSells.has(sym)) continue;    // gone by other means, not ours, or a sell already resting
      await closeLong(bridge, userId, sym, dq, p, `${d.reason} [deferred from extended hours]`, out, now, { extended: false });
      delete heldQty[sym];
    }
    _saveState();
  }
  const longs = Object.entries(heldPos).filter(([, p]) => (Number(p.qty) || 0) >= 1);
  if (!longs.length) return;

  // Recent bars for the momentum-death read — one batched fetch for all held longs
  // (fail-soft). Default 5m so a fading winner's trend-rollover is caught ~3× sooner
  // than the old 15m read (nearer the peak); TRADER_MOMENTUM_TF overrides.
  let bars = {};
  if (c.momentumExit) {
    try { const bm = await yahoo.getBarsMulti(longs.map(([s]) => s), c.momentumTf); bars = (bm && bm.bars) || {}; } catch (_e) { bars = {}; }
  }

  for (const [sym, p] of longs) {
    if (exclude.has(sym)) continue;               // another engine (overnight book) owns this position
    const qty = Number(p.qty) || 0;
    const cur = Number(p.current_price) || 0;
    const entry = Number(p.avg_entry_price || p.avg_fill_price) || 0;
    if (!(qty > 0) || !(cur > 0) || !(entry > 0)) continue;
    _limitShadowTick(sym, cur, now);               // #3424: journal-only, never affects an exit

    // Oversell guard: an exit sell is already resting for this symbol → don't stack another.
    if (workingSells.has(sym)) continue;

    // EOD DE-CARRY (#3298 finding 3): from 15:50 ET, leveraged holdings go flat
    // into the close — stops cannot protect through a gap, and 3x carries 3x the
    // overnight exposure at equal notional (64% of the 8/13→14 give-back was the
    // gap). The operator's pin overrides: a pinned symbol is a deliberate carry.
    if (c.eodDecarry && c.decarrySyms.has(sym) && qty >= 1 && !extended) {
      const _dm = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
      const _dOff = marketCalendar.closeOffset(marketCalendar.etOf(now).day);   // 180 on a 13:00 close: flat from 12:50/12:55
      if (_dm >= c.decarryMin - _dOff && _dm < 960 - _dOff) {
        const _cdd = c.carryDownDayPct < 0 && c.carryDownDaySyms.has(sym) ? await _spySessionMovePct(now) : null;
        if (_cdd != null && _cdd <= c.carryDownDayPct) {
          out.skipped.push({ symbol: sym, price: cur, qty, why: `carry_downday — eod_decarry suppressed: SPY ${_cdd.toFixed(2)}% on the session (at or below ${c.carryDownDayPct}%); the inverse breakdown rides the gap (ledger tier0-inverse-carry-gated-by-entry-day)` });
          _planCarryNote(sym, _cdd, now);   // the plan watchdog moves this trade's exit time to the next session (journal only)
        } else if (_isPinned(sym)) {
          out.skipped.push({ symbol: sym, why: 'pinned — eod_decarry suppressed by operator (#3318); carrying overnight deliberately' });
        } else {
          const _ea = _exitAt.get(sym) || 0;
          if (!(_ea && (now - _ea) < c.exitReattemptMs)) {
            await closeLong(bridge, userId, sym, qty, p, 'eod_decarry (leveraged overnight gap risk #3298) — flat into the close', out, now, { extended, refPrice: cur });
            delete heldQty[sym]; continue;
          }
        }
      }
    }

    // MAX-HOLD TIMEOUT — see cfg.maxHoldSessions. The lab's timeoutS, finally in the
    // engine. Same discipline as eodFlat: regular hours only, the eod window, pinned
    // exempt, and a position with no recorded entry time is HELD not sold (a restart
    // that lost state must not liquidate the book — max_loss still backstops it).
    if (c.maxHoldSessions > 0 && qty >= 1 && !extended) {
      let _hEntryAt = _entryAt.get(sym) || _holdClockAt.get(sym);
      if (!_hEntryAt) {
        // untracked position: start the clock NOW, journal it once, and let immunity
        // decay — it becomes mortal N sessions from discovery instead of never.
        _holdClockAt.set(sym, now); _saveState();
        logTrade({ event: 'max_hold_clock_adopted', symbol: sym,
          why: 'no recorded entry time — hold clock starts at discovery; max_hold applies N sessions from here' });
        _hEntryAt = now;
      }
      const _hEt = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const _hMin = _hEt.getHours() * 60 + _hEt.getMinutes();
      const _hOff = marketCalendar.closeOffset(marketCalendar.etOf(now).day);
      if (_hEntryAt && _hMin >= c.eodFlatMin - _hOff && _hMin < 960 - _hOff) {
        const _held = _sessionsHeld(_hEntryAt, now);
        if (_held >= c.maxHoldSessions) {
          if (_isPinned(sym)) {
            out.skipped.push({ symbol: sym, why: `pinned — max_hold suppressed by operator (#3318); held ${_held} sessions deliberately` });
          } else {
            const _ea3 = _exitAt.get(sym) || 0;
            if (!(_ea3 && (now - _ea3) < c.exitReattemptMs)) {
              await closeLong(bridge, userId, sym, qty, p, `max_hold (${_held} sessions ≥ ${c.maxHoldSessions} — the lab's timeoutS, flat into the close)`, out, now, { extended, refPrice: cur });
              delete heldQty[sym]; continue;
            }
          }
        }
      }
    }

    // SESSION-END FLAT — see cfg.eodFlat. Runs after the leveraged de-carry so a
    // de-carry name is already handled; regular hours only (an extended-session
    // mark is not a close), and never against a pinned symbol.
    if ((c.eodFlat === 'weekend' || c.eodFlat === 'all') && qty >= 1 && !extended) {
      const _et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const _fm = _et.getHours() * 60 + _et.getMinutes();
      const _dow = _et.getDay();                       // 5 = Friday, the last session before a weekend
      const _due = c.eodFlat === 'all' || _dow === 5;
      const _fOff = marketCalendar.closeOffset(marketCalendar.etOf(now).day);
      if (_due && _fm >= c.eodFlatMin - _fOff && _fm < 960 - _fOff) {
        if (_isPinned(sym)) {
          out.skipped.push({ symbol: sym, why: 'pinned — eod_flat suppressed by operator (#3318); carrying deliberately' });
        } else {
          const _ea2 = _exitAt.get(sym) || 0;
          if (!(_ea2 && (now - _ea2) < c.exitReattemptMs)) {
            await closeLong(bridge, userId, sym, qty, p, c.eodFlat === 'all'
              ? 'eod_flat (no overnight holds) — flat into the close'
              : 'eod_flat_weekend (no weekend holds, 2026-08-24) — flat into Friday\'s close', out, now, { extended, refPrice: cur });
            delete heldQty[sym]; continue;
          }
        }
      }
    }

    const lossPct = ((cur - entry) / entry) * 100;   // signed P&L% (negative = losing)

    // 0) HARD MAX-LOSS BACKSTOP — exit a long down ≥ maxLossPct regardless of momentum, peak or min-hold (the
    //    net for a missing / gapped-through broker stop). Honors the exit-reattempt debounce.
    //    TRADER_MAX_LOSS_RTH_ONLY=1 (off unless set): outside RTH the cap places nothing and journals
    //    max_loss_held; the first RTH pass re-reads the price. Not a deferral. (H71)
    const _exitAtBackstop = _exitAt.get(sym) || 0;
    const _pastLossCap = c.maxLossPct > 0 && lossPct <= -c.maxLossPct;
    if (_pastLossCap && extended && c.maxLossRthOnly) {
      _noteMaxLossHeld(sym, qty, entry, cur, lossPct, c, now, out);
    } else if (_pastLossCap && !(_exitAtBackstop && (now - _exitAtBackstop) < c.exitReattemptMs)) {
      await closeLong(bridge, userId, sym, qty, p, `max_loss (${lossPct.toFixed(1)}% ≤ -${c.maxLossPct}%)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }

    // Min-hold: never churn a just-opened long — the broker stop still protects it.
    // (The max-loss backstop above deliberately runs BEFORE this — a crashing new position
    //  must be allowed to exit even inside the min-hold window.)
    const entryAt = _entryAt.get(sym) || 0;
    if (entryAt && (now - entryAt) < c.minHoldMs) continue;

    // Exit already fired recently for this symbol? Don't re-fire. An extended-hours exit
    // limit can rest unfilled; without this the loop re-placed the same exit every scan
    // (dozens of phantom "exit" rows + stacked orders on one still-open position). The
    // resting order (or the next fill) will close it — give it time before re-attempting.
    const exitAt = _exitAt.get(sym) || 0;
    if (exitAt && (now - exitAt) < c.exitReattemptMs) continue;

    // ── ZONE-LADDER EXIT (#3165): sell at R1 unless price broke THROUGH the zone (mark > zone top), then hold
    // for R2 with the floor at R1. While the ladder owns a symbol the generic exits below are skipped. (H72)
    const _lad = c.zoneExit ? _zoneLadder.get(sym) : null;
    if (_lad && _lad.r1 > 0) {
      if (!_lad.broke) {
        // PEAK GIVE-BACK (#3165, OOS-validated on the support-entry geometry —
        // holdout PF: SPY 1.32->1.57, QQQ 2.06->2.13): a near-miss of R1 must not
        // round-trip. Track the peak on the way to R1; once >=90% of the distance
        // was reached, a give-back of 40% of the peak gain exits near the peak.
        _lad.zPeak = Math.max(_lad.zPeak || 0, cur);
        const _span = _lad.r1 - entry;
        if (_span > 0 && (_lad.zPeak - entry) / _span >= 0.9) {
          const _gb = entry + 0.6 * (_lad.zPeak - entry);
          if (cur <= _gb) {
            await closeLong(bridge, userId, sym, qty, p, 'peak_giveback (reached ' + Math.round((_lad.zPeak - entry) / _span * 100) + '% of R1, gave back 40% of peak gain)', out, now, { extended, refPrice: cur });
            delete heldQty[sym]; continue;
          }
        }
        if (cur > (_lad.r1top || _lad.r1)) {
          _lad.broke = true; _zoneLadder.set(sym, _lad); _saveState();   // upgraded: R2 target, R1 floor
        } else if (cur >= _lad.r1) {
          await closeLong(bridge, userId, sym, qty, p, `zone_r1 (first resistance ${_lad.r1})`, out, now, { extended, refPrice: cur });
          delete heldQty[sym]; continue;
        }
      } else if (_lad.broke2) {
        // R2-TRAIL (lab-gated 2026-08-08): the runner broke THROUGH R2 — ride it
        // with a ratcheting floor instead of having sold at the target. QQQ
        // 2026-08-07 sold its runner at 720.85 and price closed 723.03.
        _lad.peak2 = Math.max(_lad.peak2 || _lad.r2, cur);
        _lad.floor2 = Math.max(_lad.floor2 || _lad.r2, _lad.peak2 * (1 - c.r2TrailPct / 100));
        _zoneLadder.set(sym, _lad);
        if (cur <= _lad.floor2) {
          await closeLong(bridge, userId, sym, qty, p, `r2_trail (peak ${_lad.peak2.toFixed(2)}, floor ${_lad.floor2.toFixed(2)})`, out, now, { extended, refPrice: cur });
          delete heldQty[sym]; continue;
        }
      } else if (_lad.r2 > 0 && cur >= _lad.r2) {
        if (c.r2Trail) {
          _lad.broke2 = true; _lad.peak2 = cur;
          _lad.floor2 = Math.max(_lad.r2, cur * (1 - c.r2TrailPct / 100));
          _zoneLadder.set(sym, _lad); _saveState();
        } else {
          await closeLong(bridge, userId, sym, qty, p, `zone_r2 (runner target ${_lad.r2})`, out, now, { extended, refPrice: cur });
          delete heldQty[sym]; continue;
        }
      } else if (cur <= _lad.r1) {
        await closeLong(bridge, userId, sym, qty, p, `zone_r1_floor (gave back to ${_lad.r1})`, out, now, { extended, refPrice: cur });
        delete heldQty[sym]; continue;
      }
      continue;   // ladder owns this symbol — skip take-profit / trailing / momentum
    }

    const pnlPct = ((cur - entry) / entry) * 100;
    const peak = Math.max(_peak.get(sym) || 0, cur, entry);   // running high-water mark
    _peak.set(sym, peak);
    // Running low-water mark (#3241): MAE = how far the trade went against us.
    _trough.set(sym, Math.min(_trough.get(sym) || Infinity, cur, entry));
    const peakGainPct = ((peak - entry) / entry) * 100;         // best gain reached
    const dropFromPeakPct = peak > 0 ? ((peak - cur) / peak) * 100 : 0;

    // 1a) R-multiple take-profit — exit at +takeProfitR × risk (risk = stopPct). This
    //     engine's winners don't run: backtests show a tight 1R target beats 2R/3R on
    //     every basket, so bank the gain fast instead of round-tripping it. 1R = +stopPct%.
    const riskPct = _stopDistPct.get(sym) || c.stopPct;   // per-trade stop distance (ATR stops)
    if (c.takeProfitR > 0 && riskPct > 0 && pnlPct >= c.takeProfitR * riskPct) {
      await closeLong(bridge, userId, sym, qty, p, `take_profit_R (+${pnlPct.toFixed(1)}% ≈ ${c.takeProfitR}R @ ${riskPct.toFixed(1)}% risk)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }
    // 1) Hard take-profit (fixed %, off by default).
    if (c.takeProfitPct > 0 && pnlPct >= c.takeProfitPct) {
      await closeLong(bridge, userId, sym, qty, p, `take_profit (+${pnlPct.toFixed(1)}%)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }
    // 2) Trailing stop — only after the position has run up (locks GAINS, not losses).
    //    The trigger ratchets tighter as the peak gain grows (trailTriggerPct), so a
    //    big winner locks in close instead of round-tripping a flat %.
    const trailTrig = trailTriggerPct(peakGainPct, c.trailPct);
    if (c.trailPct > 0 && peakGainPct >= c.trailArmPct && dropFromPeakPct >= trailTrig) {
      await closeLong(bridge, userId, sym, qty, p, `trailing_stop (−${dropFromPeakPct.toFixed(1)}% from peak +${peakGainPct.toFixed(1)}%, trig ${trailTrig}%)`, out, now, { extended, refPrice: cur });
      delete heldQty[sym]; continue;
    }
    // 3) Momentum death — fading winner: MACD histogram negative + below short EMA.
    const _momFloorPct = (c.momentumMinR || 0) * riskPct;   // riskPct = this trade's stop distance
    if (c.momentumExit && pnlPct > 0 && pnlPct >= _momFloorPct) {
      const closes = ((bars[sym] && bars[sym].bars) || []).map((b) => b.close).filter((x) => x > 0);
      if (closes.length >= 30) {
        const m = macd(closes);
        const ema9 = emaSeries(closes, 9);
        const e9 = ema9[ema9.length - 1];
        const last = closes[closes.length - 1];
        const r = rsi(closes);
        // protectiveOnly (extended hours): momentum_died is a SIGNAL read, and
        // MACD/EMA/RSI over thin pre-market bars is noise — never dump a
        // position on it outside regular hours.
        if (m && m.histogram < 0 && last < e9 && (r == null || r < 55) && !protectiveOnly) {
          if (_isPinned(sym)) {
            out.skipped.push({ symbol: sym, why: 'pinned — momentum_died suppressed by operator (#3318); stop/ladder still protect' });
          } else {
            await closeLong(bridge, userId, sym, qty, p, `momentum_died (MACD hist<0, <EMA9${r != null ? `, RSI ${Math.round(r)}` : ''})`, out, now, { extended, refPrice: cur });
            delete heldQty[sym]; continue;
          }
        }
      }
    }
  }
}

// One pass per account at a time (review M1): a scan waits (bounded) for a fast tick in flight on its
// account; a fast tick that finds the account busy skips its turn. Two passes would double-sell. (H73)
const _passInFlight = new Map();   // account key -> promise of the pass running on it
const PASS_WAIT_MS = 30000;
async function _onePassPerAccount(opts, fn, { skipIfBusy = false } = {}) {
  const key = String((opts && (opts.accountId || opts.userId)) || '');
  if (skipIfBusy && _passInFlight.has(key)) {
    return { executed: [], skipped: [], reason: 'another pass is running on this account — skipped this turn' };
  }
  const deadline = Date.now() + PASS_WAIT_MS;
  for (let p = _passInFlight.get(key); p && Date.now() < deadline; p = _passInFlight.get(key)) {
    let timer;
    await Promise.race([p.catch(() => {}), new Promise((r) => { timer = setTimeout(r, Math.max(1, deadline - Date.now())); })]);
    clearTimeout(timer);
  }
  const run = Promise.resolve().then(fn);
  _passInFlight.set(key, run);
  try { return await run; } finally { if (_passInFlight.get(key) === run) _passInFlight.delete(key); }
}
/** The reserve fund's symbols (lib/reserve-fund.js): [] when none is configured. Fail-soft. */
function _reserveFund() {
  try { return require('./reserve-fund').symbols(); } catch (_e) { return []; }
}
/** What the overnight book (lib/overnight-book.js) owns on this account now: { symbols, since, sells }. Fail-soft. */
function _overnightBook(userId) {
  try { return require('./overnight-book').partition(userId); } catch (_e) { return { symbols: [], since: {}, sells: [] }; }
}
// PRICE-ONLY exit tick (#3165) — runs between full scans so ladder / trailing / max-loss exits react in
// seconds. Fetches no bars and skips the momentum read; all anti-churn gates apply unchanged. (H74)
async function fastExitTick(opts = {}) {
  return _onePassPerAccount(opts,
    () => _pass.run({ user: (opts && opts.userId) || null }, () => _fastExitTickInner(opts)), { skipIfBusy: true });
}
async function _fastExitTickInner({ bridge, userId, now = Date.now(), extended = false, excludeSymbols = [] } = {}) {
  const c = cfg();
  if (!c.enabled && !c.manageExits) return { reason: 'disarmed' };
  if (!bridge || !userId) return { reason: 'no bridge/userId' };
  c.momentumExit = false;                        // price-only on the fast path
  const out = { executed: [], skipped: [] };
  const positions = await bridge.getIBKRPositions(userId).catch(() => []);
  const heldQty = {}, heldPos = {};
  for (const p of (positions || [])) { const k = String(p.symbol).toUpperCase(); heldQty[k] = Number(p.qty) || 0; heldPos[k] = p; }
  if (!Object.values(heldQty).some((q) => q > 0)) return out;   // flat → nothing to do
  const gate = await _sellGate(bridge, userId);   // review H1: no exit, no cancel while orders cannot go out
  _setPassSellGate(gate);
  if (!gate.allowed) { _noteExitsHeld(userId, gate, out); return out; }
  _noteExitsResumed(userId);
  const openOrders = await bridge.getIBKROpenOrders(userId).catch(() => []);
  const workingSells = new Set((openOrders || [])
    .filter((o) => /sell/i.test(o.side || '') && !/stp|stop/i.test(o.orderType || '') && /submit|pending|presubmit|working|needs?[_-]?confirm|accepted/i.test(o.status || ''))
    .map((o) => String(o.symbol || '').toUpperCase()));
  const exclude = new Set([...(excludeSymbols || []), ..._reserveFund(), ..._overnightBook(userId).symbols].map((x) => String(x).toUpperCase()));
  // The fast path must honor the unclosable freeze and in-flight exits exactly like
  // the scan loop's reconcile does — without this it re-attempted the frozen SOXS
  // dust every debounce window (observed live 2026-08-04 09:31/09:39 ET).
  for (const sym of _unclosable) workingSells.add(sym);
  for (const [sym, st] of _exitStatus) if (_isExitInFlight(st)) workingSells.add(sym);
  try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended, workingSells, exclude }); } catch (_e) { /* fail-soft */ }
  _saveState();
  return out;
}

// Execute the ENTER verdicts from a scan against the user's broker account.
// @param {object} scan   result of traderAgent.scanMarket() — { signals: [...] }
// @param {object} deps   { bridge, userId, now?, caps? }
// @returns {Promise<{executed:Array, skipped:Array, enabled:boolean, reason?:string}>}
//
// `protectiveOnly` (extended hours): management only — no entries, only price-threshold exits (r2_trail,
// zone floors, peak_giveback, trailing_stop, targets, max_loss), no signal-derived exits; orders go as
// marketable LIMIT + outsideRth.
//
// EXIT AUTHORITY: the validated exit is the IBS bounce (TRADER_IBS_EXIT). The zone ladder, take_profit_R,
// momentum_died and exitMinPwin pre-empt it when on; the validated structure turns all four off
// (TRADER_ZONE_EXIT=0 TRADER_TAKE_PROFIT_R=0 TRADER_MOMENTUM_EXIT=0 TRADER_EXIT_MIN_PWIN=0).
// _warnExitAuthority journals one config_warning per process when they conflict. (H75)
let _exitAuthorityWarned = false;
function _exitAuthorityConflicts(c) {
  if (!(c.ibsExit > 0)) return [];
  const out = [];
  if (c.zoneExit) out.push('TRADER_ZONE_EXIT (ladder owns every entry: R1 target pre-empts the bounce)');
  if (c.takeProfitR > 0) out.push(`TRADER_TAKE_PROFIT_R=${c.takeProfitR} (+${c.takeProfitR}R target fires before the bounce)`);
  if (c.momentumExit) out.push('TRADER_MOMENTUM_EXIT (unvalidated MACD exit on winners)');
  if (c.exitMinPwin > 0) out.push(`TRADER_EXIT_MIN_PWIN=${c.exitMinPwin} (bounce blocked unless the read is "bearish enough")`);
  return out;
}
function _warnExitAuthority(c) {
  if (_exitAuthorityWarned) return;
  _exitAuthorityWarned = true;
  const conflicts = _exitAuthorityConflicts(c);
  if (!conflicts.length) return;
  const msg = `IBS bounce exit (TRADER_IBS_EXIT=${c.ibsExit}) is armed but pre-empted by: ${conflicts.join('; ')} - the validated exit is not the one running`;
  console.warn('[auto-trader] ' + msg);
  logTrade({ event: 'config_warning', symbol: '*', reason: msg });
}
// Slot priority: TRADER_SLOT_ORDER = confidence (default, scan order) | depth (deepest session IBS first) |
// expectancy (highest TRADER_SYMBOL_SIZE_MULT weight, then deepest IBS). Pure; never drops a candidate.
// Regime read: SPY's close position in its 09:30-09:59 ET range — r30 in [0,1], or null under 3 bars /
// a flat range. Pure. (H76)
function _regimeFirst30Read(bars, todayStr) {
  const w = [];
  for (const b of (bars || [])) {
    const bt = Date.parse((b && b.timestamp) || 0); if (!bt) continue;
    const d = new Date(new Date(bt).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (day !== todayStr) continue;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m >= 570 && m < 600) w.push(b);
  }
  if (w.length < 3) return null;
  const hi = Math.max(...w.map((b) => Number(b.high))), lo = Math.min(...w.map((b) => Number(b.low)));
  if (!(hi > lo)) return null;
  return (Number(w[w.length - 1].close) - lo) / Math.max(hi - lo, 1e-9);
}
let _regimeLoggedDay = null;   // one regime_size journal row per flagged day
function _orderEntries(enters, mode = process.env.TRADER_SLOT_ORDER) {
  const m = String(mode || 'confidence').toLowerCase();
  if (m !== 'depth' && m !== 'expectancy') return enters;
  const ibsOf = (s) => { const v = _signalIbs(s); return v == null ? Infinity : v; };   // no reading sorts last
  const wOf = (s) => _symbolSizeMult(String(s && s.symbol || '').toUpperCase());
  return enters.map((s, i) => ({ s, i })).sort((a, b) => {
    if (m === 'expectancy') { const dw = wOf(b.s) - wOf(a.s); if (dw) return dw; }
    const di = ibsOf(a.s) - ibsOf(b.s);
    return di || a.i - b.i;   // stable
  }).map((x) => x.s);
}
// Trend-day shadow (TRADER_TREND_SHADOW=SOXL): journal-only, one instance per process, never awaited; rows
// under the user 'trend-shadow'. (H77)
let _trendShadow = null;
function _trendShadowKick(now) {
  const spec = String(process.env.TRADER_TREND_SHADOW || '').trim();
  if (!spec) return;
  try {
    if (!_trendShadow || _trendShadow.spec !== spec) {
      _trendShadow = require('./trend-shadow').createTrendShadow({
        symbols: spec.split(','),
        log: (rec) => logTrade({ user: 'trend-shadow', ...rec }),
        stateFile: path.join(path.dirname(TRADES_LOG), 'trend-shadow-state.json'),
        getBars: (s, tf) => yahoo.getBars(s, tf),
        getQuote: async (s) => { const r = await yahoo.getQuotes([s]); return r && r[0] ? r[0].price : null; },
      });
      _trendShadow.spec = spec;
    }
    const p = _trendShadow.tick(now);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a shadow never breaks a pass */ }
}
// Noise-area shadow (TRADER_NOISE_SHADOW=SPY:UPRO:SPXS,...): same contract, rows under 'noise-shadow'. (H78)
let _noiseShadow = null;
function _noiseShadowKick(now) {
  const spec = String(process.env.TRADER_NOISE_SHADOW || '').trim();
  if (!spec) return;
  try {
    if (!_noiseShadow || _noiseShadow.spec !== spec) {
      _noiseShadow = require('./trend-shadow').createNoiseShadow({
        pairs: spec,
        log: (rec) => logTrade({ user: 'noise-shadow', ...rec }),
        stateFile: path.join(path.dirname(TRADES_LOG), 'noise-shadow-state.json'),
        getBars: (s, tf) => yahoo.getBars(s, tf),
        getQuote: async (s) => { const r = await yahoo.getQuotes([s]); return r && r[0] ? r[0].price : null; },
        // the live 5m feed holds about 14 sessions; the band needs 15: older bars from a settled window (2026-10-01)
        getHistory: typeof yahoo.getBarsWindow === 'function' ? (s, from, to) => yahoo.getBarsWindow(s, '5m', from, to) : null,
      });
      _noiseShadow.spec = spec;
    }
    const p = _noiseShadow.tick(now);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a shadow never breaks a pass */ }
}
// After-the-rise shadow (TRADER_RISE_SHADOW=1): tags every live entry; rows under 'rise-shadow'. (H79)
let _riseShadow = null;
function _riseShadowOf() {
  if (!['1', 'true', 'on'].includes(String(process.env.TRADER_RISE_SHADOW || '').trim().toLowerCase())) return null;
  if (!_riseShadow) {
    _riseShadow = require('./rise-shadow').createRiseShadow({
      log: (rec) => logTrade({ user: 'rise-shadow', ...rec }),
      stateFile: path.join(path.dirname(TRADES_LOG), 'rise-shadow-state.json'),
      getDaily: (s, from, to) => yahoo.getBarsWindow(s, '1d', from, to),
    });
  }
  return _riseShadow;
}
function _riseShadowKick(now, scan) {
  try {
    const rs = _riseShadowOf();
    if (!rs) return;
    const syms = ((scan && Array.isArray(scan.signals)) ? scan.signals : []).map((s) => s && (s.symbol || s.ticker)).filter(Boolean);
    const p = rs.check(now, syms);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a shadow never breaks a pass */ }
}
function _riseShadowTag(entry) {
  try {
    const rs = _riseShadowOf();
    if (!rs) return;
    const p = rs.tag(entry);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a shadow never touches an entry */ }
}
// Market-context tags (TRADER_ENTRY_TAGS=1): one entry_tags row per live entry (gamma, news, VIX). Only
// the process with TRADER_ENTRY_TAGS_NEWS_FETCH=1 refreshes news. Knobs are read here, while this sleeve's
// env is the process env (the engine swaps env per sleeve). (H80)
const _knobOn = (k) => ['1', 'true', 'on'].includes(String(process.env[k] || '').trim().toLowerCase());
function _entryTagsCfg() {
  if (!_knobOn('TRADER_ENTRY_TAGS')) return null;
  const et = require('./entry-tags');
  const dir = String(process.env.TRADER_ENTRY_TAGS_DIR || '').trim();
  return { dir: dir ? path.resolve(dir) : path.join(path.dirname(TRADES_LOG), 'entry-tags'),
    headers: _knobOn('TRADER_ENTRY_TAGS_NEWS_FETCH') ? et.serverNewsHeaders() : null };
}
function _entryTagsKick(now) {
  try {
    const c = _entryTagsCfg();
    if (!c) return;
    const p = require('./entry-tags').kick(now, c);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a tag never breaks a pass */ }
}
/** One entry_tags row for a placed entry ({ symbol, account, qty, price, now, order_id, source }); never awaited. */
function tagEntry(entry) {
  try {
    const c = _entryTagsCfg();
    if (!c) return;
    const p = require('./entry-tags').tag(entry, { ...c, log: (rec) => logTrade({ user: 'entry-tags', ...rec }), vixPrior: (n) => _vixPriorClose(n) });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a tag never touches an entry */ }
}
// Trade plan on every entry (TRADER_TRADE_PLAN=shadow): one trade_plan row, journal-only, never awaited,
// rows under 'trade-plan'. Knobs copied here while this sleeve's env is the process env. (H81)
function planEntry(entry, signal, scan) {
  try {
    const tp = require('./trade-plan');
    if (!tp.enabled()) return;
    const env = {};
    for (const k of Object.keys(process.env)) if (/^TRADER_/.test(k) || k === 'TWO_SLEEVE_FAKE_NOW') env[k] = process.env[k];
    const tdir = String(process.env.TRADER_ENTRY_TAGS_DIR || '').trim();
    const dir = tdir ? path.resolve(tdir) : path.join(path.dirname(TRADES_LOG), 'entry-tags');
    const p = tp.write(entry, {
      log: (rec) => logTrade({ user: 'trade-plan', ...rec }),
      getBars: (s, tf) => yahoo.getBars(s, tf),
      // the leg's proxy band needs the settled sessions under the live feed, as the noise scan merges them (#3720)
      getHistory: typeof yahoo.getBarsWindow === 'function' ? (s, from, to) => yahoo.getBarsWindow(s, '5m', from, to) : null,
      // ^VIX's dailies for the calm-VIX gate's read on an inverse leg entry (the plan reads them once a day)
      getDaily: typeof yahoo.getBarsWindow === 'function' ? (s, from, to) => yahoo.getBarsWindow(s, '1d', from, to) : null,
      readJournal: () => fs.promises.readFile(TRADES_LOG, 'utf8'),   // this sleeve's own journal: the plan's scenarios and today's tries
      readContext: () => require('./entry-tags').readContext(dir, entry.now),
      env, signal, scan,
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* journal only: a plan never touches an entry */ }
}

// THE PLAN WATCHDOG (lib/plan-watch.js, 2026-11-08, TRADER_PLAN_WATCH=alert, alert only): this pass's own broker reads (the
// positions and the orders feed; no extra call) against the sleeve's open plans, journaled as plan_alert rows under the user
// 'trade-plan', a fault also to the ALERTS file beside the journal. Never awaited; it places, cancels and changes nothing.
function _planWatchKick(now, positions, orders) {
  try {
    const pw = require('./plan-watch');
    if (!pw.enabled()) return;
    const env = {};
    for (const k of Object.keys(process.env)) if (/^TRADER_/.test(k)) env[k] = process.env[k];
    const p = pw.check({ now, positions: Array.isArray(positions) ? positions.slice() : [], orders: Array.isArray(orders) ? orders.slice() : [],
      journal: TRADES_LOG, sleeve: path.basename(TRADES_LOG).split('.')[0] || null, env,
      alertsFile: String(process.env.TRADER_PLAN_WATCH_ALERTS || '').trim() || path.join(path.dirname(TRADES_LOG), 'plan-watch-ALERTS.log'),
      log: (rec) => logTrade({ user: 'trade-plan', ...rec }) });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_e) { /* alert only: it never touches the pass */ }
}
// The down-day carry held a planned leg trade overnight: said once a day per symbol (plan_carry), so the watchdog moves the
// trade's exit time to the next session's de-carry instead of calling the carry overdue.
const _planCarrySaid = new Set();
function _planCarryNote(sym, spyPct, now) {
  try {
    if (!require('./plan-watch').enabled()) return;
    const day = marketCalendar.etOf(now).day, k = `${day}:${sym}`;
    if (_planCarrySaid.has(k)) return;
    if (_planCarrySaid.size > 500) _planCarrySaid.clear();
    _planCarrySaid.add(k);
    logTrade({ user: 'trade-plan', event: 'plan_carry', symbol: sym, day, spy_pct: Number.isFinite(Number(spyPct)) ? +Number(spyPct).toFixed(3) : null, why: 'the down-day carry suppressed the de-carry' });
  } catch (_e) { /* journal only */ }
}

async function runAutoTrade(scan, opts = {}) {
  return _onePassPerAccount(opts,
    () => _pass.run({ user: (opts && opts.userId) || null }, () => _runAutoTradeInner(scan, opts)));
}
async function _runAutoTradeInner(scan, { bridge, userId, now = Date.now(), caps = {}, extended = false, excludeSymbols = [], protectiveOnly = false } = {}) {
  // Partition: symbols owned by ANOTHER engine are off-limits (no exits, stops, signal-sells, entries); the
  // caller supplies excludeSymbols. The reserve fund is always excluded and is not open risk. The overnight
  // book's names are excluded too, but their notional DOES count toward the gross cap. (H82)
  const _fundOnly = new Set(_reserveFund().map((s) => String(s).toUpperCase()));
  const _ovn = _overnightBook(userId);
  const _fund = new Set([..._fundOnly, ...(_ovn.symbols || []).map((s) => String(s).toUpperCase())]);
  const exclude = new Set([...(excludeSymbols || []), ..._fund].map((s) => String(s).toUpperCase()));
  const _notFund = (p) => !_fund.has(String((p && p.symbol) || '').toUpperCase());
  _exitKeptOpen.clear();   // per scan: this scan's positions snapshot is fresh broker truth
  const c = cfg();
  const out = { executed: [], skipped: [], enabled: c.enabled, manageExits: c.manageExits };
  _warnExitAuthority(c);
  _trendShadowKick(now);   // journal only, never awaited (lib/trend-shadow.js)
  _noiseShadowKick(now);   // journal only, never awaited (lib/trend-shadow.js createNoiseShadow)
  _riseShadowKick(now, scan);   // journal only, never awaited (lib/rise-shadow.js)
  _entryTagsKick(now);   // journal only, never awaited (lib/entry-tags.js)
  // Either arm entries+exits (TRADER_AUTO_EXECUTE) or exits-only (TRADER_MANAGE_EXITS).
  if (!c.enabled && !c.manageExits) { out.reason = 'TRADER_AUTO_EXECUTE!=1 and TRADER_MANAGE_EXITS!=1 — nothing to do'; return out; }
  if (!bridge || !userId) { out.reason = 'no bridge/userId'; return out; }

  const signals = (scan && Array.isArray(scan.signals)) ? scan.signals : [];
  const enters = signals.filter((s) => s && s.convergence && s.convergence.decision === 'ENTER');
  // #3428 stress inputs, once per scan: prior VIX close (cached per day, fail-soft)
  // and SPY's session IBS from this very scan (SPY is on the tradelist; absent = unmet).
  const _stressC = _stressCfg();
  const _vixPrior = _stressC.mult > 1 && enters.length ? await _vixPriorClose(now) : null;
  const _spyIbsNow = (() => { const spy = signals.find((x) => x && String(x.symbol).toUpperCase() === 'SPY'); return spy && Number.isFinite(Number(spy.ibs)) ? Number(spy.ibs) : null; })();

  // Broker truth: current account + open positions (never trade blind). Fetched
  // BEFORE the no-signals early-return so the stop-reconciliation below runs every
  // scan even when there are no new ENTER signals.
  const account = await bridge.getIBKRAccount(userId).catch(() => null);
  if (!account || !(account.equity > 0)) { out.reason = 'account/equity unavailable'; return out; }
  // null = the FETCH FAILED (never [] — "the call errored" and "you hold nothing"
  // are opposite facts, and collapsing them made an API error read as a flat book).
  const positions = await bridge.getIBKRPositions(userId).catch(() => null);
  const _positionsOk = Array.isArray(positions);
  // Never trade blind: no readable book = no orders, exits included (broker-side stops guard the book). (H83)
  if (!_positionsOk) { out.reason = 'positions unavailable — standing down this scan (never trade blind)'; return out; }
  const heldQty = {};
  const heldPos = {}; // full position (for realized-P&L logging on exit)
  let _openedThisScan = 0;   // entries placed during THIS scan (heldPos is a start-of-scan snapshot)
  const _bucketOpenedThisScan = {};   // correlated-risk bucket -> entries placed this scan
  let _grossThisScan = 0;    // notional placed during THIS scan — the gross brake has the same
                             // start-of-scan-snapshot blind spot the concurrency cap had
                             // (2026-08-07): without it, two same-scan entries each compared
                             // against the stale pre-scan gross and stacked past the cap
                             // (probed to 126% of budget; audit 2026-08-08).
  for (const p of (positions || [])) {
    const k = String(p.symbol).toUpperCase(); heldQty[k] = Number(p.qty) || 0; heldPos[k] = p;
    _checkFillBasis(k, p.avg_entry_price ?? p.avg_fill_price);   // #3407: one-time basis correction row
  }
  // Every symbol the broker CONFIRMS we hold refreshes its timestamp (#3282). If
  // one later vanishes with no exit row to explain it, this is what tells the
  // entry gate the flat reading is a feed dropout rather than an opportunity.
  // Partition rows (the reserve fund, the overnight book) are not the trader's holdings: their sale is no dropout.
  for (const [k, q] of Object.entries(heldQty)) if (Math.abs(q) > 0 && !_fund.has(k)) _lastConfirmedHold.set(k, now);
  // Snapshot every long we can still see, so a position that vanishes can be reconstructed. Ownership
  // filter: only symbols this engine scans, plus anything we hold engine state for. (H84)
  const _ourSyms = new Set([
    ...signals.map((x) => String(x && x.symbol || '').toUpperCase()),
    ..._zoneLadder.keys(), ..._entryAt.keys(),
  ].filter(Boolean));
  const _driftPending = [];   // #3432 position-drift rows, journaled once the orders feed is in hand
  _trackHeldSnapshot({ _driftPending, _fund, _ourSyms, heldPos, heldQty, now });
  // consecutive means CONSECUTIVE: a dwell candidate that skips a scan starts
  // over — otherwise two one-off flap sightings days apart would sum to adoption.
  for (const k of [..._seenStreak.keys()]) if (!(Number(heldQty[k]) > 0)) _seenStreak.delete(k);

  // ── External-close sweep: THE LOSS PATH. Orders are fetched first because fill reconciliation is
  // authoritative and the reconstruct loop must yield to it. (H87)
  const _ordersEarly = await bridge.getIBKROpenOrders(userId).catch(() => []);
  // FILL-TIME GUARD (2026-10-30): when each order was last seen working, so a fill whose reported execution time is
  // no later than that (IBKR: a GTC stop's submission time) is stamped at its discovery instead (fill-ledger.js).
  for (const o of (_ordersEarly || [])) {
    const id = String((o && (o.orderId ?? o.order_id)) ?? ''); const st = String((o && o.status) || '');
    if (id && STOP_WORKING.test(st) && !STOP_TERMINAL.test(st)) { _ordersSeenWorking.delete(id); _ordersSeenWorking.set(id, now); }
  }
  while (_ordersSeenWorking.size > 1000) _ordersSeenWorking.delete(_ordersSeenWorking.keys().next().value);
  for (const _dr of _driftPending) {   // #3432: journaled with the broker orders the feed shows for the symbol
    logTrade({ ..._dr, feed_orders: (_ordersEarly || []).filter((o) => String(o.symbol || '').toUpperCase() === _dr.symbol)
      .map((o) => ({ id: o.orderId, side: o.side, type: o.orderType || o.type, qty: o.qty, status: o.status, price: o.price })).slice(0, 12) });
  }
  _planWatchKick(now, positions, _ordersEarly);   // the plan watchdog: this pass's reads against the open plans (alert only, never awaited)
  // Partition sales are not this trader's exits: the reserve fund's, a sale of a name the overnight book holds (filled
  // at or after its buy), or one of the book's own sell orders. Their ids are remembered so no later pass books them.
  const _ordersMine = (_ordersEarly || []).filter((o) => {
    if (!fillLedger.isFilledSell(o)) return true;
    const s = String((o && (o.symbol || o.ticker)) || '').toUpperCase();
    const id = String((o && (o.orderId ?? o.order_id)) ?? '');
    const t = fillLedger.orderTimeMs(o);
    const theirs = _fundOnly.has(s)
      || ((_ovn.symbols || []).includes(s) && !(t != null && t < Number((_ovn.since || {})[s] || 0)))
      || (_ovn.sells || []).some((x) => (id && String(x.orderId) === id) || (!x.orderId && x.symbol === s && Number(o.filledQty) === Number(x.qty)));
    if (theirs && id) _loggedFills.add(id);
    return !theirs;
  });
  const _filledSyms = _reconcileFills(_ordersMine);   // authoritative exits, priced at the fill
  // Same-scan fill guard: symbols whose sell shows FILLED in this scan's orders read are skipped by every pass
  // below that sends a SELL (the positions endpoint lags the orders feed — a re-stop would oversell). (H88)
  const _sellExclude = new Set([...exclude, ...(_filledSyms || [])]);
  // Registry seeding (#3386): any WORKING sell-stop on a held symbol, absent from the registry, is adopted
  // (seeded:true). The account pin guarantees the feed is ours. (H89)
  for (const o of (_ordersEarly || [])) {
    const _sym = String((o && o.symbol) || '').toUpperCase();
    if (!_sym || !o || !o.orderId || _stopOrders.has(_sym)) continue;
    if (String(o.side || '').toUpperCase() !== 'SELL') continue;
    if (!/st(o)?p/i.test(String(o.orderType || ''))) continue;
    if (STOP_TERMINAL.test(String(o.status || ''))) continue;   // dead orders teach nothing
    if (!(Number(heldQty[_sym]) > 0)) continue;                 // only positions we actually hold
    _stopOrders.set(_sym, { id: String(o.orderId), px: Number(o.price) || null,
      qty: Number(o.qty) || null, at: now, seeded: true });
  }

  // A symbol we last saw held that is now off the book, with no confirmed exit of ours, is logged as a
  // RECONSTRUCTED exit (marked estimated, priced from the last mark, excluded from the confirmed scorecard).
  // Trust guard: absence is only evidence of a close when the rest of the book is visible — a failed fetch is
  // null, and an empty / mass-vanished book defers the sweep. (H90)
  const _vanished = [..._lastPos.keys()].filter((k) => !(Number(heldQty[k]) > 0));
  // Foreign-book tell (#3378): several tracked positions gone WHILE several stateless rows appear = another
  // book's snapshot. (H91)
  const _knownSym = (k) => _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)
    || _exitStatus.has(k) || _stopDistPct.has(k);
  // The reserve fund (lib/reserve-fund.js) is an expected row, never evidence about the book: these tells read the
  // trader's rows without it, so a parked fund neither counts as an unrecognised row nor pads the book size.
  const _bookRows = positions.filter(_notFund);
  const _foreignRows = snapshotForeignRows(_bookRows, _knownSym);
  const _snapshotForeign = _vanished.length >= 2 && _foreignRows >= 2;
  const _snapshotSuspect = !_positionsOk
    || (_bookRows.length === 0 && _lastPos.size > 0)
    || (_vanished.length >= 3 && _vanished.length > _bookRows.length)
    || _snapshotForeign;
  if (_snapshotForeign) {
    // The foreign shape stands the whole scan down (nothing in the snapshot can be trusted). The other suspect
    // shapes (empty book, mass-vanish) only defer the sweep; the scan continues. (H92)
    out.skipped.push({ symbol: '*', why: `foreign snapshot: ${_vanished.length} tracked position(s) absent while ${_foreignRows} unrecognised row(s) appeared — standing down this scan` });
    logTrade({ event: 'skip', symbol: '*', reason: `foreign snapshot: ${_vanished.length} tracked absent, ${_foreignRows} unrecognised rows — standing down this scan` });
    out.reason = 'position snapshot looks like another account\'s book — standing down this scan (never trade blind)';
    return out;
  }
  // Entries wait while this account's book reads short of its last trusted read with
  // nothing on record to explain it (review H3). Exits still run on the reading.
  const _bookWait = _entriesWaitOnBook(userId, heldQty,
    (s) => _exitStatus.has(s) || (_filledSyms && _filledSyms.has(s)) || exclude.has(s), now);
  if (_bookWait.started) logTrade({ event: 'entries_held', symbol: '*', reason: _bookWait.why });
  if (_snapshotSuspect && _vanished.length) {
    out.skipped.push({ symbol: '*', why: `external-close sweep deferred: ${_vanished.length} position(s) absent from a ${_positionsOk ? positions.length + '-row' : 'FAILED'} snapshot (${_foreignRows} foreign row(s)) — treating as unreadable, not closed` });
  }
  await _externalCloseSweep({ _filledSyms, _snapshotSuspect, bridge, exclude, heldQty, now, out, userId });

  // Fetch working orders ONCE: re-protect naked longs, and the OVERSELL GUARD (symbols with a resting non-stop
  // SELL get no second sell). (H98)
  let _openOrders = _ordersEarly;
  const workingSells = new Set((_openOrders || [])
    .filter((o) => /sell/i.test(o.side || '') && !/stp|stop/i.test(o.orderType || '') && /submit|pending|presubmit|working|needs?[_-]?confirm|accepted/i.test(o.status || ''))
    .map((o) => String(o.symbol || '').toUpperCase()));

  // ── Re-exit reconciliation, every scan: a symbol no longer held has all its per-symbol state cleared; one
  // with an exit still in flight joins workingSells so no exit path re-fires it. (H99)
  _reconcileExitFreezes({ _openOrders, c, heldQty, now, workingSells });

  // ── Can this account's orders go out right now? (review H1) ─────────────────────
  // If not (a halt file, a dry account, an unknown mode), this pass changes no stop
  // and fires no exit: each of those cancels first, and the order that follows would
  // be refused. The broker's stops keep guarding the book meanwhile.
  const _gate = await _sellGate(bridge, userId);
  _setPassSellGate(_gate);
  if (!_gate.allowed) _noteExitsHeld(userId, _gate, out); else _noteExitsResumed(userId);

  // ── Re-protect naked longs: any held long that's lost its protective stop (the
  //    stop was consumed/cancelled while the position stayed open) gets a fresh GTC
  //    SELL STP. Runs every scan so a long is never left unprotected. ──
  await _reprotectStops({
      _gate, _notFund, _openOrders, _sellExclude, account, bridge, c, extended, heldPos, now, out, userId,
      workingSells
  });

  // ── Manage held longs on their own merits (trailing stop / take-profit / momentum
  //    death) — runs every scan, independent of new ENTER signals. This is what stops
  //    a winner from peaking and giving it all back. ──
  if (_gate.allowed) try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended, workingSells, exclude: _sellExclude, protectiveOnly }); } catch (_e) { /* fail-soft */ }
  // manageHeldExits updates every held position's peak; persist NOW so the common
  // early-return paths below (exits-only mode, no ENTER signals) don't drop it.
  _saveState();

  // Entries require the full autopilot arm; exits-only mode stops here.
  if (!c.enabled) { out.reason = 'exit-management only (TRADER_MANAGE_EXITS) — entries off'; return out; }

  if (!enters.length) { out.reason = 'no ENTER signals'; return out; }

  // Daily-loss circuit breaker: once the account's day P&L is at/below the limit,
  // stop opening NEW positions (exits still run — closing losers is allowed).
  const dailyLimit = account.equity * (c.maxDailyLossPct / 100);
  // Day P&L shape: IBKR returns a number, the other facades { dailyPnl }; accept both, fail open. (H114)
  const _dayRaw = await bridge.getIBKRDayPnl(userId).catch(() => null);
  const dayPnl = typeof _dayRaw === 'number' ? _dayRaw
    : (_dayRaw && typeof _dayRaw.dailyPnl === 'number' ? _dayRaw.dailyPnl : null);
  // TRADER_MAX_DAILY_LOSS_PCT <= 0 disables the halt (2026-08-23). Before this, 0 made dailyLimit 0 and the halt fired on ANY red day P&L.
  const haltEntries = c.maxDailyLossPct > 0 && typeof dayPnl === 'number' && dayPnl <= -dailyLimit;
  if (haltEntries) out.circuit_breaker = { dayPnl, limit: -Math.round(dailyLimit) };

  let opened = 0;

  // Falling-knife filter: one batched fetch of the momentum-timeframe bars for the
  // ENTER candidates, so the BULLISH branch can veto buying into cratering momentum
  // without a per-symbol fetch. Fail-soft — no bars → filter simply doesn't block.
  let entryBars = {};
  if ((c.entryKnifeFilter || c.entryConfirm > 0) && enters.length) {
    try {
      const syms = [...new Set(enters.map((s) => String(s.symbol).toUpperCase()))];
      const bm = await yahoo.getBarsMulti(syms, c.momentumTf);
      entryBars = (bm && bm.bars) || {};
    } catch (_e) { entryBars = {}; }
  }

  // protectiveOnly (extended hours): manage what we hold, open nothing new.
  // IBS is position-within-session-range; the extended session has almost no
  // range, so the entry signal is undefined there and unbacked by any lab gate.
  const _entryCandidates = protectiveOnly ? [] : _orderEntries(enters, process.env.TRADER_SLOT_ORDER);
  const _spyGateRow = (signals || []).find((x) => x && String(x.symbol).toUpperCase() === "SPY");
  const _spyGateIbs = _spyGateRow ? Number((_spyGateRow.decision_context && _spyGateRow.decision_context.ibs) != null ? _spyGateRow.decision_context.ibs : _spyGateRow.ibs) : null;
  const _INVERSE_FAMILY = new Set(["SQQQ", "SOXS", "SPXS", "TZA", "FAZ"]);
  // REGIME SIZING — see cfg.regimeSizeMult. One SPY fetch per scan while armed.
  let _regimeR30 = null;
  if (c.regimeSizeMult > 0 && c.regimeSizeMult < 1) {
    try {
      const _rb = await yahoo.getBarsMulti(["SPY"], "5m");
      _regimeR30 = _regimeFirst30Read((((_rb || {}).bars || {}).SPY || {}).bars, _etDateStr(now));
    } catch (_e) { _regimeR30 = null; }
  }
  const _regimeNowMin = (() => { const d = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" })); return d.getHours() * 60 + d.getMinutes(); })();
  if (_regimeR30 != null && _regimeR30 <= c.regimeR30Max && _regimeNowMin >= 600 && _regimeLoggedDay !== _etDateStr(now)) {
    _regimeLoggedDay = _etDateStr(now);
    logTrade({ event: 'regime_size', r30: +_regimeR30.toFixed(3), mult: c.regimeSizeMult,
      why: `SPY first-30m close position ${_regimeR30.toFixed(2)} <= ${c.regimeR30Max} — trend-down read; long risk x${c.regimeSizeMult} for the session` });
  }
  if (protectiveOnly && enters.length) {
    out.skipped.push({ symbol: '*', why: `extended hours: protective exits only — ${enters.length} entry signal(s) not taken` });
  }
  ({ _openedThisScan } = await _entryPass({
      _INVERSE_FAMILY, _bookWait, _bucketOpenedThisScan, _entryCandidates, _fundOnly, _gate, _grossThisScan,
      _notFund, _openedThisScan, _regimeNowMin, _regimeR30, _spyGateIbs, _spyIbsNow, _stressC, _vixPrior, account,
      bridge, c, dayPnl, entryBars, exclude, extended, haltEntries, heldPos, heldQty, now, opened, out, positions,
      protectiveOnly, scan, userId, workingSells
  }));
  _logSkips(out.skipped);
  // CSP shadow book: resolve any paper legs whose expiry has passed (cheap —
  // no-op when nothing is due; quotes fetched lazily per due symbol).
  try {
    const _csp = require('./csp-shadow');
    if (_csp.openCount() > 0) {
      _csp.resolveDue(async (s) => {
        const q = await require('./market-data-yahoo').getQuotes([s]).catch(() => []);
        return q && q[0] && Number(q[0].price) > 0 ? Number(q[0].price) : null;
      }, now).catch(() => {});
    }
  } catch (_e) { /* observer only — never breaks the scan */ }
  // ── SLOT-UTILIZATION OBSERVABILITY: one row per change in slots-in-use (same slot definition as the cap). (H146)
  _logSlotUtil({ _notFund, _openedThisScan, account, c, heldPos });
  // ── SESSION RECORD (#3286): one row per trading day at/after the close, from the same computeDayPnl the
  // panel uses; idempotence is checked against the ledger so a restart cannot double-write. (H147)
  await _writeSessionRecord({ _notFund, _ourSyms, account, heldPos, now, userId });
  // Persist the updated peaks/timers so the trailing stop survives a restart.
  _saveState();
  return out;
}

// Track every held long this engine owns (adoption dwell, drift, last mark/basis) for the sweep. Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
function _trackHeldSnapshot({ _driftPending, _fund, _ourSyms, heldPos, heldQty, now }) {
  for (const [k, p] of Object.entries(heldPos)) {
    if (!(Number(heldQty[k]) > 0)) continue;
    if (_ourSyms.size && !_ourSyms.has(k)) continue;   // another engine's position
    // Partition rows are never tracked as this book: the overnight book's morning sale of three names must not read as
    // three positions vanishing (the external-close sweep, the mass-vanish tell), and the fund's rebalances as drift.
    if (_fund.has(k)) { _lastPos.delete(k); _seenStreak.delete(k); continue; }
    // Adoption dwell (#3378): a symbol with no engine state must be seen held on two consecutive snapshots
    // before this engine tracks it; our own entries carry state and are tracked at once. (H85)
    const _stateful = _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)
      || _exitStatus.has(k) || _stopDistPct.has(k);
    if (!_stateful) {
      const _seen = (_seenStreak.get(k) || 0) + 1;
      if (_seen < 2) { _seenStreak.set(k, _seen); continue; }
    }
    _seenStreak.delete(k);
    // Position drift (#3432): a held qty that changes between scans with no engine order in 10 min is
    // journaled with both quantities and the broker's orders. Journal-only. (H86)
    {
      const _prev = _lastPos.get(k);
      const _newQ = Number(p.qty) || 0;
      if (_prev && Number.isFinite(Number(_prev.qty)) && Math.abs(_newQ - Number(_prev.qty)) >= 1e-6
          && (now - (_lastOrderAt.get(k) || 0)) > 10 * 60 * 1000) {
        _driftPending.push({ event: 'position_drift', symbol: k, qty_was: Number(_prev.qty), qty_now: _newQ,
          delta: +(_newQ - Number(_prev.qty)).toFixed(6), entry: p.avg_entry_price ?? null, mark: p.current_price ?? null,
          reason: _newQ > Number(_prev.qty) ? 'quantity grew with no engine order — external/phantom buy'
            : _stopOrders.has(k) ? 'quantity shrank with no engine order — the registered stop may have filled in part (see the exit rows)'
              : 'quantity shrank with no engine order — partial external sell' });
      }
    }
    _lastPos.set(k, {
      qty: Number(p.qty) || 0,
      entry: p.avg_entry_price ?? p.avg_fill_price ?? null,
      mark: p.current_price ?? null,
      ts: now,
    });
    if (Number(p.avg_entry_price ?? p.avg_fill_price) > 0) _lastBasis.set(k, { entry: Number(p.avg_entry_price ?? p.avg_fill_price), ts: now, openedAt: _entryAt.get(k) ?? null });
  }
}

// External-close sweep: book positions that left the book with no exit of ours (stop status, else reconstructed). Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
async function _externalCloseSweep({ _filledSyms, _snapshotSuspect, bridge, exclude, heldQty, now, out, userId }) {
  for (const sym of (_snapshotSuspect ? [] : [..._lastPos.keys()])) {
    if (Number(heldQty[sym]) > 0) { _absentStreak.delete(sym); continue; }           // still held → nothing to reconcile
    if (exclude.has(sym)) { _lastPos.delete(sym); _absentStreak.delete(sym); continue; }  // another engine owns it
    // An explained absence (our own exit row of any status, or a fill reconciled this cycle) needs no second
    // read and no reconstruction. (H93)
    if (_exitStatus.has(sym) || (_filledSyms && _filledSyms.has(sym))) {
      _lastPos.delete(sym);
      _absentStreak.delete(sym);
      continue;
    }
    // Two consecutive absences (#3378) before the inference path books a close. (H94)
    const _miss = (_absentStreak.get(sym) || 0) + 1;
    if (_miss < 2) {
      _absentStreak.set(sym, _miss);
      out.skipped.push({ symbol: sym, why: 'absent from one snapshot — awaiting a second consecutive absence before booking an external close' });
      continue;
    }
    _absentStreak.delete(sym);
    const snap = _lastPos.get(sym) || {};
    _lastPos.delete(sym);
    const entry = Number(snap.entry);
    const mark = Number(snap.mark);
    const qty = Number(snap.qty);
    if (!(qty > 0) || !Number.isFinite(entry) || !Number.isFinite(mark)) continue;  // can't value it → don't invent a number
    // ── STOP RECONCILIATION (#3379): before reconstructing, ask the per-order status endpoint about the stop
    // this engine placed; a hit books a REAL stop exit at the fill. Otherwise fall through. (H95)
    const _regStop = _stopOrders.get(sym);
    let _regStatus = null;
    if (_regStop && _regStop.id && !_loggedFills.has(_regStop.id)
        && typeof bridge.getIBKROrderStatus === 'function') {   // #3381: demo/practice facades lack it
      _regStatus = await bridge.getIBKROrderStatus(userId, _regStop.id).catch(() => null);
      if (_regStatus && /fill/i.test(String(_regStatus.status || ''))) {
        const _fillPx = Number(_regStatus.avgPrice) > 0 ? Number(_regStatus.avgPrice) : mark;
        const _fillQty = Number(_regStatus.filledQty) > 0 ? Number(_regStatus.filledQty) : qty;
        const _fillPnl = _round2((_fillPx - entry) * _fillQty);
        const _beHit = _beStopAt.has(sym) && _fillPx >= entry * 0.998;   // #3413: ratcheted stop → round trip, not failure — only if it FILLED at or above entry
        logTrade({
          // The row carries the broker's fill time (ts); discovered_at records when this sweep found it. (H96)
          ...(_regStatus.filledAt ? { ts: _regStatus.filledAt, discovered_at: new Date().toISOString() } : {}),
          event: 'exit', symbol: sym, qty: _fillQty, entry, exit: _fillPx,
          pnl: _fillPnl, pnl_pct: entry > 0 ? +(((_fillPx - entry) / entry) * 100).toFixed(6) : null,
          reason: `protective_stop (broker GTC stop ${_regStop.px} filled${_beHit ? '; be_ratchet — stop sat at the lock level' : ''})`,
          be_ratchet: _beHit || undefined,
          order_id: _regStop.id, order_type: 'Stop', status: 'filled', source: 'stop-status',
          estimated: !(Number(_regStatus.avgPrice) > 0),
          ...fillLedger.excursionFields(entry, _peak.get(sym), _trough.get(sym), _stopDistPct.get(sym)),
        });
        // Same arming as a feed-visible stop fill (_reconcileFills): cooldown +
        // breaker — except a RATCHETED fill (#3413): session block only, breaker
        // untouched (it counts real failures, not round trips).
        if (_beHit) {
          _stopCooldownThrough.set(sym, _etDate(Date.now()));
          _beStopAt.delete(sym);
        } else {
          _beStopAt.delete(sym);   // a stop fill ends the ratchet either way
          const _cd = cfg().stopCooldownDays;
          if (_cd > 0) _stopCooldownThrough.set(sym, _nextTradingDates(_etDate(Date.now()), _cd));
          _noteStopFill(Date.now());
        }
        _loggedFills.add(_regStop.id);          // a late feed appearance must not double-book
        _stopOrders.delete(sym);
        _peak.delete(sym); _trough.delete(sym); _entryAt.delete(sym); _holdClockAt.delete(sym); _excursion.delete(sym);
        continue;
      }
    }
    const pnl = _round2((mark - entry) * qty);
    const _lossPct = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
    // ── STOP ATTRIBUTION (#3281): an absence that gave up >= _stopAttribFrac of its stop distance arms the
    // cooldown and breaker as a stop-out. Deliberately asymmetric: a false arm costs one day of re-entry. (H97)
    const _attribFrac = _stopAttribFrac();
    const _stopPct = Number(_stopDistPct.get(sym)) || cfg().stopMinPct || 0;
    const _looksLikeStop = _attribFrac > 0 && _stopPct > 0
      && _lossPct <= -(_stopPct * _attribFrac);
    logTrade({
      event: 'exit', symbol: sym, qty, entry, exit: mark,
      pnl, pnl_pct: entry > 0 ? _lossPct : null,
      reason: 'closed_externally (position left the book with no autopilot exit — protective stop, manual close, or another engine)',
      status: 'reconstructed', estimated: true,
      // #3379: what the broker said about OUR stop for this symbol, so the row
      // records why it was NOT classified as a stop fill.
      stop_order_id: _regStop ? _regStop.id : null,
      stop_order_status: _regStatus ? String(_regStatus.status || 'unknown') : (_regStop ? 'unavailable' : null),
      // Auditable: why this close was (or was not) treated as a stop-out.
      stop_attributed: _looksLikeStop,
      stop_dist_pct: _stopPct || null,
      ...fillLedger.excursionFields(entry, _peak.get(sym), _trough.get(sym), _stopDistPct.get(sym)),
    });
    if (_looksLikeStop) {
      const _cdDays = cfg().stopCooldownDays;
      if (_cdDays > 0) _stopCooldownThrough.set(sym, _nextTradingDates(_etDate(now), _cdDays));
      _noteStopFill(now);        // feeds the daily circuit breaker
      _saveState();              // survive a restart between the stop and the re-entry
    }
  }
}

// Re-exit reconciliation: clear state of symbols that left, keep in-flight exits frozen, back off failing ones. Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
function _reconcileExitFreezes({ _openOrders, c, heldQty, now, workingSells }) {
  for (const sym of [..._exitStatus.keys()]) {
    if (!(Number(heldQty[sym]) > 0)) {
      // Position gone → exit resolved. Drop its state.
      _exitStatus.delete(sym); _exitAt.delete(sym); _peak.delete(sym); _entryAt.delete(sym); _holdClockAt.delete(sym);
      _stopOrders.delete(sym);                               // #3379: closeLong cancelled it; the record is dead
      _exitFailures.delete(sym); _unclosable.delete(sym);   // position gone → a future re-entry starts clean
      _unclosableAt.delete(sym); _exitNoOrder.delete(sym);
      _zoneLadder.delete(sym); _stopDistPct.delete(sym);
      _trough.delete(sym); _excursion.delete(sym);
      _beStopAt.delete(sym);                                 // #3413: ratchet dies with the position
      _limitShadowClose(sym, 'position_closed');             // #3424
    } else if (_isExitInFlight(_exitStatus.get(sym))) {
      // Freeze expiry: no sell alive at the broker in any resurrectable status for two consecutive scans, and the
      // re-fire debounce passed = the exit is dead; release the freeze. (H100)
      const _sellAlive = (_openOrders || []).some((o) =>
        String(o.symbol || '').toUpperCase() === sym && /sell/i.test(o.side || '') &&
        !/cancel|reject|expired|filled/i.test(String(o.status || '')));
      if (_sellAlive) {
        _exitNoOrder.delete(sym);
        workingSells.add(sym);   // exit still outstanding on a still-held position → don't re-fire
      } else {
        const misses = (_exitNoOrder.get(sym) || 0) + 1;
        _exitNoOrder.set(sym, misses);
        if (misses >= 2 && now - (_exitAt.get(sym) || 0) > c.exitReattemptMs) {
          _exitStatus.delete(sym); _exitNoOrder.delete(sym);
          logTrade({ event: 'exit_unfrozen', symbol: sym, qty: heldQty[sym],
            reason: 'in-flight exit order no longer exists at the broker — freeze released, exits re-enabled' });
        } else {
          workingSells.add(sym);   // first miss (or inside debounce) → stay frozen this scan
        }
      }
    } else {
      // Held, last exit terminal-non-fill (error/dry_run): clear the freeze so it can retry — but after
      // MAX_EXIT_FAILURES consecutive failures declare it unclosable (frozen, logged once, released when it leaves
      // the book or grows back to a tradable size). (H101)
      const st = String(_exitStatus.get(sym) || '');
      if (/error/i.test(st)) {
        const n = (_exitFailures.get(sym) || 0) + 1;
        _exitFailures.set(sym, n);
        if (n >= MAX_EXIT_FAILURES) {
          // UNCLOSABLE RETRY (2026-08-08): the freeze is a backoff now, not a
          // life sentence. After TRADER_UNCLOSABLE_RETRY_MIN (default 60) the
          // symbol gets one clean retry cycle; a still-failing exit re-freezes
          // for another interval, a transient outage recovers on its own.
          if (_unclosable.has(sym) && now - (_unclosableAt.get(sym) || 0) > _unclosableRetryMs()) {
            _unclosable.delete(sym); _unclosableAt.delete(sym);
            _exitFailures.delete(sym); _exitStatus.delete(sym);
            continue;                            // freeze lifted — exits may retry this scan
          }
          workingSells.add(sym);                 // stop both exit paths re-deciding
          if (!_unclosable.has(sym)) {
            _unclosable.add(sym);
            _unclosableAt.set(sym, now);
            logTrade({ event: 'exit_frozen', symbol: sym, qty: heldQty[sym],
              reason: `exit failed ${n}x consecutively — treating as unclosable, retry in ${Math.round(_unclosableRetryMs() / 60000)} min`,
              status: 'frozen' });
          }
          continue;                              // keep the freeze; don't clear state
        }
      }
      _exitStatus.delete(sym);
    }
  }
}

// Stop passes: stop-size reconciliation, breakeven / stepped / first-lock ratchet, gapped stop to the auction, re-protect naked longs. Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
async function _reprotectStops({
    _gate, _notFund, _openOrders, _sellExclude, account, bridge, c, extended, heldPos, now, out, userId,
    workingSells
}) {
  if (_gate.allowed) try {
    // Empty orders != no stops: an empty orders read while positions exist is UNKNOWN, not unprotected — skip
    // the re-protect pass this scan (a duplicate stop can flip the account short). The reserve fund carries no
    // stop by design. (H102)
    const _heldCount = Object.values(heldPos).filter((p) => (Number(p.qty) || 0) > 0 && _notFund(p)).length;
    const _ordersUnknown = _heldCount > 0 && (!Array.isArray(_openOrders) || _openOrders.length === 0);
    if (_ordersUnknown) {
      (out.skipped = out.skipped || []).push({ symbol: '*', why: `re-protect deferred: broker returned 0 orders while holding ${_heldCount} position(s) — treating as UNKNOWN, not unprotected` });
    }
    // Status vocabulary: accept both broker-native and normalized words, and orderType/type on either key. (H103)
    const hasStop = (sym) => (_openOrders || []).some((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
      STOP_WORKING.test(o.status || ''));
    // Accumulation cap: retry a stop placement a bounded number of times, then stop adding. (H104)
    const REPROTECT_MAX_ATTEMPTS = 3;
    // Count only FAILED placements (parked/refused vocabulary); stops we cancelled or that filled are
    // lifecycle, not failure. (H105)
    const attemptsFor = (sym) => (_openOrders || []).filter((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
      isFailedStop(o.status)).length;
    // Stop-size reconciliation: a stop whose qty != the position is cancelled here; the pass below places a
    // correctly sized one. A deliberate cancel does not count toward the failure cap. (H106)
    const _stopQtyFor = (sym) => (_openOrders || [])
      .filter((o) => String(o.symbol || '').toUpperCase() === sym
        && /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '')
        && STOP_WORKING.test(o.status || ''))
      .reduce((a, o) => a + (Number(o.qty) || 0), 0);
    if (!_ordersUnknown) {
      for (const [sym, p] of Object.entries(heldPos)) {
        if (_sellExclude.has(sym)) continue;
        const _held = Math.abs(Number(p.qty) || 0);
        if (_held < 1) continue;                  // dust cannot carry a stop at all
        const _stopQty = _stopQtyFor(sym);
        const _want = Math.floor(_held);          // whole-share stops (2026-08-10)
        if (_stopQty > 0 && _stopQty !== _want) {
          await cancelRestingStops(bridge, userId, sym);
          (out.stopResized = out.stopResized || []).push({ symbol: sym, was: _stopQty, want: _want });
          logTrade({ event: 'stop_resize', symbol: sym, stop_qty_was: _stopQty, held: _held, want: _want,
            reason: _stopQty > _want ? 'oversized stop would oversell' : 'undersized stop leaves part of the position naked' });
        }
      }
      // Re-read orders after any cancel, so the pass below does not still see the
      // stop it just removed and wrongly conclude the position is protected.
      if ((out.stopResized || []).length) {
        const _fresh = await bridge.getIBKROpenOrders(userId).catch(() => null);
        if (Array.isArray(_fresh)) _openOrders = _fresh;
      }
    }
    // ── BREAKEVEN RATCHET (#3413): once up TRADER_BE_RATCHET (fraction), the stop rises to entry and never
    // goes back down. Cancels the low stop here and pins the level; the re-protect pass places the new one.
    // Default off. (H107)
    const _bePct = Number(process.env.TRADER_BE_RATCHET) || 0;
    // TRADER_BE_LOCK (#3415): the level the stop rises TO, as a fraction above entry (0 = breakeven). (H108)
    const _beLock = Math.max(0, Number(process.env.TRADER_BE_LOCK) || 0);
    const _stepPct = Math.max(0, Number(process.env.TRADER_STEP_FLOOR) || 0);   // 2026-08-24: stepped floor, % per step (0 = flat lock)
    // REGULAR HOURS ONLY (2026-10-15 cost audit, operator: "do the fixes"). A raise read off a thin PRE-MARKET
    // mark parks the stop over the opening print: GDX 10-15 stepped to entry+1% and +2% at 04:04 / 04:30 ET on
    // pre-market marks, the stop then sold at the open (84.62) and GDX closed 87.02. Raises now wait for the
    // regular session; TRADER_RATCHET_EXTENDED=1 restores the old behaviour.
    const _ratchetNow = !extended || process.env.TRADER_RATCHET_EXTENDED === '1';
    if ((_bePct > 0 || _stepPct > 0) && !_ordersUnknown && _ratchetNow) {
      let _beCancels = 0;
      for (const [sym, p] of Object.entries(heldPos)) {
        if (_sellExclude.has(sym)) continue;
        const qty = Number(p.qty) || 0;
        const entry = Number(p.avg_entry_price || p.avg_fill_price) || 0;  // genuine basis only — no mark fallback
        const mark = Number(p.current_price) || 0;
        if (qty < 1 || !entry || !mark) continue;    // dust cannot carry a stop at all
        // Stepped floor: TRADER_STEP_FLOOR = step in percent (1 = lock each whole percent gained); unset/0 keeps
        // the flat one-shot lock. (H109)
        const _prevLock = Number(_beStopAt.get(sym)) || 0;
        let _wantPct = null;
        let _firstLock = null;   // set when this resize is the FIRST LOCK (see _firstLockCfg)
        if (_stepPct > 0) {
          const _gain = (mark / entry - 1) * 100;
          const _steps = Math.floor(_gain / _stepPct);
          if (_steps >= 1) _wantPct = (_steps * _stepPct) / 100;
          else { const _fl = _firstLockCfg(sym); if (_fl && _gain >= _fl.arm) { _wantPct = _fl.lock / 100; _firstLock = _fl; } }
        } else if (mark >= entry * (1 + _bePct)) {
          _wantPct = _beLock;
        }
        if (_wantPct == null) continue;                                    // not yet at a lock level
        if (_stepPct <= 0 && _beStopAt.has(sym)) continue;                 // flat mode: one-shot, never re-lower
        const _wk = (_openOrders || []).filter((o) => String(o.symbol || '').toUpperCase() === sym
          && /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '')
          && STOP_WORKING.test(o.status || ''));
        const _top = _wk.reduce((a, o) => Math.max(a, Number(o.price) || Number(o.stopPrice) || 0), 0);
        let _lockLvl = Math.round(entry * (1 + _wantPct) * 100) / 100;
        // A stop must sit below the market or the broker rejects/instantly triggers it.
        // STEPPED MODE ONLY: in flat mode the lock is the validated entry+lock level
        // and the trigger guarantees mark >= it, so clamping there would change
        // long-validated behaviour in the equality case (be-ratchet.test.js).
        if (_stepPct > 0 && mark > 0 && _lockLvl >= mark) _lockLvl = Math.round(mark * 0.999 * 100) / 100;
        if (_prevLock && _lockLvl <= _prevLock) continue;                  // stepped mode: only ever upward
        if (_top >= _lockLvl) { _beStopAt.set(sym, _top); _saveState(); continue; }  // a stop already sits at/above the lock — record it, leave it
        if (_wk.length) { await cancelRestingStops(bridge, userId, sym); _beCancels++; }
        _beStopAt.set(sym, _lockLvl);
        logTrade({ event: 'stop_resize', symbol: sym,
          reason: _firstLock
            ? `first_lock: mark +${((mark / entry - 1) * 100).toFixed(2)}% >= +${_firstLock.arm}% — stop rises to entry+${_firstLock.lock}% (TRADER_FIRST_LOCK; the ${_stepPct}% stepped floor takes over at its first step)`
            : _stepPct > 0
            ? `step_floor: mark +${((mark / entry - 1) * 100).toFixed(2)}% — stop steps up to entry+${(_wantPct * 100).toFixed(2)}% (${_stepPct}% steps, 2026-08-24)`
            : `be_ratchet: mark +${((mark / entry - 1) * 100).toFixed(2)}% >= +${(_bePct * 100).toFixed(1)}% — stop rises to ${_beLock > 0 ? `entry+${(_beLock * 100).toFixed(2)}% (profit lock, #3415)` : 'entry (#3413)'}`,
          entry, mark, stop_was: _top || null, stop_want: _lockLvl, lock: _wantPct || undefined, step: _stepPct || undefined, first_lock: _firstLock ? true : undefined });
        _saveState();   // the ratchet must survive a restart between cancel and re-protect
      }
      // Re-read orders after any cancel so the re-protect pass below sees the
      // symbol as unprotected and places the entry-level stop this scan.
      if (_beCancels) {
        const _fresh = await bridge.getIBKROpenOrders(userId).catch(() => null);
        if (Array.isArray(_fresh)) _openOrders = _fresh;
      }
    }
    // ── GAPPED STOP -> THE OPENING AUCTION (TRADER_GAP_STOP_TO_OPEN=1, default off): inside the pre-open
    //    window a stop the pre-market already trades through is cancelled and replaced by a market-on-open sell;
    //    if that is refused the stop goes straight back. Window _FROM/_TO (ET minutes), margin _MIN_BP. (H110) ──
    if (process.env.TRADER_GAP_STOP_TO_OPEN === '1' && extended && !_ordersUnknown) {
      const _gNow = _etMinOf(now);
      const _gFrom = Number(process.env.TRADER_GAP_STOP_TO_OPEN_FROM) || 560;   // 09:20 ET
      const _gTo = Number(process.env.TRADER_GAP_STOP_TO_OPEN_TO) || 568;       // 09:28 ET: Alpaca stops taking OPG orders then
      const _gMinBp = process.env.TRADER_GAP_STOP_TO_OPEN_MIN_BP != null && process.env.TRADER_GAP_STOP_TO_OPEN_MIN_BP !== '' && Number.isFinite(Number(process.env.TRADER_GAP_STOP_TO_OPEN_MIN_BP)) ? Number(process.env.TRADER_GAP_STOP_TO_OPEN_MIN_BP) : 10;
      if (_gNow >= _gFrom && _gNow < _gTo) {
        const _gDay = _etDateStr(now);
        let _gHanded = 0;
        for (const [sym, p] of Object.entries(heldPos)) {
          if (_sellExclude.has(sym)) continue;
          const _gHeld = Math.floor(Math.abs(Number(p.qty) || 0));
          if (_gHeld < 1 || _gapAuction.get(sym) === _gDay) continue;
          const _gStops = (_openOrders || []).filter((o) => String(o.symbol || '').toUpperCase() === sym
            && /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') && STOP_WORKING.test(o.status || ''));
          const _gTop = _gStops.reduce((a, o) => Math.max(a, Number(o.price) || Number(o.stopPrice) || 0), 0);
          const _gMark = Number(p.current_price) || 0;
          if (!(_gTop > 0) || !(_gMark > 0) || !(_gMark < _gTop * (1 - _gMinBp / 1e4))) continue;
          await cancelRestingStops(bridge, userId, sym);
          const _gR = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty: _gHeld, type: 'market', timeInForce: 'opg', equity: account.equity, acceptWarnings: true })
            .catch((e) => ({ status: 'error', reason: String((e && e.message) || e) }));
          if (_gR && (_gR.status === 'placed' || _gR.status === 'submitted')) {
            _gapAuction.set(sym, _gDay); _gHanded++;
            workingSells.add(sym);
            logTrade({ event: 'gap_stop_to_open', symbol: sym, qty: _gHeld, stop: _gTop, mark: _gMark, gap_bp: +((_gMark / _gTop - 1) * 1e4).toFixed(1), order_id: _gR.order_id || null,
              why: `pre-market ${_gMark} is under the stop ${_gTop}: the stop would fill after the opening print, so the position sells IN the opening auction (market-on-open, 2026-10-15)` });
          } else {
            // the auction order was refused: put the stop back at its ORIGINAL level, so the old behaviour (a sale at
            // the open) is what happens; if the broker refuses that too, the re-protect pass below re-attaches one.
            const _gBack = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty: _gHeld, type: 'stop', stopPrice: _gTop, timeInForce: 'gtc', equity: account.equity, acceptWarnings: true })
              .catch((e) => ({ status: 'error', reason: String((e && e.message) || e) }));
            if (_gBack && (_gBack.status === 'placed' || _gBack.status === 'submitted')) _registerStop(sym, _gBack, _gTop, _gHeld);
            logTrade({ event: 'gap_stop_to_open_failed', symbol: sym, qty: _gHeld, stop: _gTop, mark: _gMark, reason: (_gR && (_gR.reason || _gR.error)) || 'no response',
              restop: _gTop, restop_status: (_gBack && _gBack.status) || null, why: 'the opening-auction order was refused; the stop goes back at its original level' });
          }
        }
        if (_gHanded) _saveState();
        const _gFresh = await bridge.getIBKROpenOrders(userId).catch(() => null);
        if (Array.isArray(_gFresh)) _openOrders = _gFresh;
      }
    }
    for (const [sym, p] of Object.entries(heldPos)) {
      if (_ordersUnknown) break;                  // orders fetch unreadable this scan — never re-protect blind
      if (_sellExclude.has(sym)) continue;        // overnight-owned (its own engine protects/exits it) or filled this scan
      // A position handed to the opening auction has a working market-on-open sell: a stop on top of it
      // would oversell. Hold off until 09:35 ET; a position still held then gets its stop back.
      if (_gapAuction.get(sym) === _etDateStr(now) && _etMinOf(now) < 575) continue;
      const qty = Number(p.qty) || 0;
      if (qty > 0 && !hasStop(sym) && attemptsFor(sym) >= REPROTECT_MAX_ATTEMPTS) {
        (out.skipped = out.skipped || []).push({ symbol: sym, why: `re-protect capped: ${attemptsFor(sym)} prior stop order(s) exist but none is working (check for unconfirmed/Inactive orders)` });
        continue;
      }
      if (qty > 0 && !hasStop(sym)) {
        // Stacking guard (#3432): if the per-order status endpoint says our registered stop is working, the feed
        // is lying — don't stack another. (H111)
        const _regPre = _stopOrders.get(sym);
        if (_regPre && _regPre.id && typeof bridge.getIBKROrderStatus === 'function') {
          const _st = await bridge.getIBKROrderStatus(userId, _regPre.id).catch(() => null);
          if (_st && STOP_WORKING.test(String(_st.status || ''))) {
            (out.skipped = out.skipped || []).push({ symbol: sym, why: `re-protect skipped: registered stop ${_regPre.id} reports ${_st.status} while the feed shows none — feed blind, not naked (#3432)` });
            continue;
          }
        }
        const entry = Number(p.avg_entry_price || p.avg_fill_price || p.current_price) || 0;
        const curPx = Number(p.current_price) || 0;
        let stop = stopPriceFor(entry, _stopDistPct.get(sym) || c.stopPct);
        // #3413: a ratcheted symbol re-protects AT entry — never back down to the
        // stop-distance level. The below-market clamp still applies if price has
        // since fallen through entry (a sell-stop must sit under the market).
        const _beLvl = Number(_beStopAt.get(sym)) || 0;
        if (_beLvl > 0 && _beLvl > stop) stop = Math.round(_beLvl * 100) / 100;
        // A sell-stop must sit below the market: clamp an underwater long's stop to just under the price. (H112)
        if (stop && curPx > 0 && stop >= curPx) {
          // A ratcheted level at/above the market sits 0.1% under it instead of taking the underwater clamp (which
          // would erase the lock). (H113)
          stop = _beLvl > 0
            ? Math.round(curPx * (1 - 0.001) * 100) / 100
            : Math.round(curPx * (1 - Math.max(0.1, c.stopPct) / 100) * 100) / 100;
        }
        if (stop) {
          // Whole-share stops: a 300.8-share position (dust remnant + re-entry)
          // must protect 300 — a fractional stop qty is rejected outright.
          const _sq = Number(qty) >= 1 ? Math.floor(Number(qty)) : Number(qty);
          const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty: _sq, type: 'stop', stopPrice: stop, timeInForce: 'gtc', equity: account.equity, acceptWarnings: true }).catch((e) => ({ status: 'error', reason: e.message }));
          _registerStop(sym, sr, stop, _sq);   // #3379: remember our own stop's id
          (out.reprotected = out.reprotected || []).push({ symbol: sym, qty: _sq, stop, status: sr && sr.status });
        }
      }
    }
  } catch (_e) { /* fail-soft — the daily-loss breaker still guards the account */ }
}

// The entry loop: every gate, sizing and placement for each ENTER candidate. Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
async function _entryPass({
    _INVERSE_FAMILY, _bookWait, _bucketOpenedThisScan, _entryCandidates, _fundOnly, _gate, _grossThisScan, _notFund,
    _openedThisScan, _regimeNowMin, _regimeR30, _spyGateIbs, _spyIbsNow, _stressC, _vixPrior, account, bridge, c,
    dayPnl, entryBars, exclude, extended, haltEntries, heldPos, heldQty, now, opened, out, positions, protectiveOnly,
    scan, userId, workingSells
}) {
  for (const s of _entryCandidates) {
    let _cadenceExemptReentry = false;   // set by the cadence gate below; read at the placement site
    const sym = String(s.symbol).toUpperCase();
    const price = Number(s.entry_price) || 0;
    const held = heldQty[sym] || 0;
    const bullish = s.direction === 'BULLISH';
    // The skip row carries the EVIDENCE (decision_context), so "was that veto right?" is answerable later.
    // Entry candidates only. (H115)
    const record = { symbol: sym, direction: s.direction, p_win: s.convergence.p_win, news: s.news || null,
      ...(s.decision_context || {}) };
    // ── INVERSE-SPY GATE: a deep inverse while SPY sits at its highs is the
    //    trend working, not noise — the SOXS −$3.3k class (09-03, spyIBS 0.99
    //    at entry). New entries only; exits and held positions untouched. ──
    if (c.inverseSpyGate > 0 && _INVERSE_FAMILY.has(sym) && (heldQty[sym] || 0) <= 0
        && Number.isFinite(_spyGateIbs) && _spyGateIbs >= c.inverseSpyGate) {
      out.skipped.push({ ...record, why: `inverse_spy_gate: SPY session IBS ${_spyGateIbs.toFixed(2)} >= ${c.inverseSpyGate} — an inverse washout against a strong tape is the trend, not a dip` });
      continue;
    }

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
    // Opening fast-path: during the opening window (to 10:00 ET) one scan suffices instead of two; every other
    // gate applies. TRADER_OPEN_FASTPATH=0 disables. (H116)
    const _etNowMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
    const _openWindow = process.env.TRADER_OPEN_FASTPATH !== '0' && _etNowMin >= 570 && _etNowMin < 600;
    const _needScans = _openWindow ? 1 : c.persistScans;
    const persistent = !c.requirePersist || count >= _needScans;

    // ── BEARISH: only ever CLOSE a long we already hold. NEVER open or deepen a
    //    short (longs-only). Critically, cancel the resting protective stop when we
    //    close — an orphaned GTC stop would otherwise fire on the now-flat position
    //    and open an unintended short (this is what put JPM/META short). ──
    if (exclude.has(sym)) { out.skipped.push({ ...record, why: 'overnight-book position — managed by its own engine' }); continue; }
    if (!bullish) {
      // protectiveOnly (extended hours): the bearish read driving signal_exit is
      // computed off the same thin extended-session bars — skip it. Price
      // thresholds (trail/floor/max-loss) in manageHeldExits still run, and the
      // broker stop is untouched.
      if (protectiveOnly) { out.skipped.push({ ...record, why: 'extended hours: protective exits only — signal exit suppressed' }); continue; }
      if (held >= 1 && !_gate.allowed) { out.skipped.push({ ...record, why: `signal exit held — ${_gate.reason}` }); continue; }
      if (held >= 1) {
        // (held >= 1: a sub-share remnant can never fill a sell.)
        // Signal-exit anti-churn: not on a just-opened long, only on a STRONG bearish read, and it must persist.
        // ── IBS THESIS GATE: in IBS mode the signal does not sell until session IBS ≥ TRADER_IBS_EXIT; until then the
        //    floor, stop and ladder protect. A missing reading falls through to legacy (see maturity below). (H117)
        const _sIbs = _signalIbs(s);
        if (c.ibsExit > 0 && _sIbs != null && _sIbs < c.ibsExit) {
          out.skipped.push({ ...record, why: `washout thesis intact (IBS ${_sIbs.toFixed(2)} < ${c.ibsExit}) — no signal exit; floor/stop/ladder protect` });
          continue;
        }
        // ── SESSION-RANGE MATURITY: (a) a missing IBS reading means HOLD (TRADER_EXIT_NEEDS_IBS=0 restores the old
        //    fallthrough); (b) no signal exit until TRADER_EXIT_MIN_SESSION_MIN minutes into the session (default 30). (H118)
        if (c.ibsExit > 0) {
          const _mins = _sessionMinutes(now);
          if (_signalIbs(s) == null && process.env.TRADER_EXIT_NEEDS_IBS !== '0') {
            out.skipped.push({ ...record, why: 'no session IBS reading yet — holding (a missing ruler is not a bounce, 2026-08-24)' });
            continue;
          }
          if (_mins != null && _mins < c.exitMinSessionMin) {
            out.skipped.push({ ...record, why: `session ${_mins}min old (<${c.exitMinSessionMin}) — the session range is too young for a bounce read; stop/floor protect (2026-08-24)` });
            continue;
          }
        }
        const entryAt = _entryAt.get(sym) || 0;
        if (entryAt && now - entryAt < c.minHoldMs) { out.skipped.push({ ...record, why: `min-hold (${Math.round((now - entryAt) / 60000)}<${Math.round(c.minHoldMs / 60000)}min) — stop still protects` }); continue; }
        if (_isPinned(sym)) { out.skipped.push({ ...record, why: 'pinned — signal_exit suppressed by operator (#3318); stop/ladder still protect' }); continue; }
        if (c.zoneExit && _zoneLadder.has(sym)) { out.skipped.push({ ...record, why: 'zone ladder owns this exit (#3165) — R1/R2/floor + broker stop' }); continue; }
        if ((s.convergence.p_win || 0) < c.exitMinPwin) { out.skipped.push({ ...record, why: `bearish too weak to exit (p_win ${s.convergence.p_win} < ${c.exitMinPwin})` }); continue; }
        if (!persistent) { out.skipped.push({ ...record, why: `awaiting ${c.persistScans} consecutive bearish scans (persistence)` }); continue; }
        // Oversell guard: an exit sell is already resting for this symbol → don't stack another.
        if (workingSells.has(sym)) { out.skipped.push({ ...record, why: 'exit sell already resting — not stacking (oversell guard)' }); continue; }
        // Same exit-reattempt cooldown as the momentum/trailing path: a persistently
        // bearish name would otherwise re-fire this signal-exit EVERY scan while the
        // order rests unfilled (NVDA re-exited 179× in one session). Wait for the
        // resting order / next fill before re-attempting.
        const exitAt = _exitAt.get(sym) || 0;
        if (exitAt && (now - exitAt) < c.exitReattemptMs) { out.skipped.push({ ...record, why: `exit already fired ${Math.round((now - exitAt) / 60000)}min ago — waiting for it to fill` }); continue; }
        // acceptWarnings: this sell CLOSES an existing long — a risk-reducing order.
        // Leaving it on needs_confirmation is strictly worse than clearing the warning
        // (2026-07-27: every exit that session stalled, one ran on to -18.9%).
        const exOrder = (extended && price > 0)
          ? { ticker: sym, side: 'sell', qty: held, type: 'limit', limitPrice: Math.round(price * 0.998 * 100) / 100, outsideRth: true, acceptWarnings: true }
          : { ticker: sym, side: 'sell', qty: held, type: 'market', acceptWarnings: true };
        // #3660 A: cancel first, sell second (cancelRestingStops settles until the shares are released). (H119)
        const { r, retries, reserved } = await _sellAfterCancel(bridge, userId, sym, exOrder);
        if (reserved) {   // refused for reserved shares after the retries -- see _sellAfterCancel
          _keepOpenAfterReservedReject(sym, held, heldPos[sym] || {}, 'signal_exit', r, retries, price, out, now, record);
          console.warn('[Trading] signal_exit ' + sym + ' refused (shares still reserved) after ' + retries + ' retries -- position kept, next scan retries');
          continue;
        }
        _entryAt.delete(sym); _holdClockAt.delete(sym); _exitAt.set(sym, now);
        _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
        const hp = heldPos[sym] || {};
        // Realized P&L on the closed long (the position's unrealized P&L becomes real).
        _exitIntent.set(sym, 'signal_exit');
        logTrade({ event: 'exit_intent', symbol: sym, qty: held, entry: hp.avg_entry_price ?? null, mark: hp.current_price ?? null, reason: 'signal_exit', status: r && r.status,
          ref_px: Number(price) > 0 ? Number(price) : null,   // the signal's price the exit was decided on (2026-10-09)
          // #3660 B: the WHY is not optional -- this row used to say status:"error"
          // with no cause while the broker rejection text sat unread in r.reason.
          error: (r && r.status === 'error' && (r.reason || r.error)) || undefined,
          ...(retries ? { retries } : {}) });
        if (r && r.status === 'error') console.warn('[Trading] signal_exit ' + sym + ' placement failed: ' + (r.reason || r.error || 'unknown'));
        out.executed.push({ ...record, action: 'exit_long', qty: held, result: r });
        _lastOrderAt.set(sym, now);
      } else {
        out.skipped.push({ ...record, why: held < 0 ? 'already short — not deepening (longs-only)' : 'bearish, no long to exit' });
      }
      continue;
    }

    // ── BULLISH: open a long only if flat. Never pyramid; never sell. ──
    // Dust (below dustPct of equity) does not block re-entry; exits floor to whole shares. (H120)
    const _heldMv = Math.abs(Number(heldPos[sym] && heldPos[sym].market_value)
      || held * (Number(heldPos[sym] && heldPos[sym].current_price) || price || 0));
    const _isDustHolding = held > 0 && c.dustPct > 0 && _heldMv < account.equity * (c.dustPct / 100);
    if (_bookWait.wait) { out.skipped.push({ ...record, why: _bookWait.why }); continue; }
    // An exit the broker refused THIS scan left the position held, but the exit path already
    // dropped it from heldQty, so 'already long' below would read it as flat (2026-10-24).
    if (_exitKeptOpen.has(sym)) { out.skipped.push({ ...record, why: 'exit refused this scan (shares still reserved) -- still held, not re-bought' }); continue; }
    if (held > 0 && !_isDustHolding) { out.skipped.push({ ...record, why: 'already long' }); continue; }
    // Unexplained flat = feed dropout, not an opportunity (#3282): a confirmed holding with no exit to explain
    // its absence blocks the entry, bounded by _flatConfirmMs. (H121)
    {
      const _confAt = _lastConfirmedHold.get(sym);
      const _ttl = _flatConfirmMs();
      if (!(held > 0) && _confAt && _ttl > 0 && (now - _confAt) <= _ttl) {
        out.skipped.push({ ...record, why: `position feed shows flat but a holding was confirmed ${Math.round((now - _confAt) / 1000)}s ago with no exit on record — treating as a feed dropout, not a re-entry` });
        continue;
      }
    }
    // DIRECTION LOCK (lib/direction-lock.js): an inverse ETF is an economic short on
    // its underlying — never open a position whose direction opposes existing family
    // exposure (e.g. buying SQQQ while long TQQQ/QQQ, or vice versa). Closing is never
    // blocked; cross-family offsets (TQQQ+TZA) are allowed as relative value.
    {
      const dc = require('./direction-lock').conflicts(sym, positions);
      if (dc.conflict) { out.skipped.push({ ...record, why: `direction_conflict: opposite ${dc.family} exposure via ${dc.against.join('+') || 'held positions'}` }); continue; }
    }
    if (haltEntries) { out.skipped.push({ ...record, why: `daily-loss limit hit (day P&L ${Math.round(dayPnl)})` }); continue; }
    const last = _lastOrderAt.get(sym) || 0;
    if (now - last < c.cooldownMs) { out.skipped.push({ ...record, why: 'cooldown' }); continue; }
    if (!persistent) { out.skipped.push({ ...record, why: `awaiting ${_needScans} consecutive bullish scans (persistence)` }); continue; }
    if (opened >= c.maxNewPerScan) { out.skipped.push({ ...record, why: 'max new/scan reached' }); continue; }
    // Falling-knife veto: don't buy while down-momentum is still accelerating; wait for the MACD histogram to
    // turn. Measured to avoid magnitude, not to pick winners (#3357). (H122)
    if (c.entryKnifeFilter) {
      const closes = ((entryBars[sym] && entryBars[sym].bars) || []).map((b) => b.close).filter((x) => x > 0);
      const _knife = knifeReading(closes);
      if (_knife && _knife.fires) {
        out.skipped.push({ ...record,
          // the exact pair this verdict turned on, so the decision is auditable
          // without re-deriving it from a corpus that disagrees 30% of the time
          knife_hist: r4(_knife.hist), knife_prev: r4(_knife.prev),
          why: 'falling_knife — momentum still cratering (MACD hist<0 & deepening); waiting for the turn' });
        continue;
      }
    }
    // ── REVERSAL CONFIRMATION (TRADER_ENTRY_CONFIRM, default off): today's last N session closes must be
    //    rising (N=2 also refuses a new low). Too few session bars = "cannot confirm" = refused. (H123)
    if (c.entryConfirm > 0) {
      const _cc = _entryConfirmRead((entryBars[sym] && entryBars[sym].bars) || [], c.entryConfirm, now, c.confirmShape);
      if (_cc.ok && c.confirmShape && /fast-track/.test(String(_cc.why))) { try { logTrade({ event: 'confirm_path', symbol: sym, path: 'fast_track', why: String(_cc.why).slice(0, 100) }); } catch (_e) { /* observability only */ } }
      if (!_cc.ok) {
        out.skipped.push({ ...record, confirm_closes: _cc.closes,
          why: `entry_confirm — ${_cc.why} (need ${c.entryConfirm} rising close${c.entryConfirm > 1 ? 's' : ''} on ${c.momentumTf} session bars)` });
        continue;
      }
    }
    // Defensive: on a stray short, clear any stale resting orders before re-entering.
    if (held < 0) await cancelRestingStops(bridge, userId, sym);

    // ── SUPPORT-ENTRY GATE (#3165): for validated symbols, only take the long AT
    //    the support zone; the stop goes UNDER the zone (structural) instead of the
    //    plan's ATR distance. Entries away from support are skipped — that is the
    //    point: mid-chop entries are where the old RR (1:0.46) came from.
    let _supStopPx = null;
    if (c.supEntry && c.supEntrySyms.has(sym)) {
      const aAbs = Number(s.atr) > 0 ? Number(s.atr) : price * 0.005;
      const sup = (Array.isArray(s.zones) ? s.zones : [])
        .filter((z) => z && /SUPPORT/i.test(z.type || '') && Number(z.top || z.level) <= price * 1.001)
        .sort((x, y) => (y.top || y.level) - (x.top || x.level))[0];
      if (!sup) { out.skipped.push({ ...record, why: 'sup_entry: no support zone below price' }); continue; }
      const dist = (price - (sup.top || sup.level)) / aAbs;
      if (dist > c.supEntryAtr) { out.skipped.push({ ...record, why: `sup_entry: ${dist.toFixed(1)} ATR above support (max ${c.supEntryAtr}) — not at the zone` }); continue; }
      const cand = (sup.bottom || sup.level) - 0.25 * aAbs;
      if (cand > 0 && cand < price * 0.999) _supStopPx = cand;
      // Minimum stop distance: move the STOP PRICE out to stopMinPct (not just the sizing distance). (H124)
      if (_supStopPx != null && c.stopMinPct > 0) {
        _supStopPx = Math.min(_supStopPx, price * (1 - c.stopMinPct / 100));
      }
    }

    let sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    // Low-conviction size cut: below p_win 0.5 the size multiplier is capped at TRADER_LOWCONV_MULT (default
    // 0.5; 0 disables). (H125)
    const _lowConvMult = process.env.TRADER_LOWCONV_MULT === undefined ? 0.5 : Number(process.env.TRADER_LOWCONV_MULT);
    if (_lowConvMult > 0 && Number(record.p_win) > 0 && Number(record.p_win) < 0.5) {
      sizeMult = Math.min(sizeMult, _lowConvMult);
    }
    // Stop distance is an input to sizing, so resolve it first. Structural (support-entry) stop wins when
    // armed; the stopMinPct floor applies to every new entry. (H126)
    const _stopDist = Math.min(15, Math.max(c.stopMinPct, _supStopPx != null
      ? ((price - _supStopPx) / price) * 100
      : stopDistPctFor(price, s.plan, c, sym)));
    // Room tier: distance to the first resistance, in R (this trade's stop units).
    // No resistance above = open room = A-tier.
    // Resistances above price that are FAR ENOUGH to be real targets (c.tgtMinR).
    // Anything nearer is noise sitting on top of the entry — see tgtMinR above.
    const _resAbove = (Array.isArray(s.zones) ? s.zones : [])
      .filter((z) => z && /RESIST/i.test(z.type || '') && Number(z.level) > price * 1.001)
      .filter((z) => c.tgtMinR <= 0
        || ((Number(z.level) - price) / price) * 100 / Math.max(_stopDist, 1e-9) >= c.tgtMinR)
      .sort((x, y) => x.level - y.level);
    // Stop derived from target (stopFromTgt): stop = (distance to first real resistance) / n, so RR = n:1 by
    // construction. The stopMinPct floor still wins afterwards. (H127)
    let _stopDistEff = _stopDist;
    if (c.stopFromTgt > 0 && _resAbove[0]) {
      const _tgtPct = ((Number(_resAbove[0].level) - price) / price) * 100;
      _stopDistEff = Math.min(15, Math.max(c.stopMinPct, _tgtPct / c.stopFromTgt));
    }
    // Minimum entry RR: when the floored stop cannot pay at least minEntryRr, skip. (H128)
    if (c.minEntryRr > 0 && _resAbove[0]) {
      const _tgtPct = ((Number(_resAbove[0].level) - price) / price) * 100;
      const _rr = _tgtPct / Math.max(_stopDistEff, 1e-9);
      if (_rr < c.minEntryRr) {
        out.skipped.push({ ...record, why: `rr ${_rr.toFixed(2)}:1 below ${c.minEntryRr}:1 (target ${_tgtPct.toFixed(2)}% vs floored stop ${_stopDistEff.toFixed(2)}%)` });
        continue;
      }
    }
    let _roomR = null, _tier = 'A';
    if (c.roomTier) {
      const _res1 = _resAbove[0];
      if (_res1) {
        _roomR = ((_res1.level - price) / price) * 100 / Math.max(_stopDistEff, 1e-9);
        if (_roomR < c.roomMinR) _tier = 'B';
      }
      // A+ upgrade: room AND volume expansion (the confluence the OOS gate passed).
      if (_tier === 'A' && Number(s.volume_ratio) >= c.volAplus) _tier = 'A+';
    }
    // B-tier scales BOTH the risk target and the notional cap — support entries
    // have such tight structural stops that the 5% cap binds before the risk
    // target, and without scaling the cap the tiers would size identically.
    const _tierMult = _tier === 'B' ? c.roomBMult : (_tier === 'A+' ? c.aplusMult : 1);
    // #3428 STRESS MULTIPLIER: scales the cap AND the risk target (see _stressMultiplier).
    const _stress = _stressMultiplier({ vixPrior: _vixPrior, spyIbs: _spyIbsNow }, _stressC);
    const _symMult = _symbolSizeMult(sym);   // #3434 symbol tilt (1 when unset)
    // REGIME SIZE — a trend-down first-30m read scales LONG risk down for the
    // rest of the session. Size only; inverses (WITH the tape) exempt.
    const _regime = (c.regimeSizeMult > 0 && c.regimeSizeMult < 1 && _regimeNowMin >= 600
      && _regimeR30 != null && _regimeR30 <= c.regimeR30Max && !_INVERSE_FAMILY.has(sym)) ? c.regimeSizeMult : 1;
    // Hard per-position cap: tier / tilt / regime scale the risk target but may not lift the notional ceiling
    // above TRADER_MAX_POSITION_PCT; only STRESS lifts it (cap x TRADER_STRESS_MULT). trading-guard.js mirrors
    // cap x stress, so sizer and guard agree. (H129)
    const _capMult = Math.min(1, _tierMult * _symMult * _regime) * _stress.mult;
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxPositionPct: c.maxPositionPct * _capMult, riskPct: c.riskPct * _tierMult * _stress.mult * _symMult * _regime, stopDistPct: _stopDistEff });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }
    // Cash reserve: gross deployed capital is capped at maxGrossPct of equity (exits never blocked).
    // Daily circuit breaker: entries stop after the session's stop-fill limit. (H130)
    if (_breakerTripped(now, c.stopBreaker)) {
      out.skipped.push({ ...record, why: `circuit breaker: ${_stopFillsCount} stop-outs today (max ${c.stopBreaker}) — no new entries this session` });
      continue;
    }
    // NO FRIDAY ENTRIES — see _noFridayEntry. Entries only.
    if (_noFridayEntry(now)) {
      out.skipped.push({ ...record, why: 'no_friday_entries: the weekend flat sells at 15:50 — a Friday dip has no session to bounce (TRADER_NO_FRIDAY_ENTRIES=1)' });
      continue;
    }
    // ENTRY-HOUR BLOCK (#3427) — see _entryHourBlocked. Entries only.
    if (process.env.TRADER_ENTRY_BLOCK_ET) {
      const _ehMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
      const _ehb = _entryHourBlocked(_ehMin, process.env.TRADER_ENTRY_BLOCK_ET);
      if (_ehb) {
        out.skipped.push({ ...record, why: `entry_hour_block: ${String(Math.floor(_ehMin / 60)).padStart(2, '0')}:${String(_ehMin % 60).padStart(2, '0')} ET inside ${_ehb.label} — this bar's entries are negative on both lab halves (#3427)` });
        continue;
      }
    }
    // PER-SYMBOL ENTRY WINDOW (lab 2026-09-27) — see _symbolEntryBlocked. Entries only; shadow by default.
    if (process.env.TRADER_SYMBOL_ENTRY_BLOCK_ET) {
      const _seMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
      const _seb = _symbolEntryBlocked(sym, _seMin, process.env.TRADER_SYMBOL_ENTRY_BLOCK_ET);
      if (_seb) {
        const _seMode = String(process.env.TRADER_SYMBOL_ENTRY_BLOCK_MODE || 'shadow').toLowerCase() === 'live' ? 'live' : 'shadow';
        _symbolEntryBlockJournal(sym, _seMin, _seb, _seMode, now);
        if (_seMode === 'live') {
          out.skipped.push({ ...record, why: `symbol_entry_block: ${sym} at ${String(Math.floor(_seMin / 60)).padStart(2, '0')}:${String(_seMin % 60).padStart(2, '0')} ET inside ${_seb.label} — this name may not enter yet (lab 2026-09-27: leveraged index wrappers from 13:00)` });
          continue;
        }
      }
    }
    // ENTRY CADENCE (#3435) — see _entryCadenceBlocked. Entries only.
    if (Number(process.env.TRADER_ENTRY_CADENCE_MIN) > 0) {
      const _ecMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
      const _ecDay = _etDateStr(now);
      const _ecDecided = _cadenceDecided.day === _ecDay ? _cadenceDecided.boundary : null;   // decisions never carry across sessions
      const _ecb = _entryCadenceBlocked(_ecMin, process.env.TRADER_ENTRY_CADENCE_MIN, process.env.TRADER_ENTRY_CADENCE_PHASE, process.env.TRADER_ENTRY_CADENCE_WINDOW, _ecDecided);
      // a symbol this session already exited is a RECYCLE, not a new decision
      if (_ecb && _cadenceReentryExempt(sym, now)) {
        _cadenceExemptReentry = true;
        logTrade({ event: 'cadence_reentry', symbol: sym, et_min: _ecMin,
          would_block: _ecb.why, next_decision: _ecb.label,
          exited_at: new Date(Number(_exitAt.get(sym)) || 0).toISOString() });
      } else if (_ecb) {
        out.skipped.push({ ...record, why: `entry_cadence: ${String(Math.floor(_ecMin / 60)).padStart(2, '0')}:${String(_ecMin % 60).padStart(2, '0')} ET ${_ecb.why === 'decided' ? 'already decided this bar' : 'is between bar closes'} — next decision ${_ecb.label} (#3435)` });
        continue;
      }
      // The cadence boundary is not spent here — only when an entry actually places (_markCadenceDecided). (H131)
      const _ecBoundary = _ecMin - ((((_ecMin - (Number(process.env.TRADER_ENTRY_CADENCE_PHASE) || 0)) % Number(process.env.TRADER_ENTRY_CADENCE_MIN)) + Number(process.env.TRADER_ENTRY_CADENCE_MIN)) % Number(process.env.TRADER_ENTRY_CADENCE_MIN));
      // `since`/`win` travel with the pending boundary so the placement site can tell an
      // in-window fill (others still get to compete) from a late-first-scan fill (spends the bar).
      _pendingCadence = { day: _ecDay, boundary: _ecBoundary, since: _ecMin - _ecBoundary,
        win: Math.max(1, Math.floor(Number(process.env.TRADER_ENTRY_CADENCE_WINDOW)) || 3) };
    }
    // Post-stop re-entry cooldown: barred through the recorded ET date. Read unconditionally (not gated on
    // stopCooldownDays) because the same map carries the breakeven-ratchet session bar. (H132)
    {
      const _cdThrough = _stopCooldownThrough.get(sym);
      if (_cdThrough && _etDate(now) <= _cdThrough) {
        out.skipped.push({ ...record, why: c.stopCooldownDays > 0
          ? `post-stop cooldown: stopped out, no re-entry through ${_cdThrough}`
          : `be_ratchet session bar: breakeven exit this session — no re-entry through ${_cdThrough}` });
        continue;
      }
      if (_cdThrough) { _stopCooldownThrough.delete(sym); _saveState(); }   // expired → clean up
    }
    // Concurrent-position cap (maxConcurrent): truncates tail severity (concurrency x stop width). (H133)
    if (c.maxConcurrent > 0) {
      // Dust exclusion: a slot is consumed only by a position that is economically meaningful and exitable. (H134)
      const _dustFloor = account.equity * (c.dustPct / 100);
      // Count entries opened THIS scan too — heldPos is a start-of-scan snapshot. (H135)
      const _openN = _openedThisScan + Object.values(heldPos).filter((p) => {
        const q = Math.abs(Number(p.qty) || 0);
        if (!(q > 0)) return false;
        if (!_notFund(p)) return false;                                         // the reserve fund is cash, not a slot
        if (_unclosable.has(String(p.symbol).toUpperCase())) return false;   // cannot be exited -> not a slot
        const mv = Math.abs(Number(p.market_value) || q * (Number(p.current_price) || 0));
        return mv >= _dustFloor;
      }).length;
      if (_openN >= c.maxConcurrent) {
        out.skipped.push({ ...record, why: `concurrent cap: ${_openN} positions open (max ${c.maxConcurrent})` });
        continue;
      }
      // Slot reserve by conviction (#3317): below TRADER_SLOT_RESERVE_PWIN a signal may fill up to
      // (cap − reserve); every refusal logs an audit row. Kill: TRADER_SLOT_RESERVE=0. (H136)
      if (c.slotReserve > 0 && (Number(record.p_win) || 0) < c.slotReservePwin
        && _openN >= c.maxConcurrent - c.slotReserve) {
        out.skipped.push({ ...record, why: `slot reserve: ${_openN}/${c.maxConcurrent} open and the last ${c.slotReserve} slot(s) are reserved for p_win ≥ ${c.slotReservePwin} — this signal is ${(Number(record.p_win) || 0).toFixed(3)}` });
        continue;
      }
    }
    // Correlated-risk cap: count positions by direction BUCKET (inverse ETFs are one bet), including those
    // opened this scan. (H137)
    if (c.maxPerBucket > 0) {
      const { riskBucket, bucketCounts } = require('./direction-lock');
      const _bucket = riskBucket(sym);
      const _counts = bucketCounts(Object.values(heldPos).filter(_notFund));
      const _inBucket = (_counts[_bucket] || 0) + (_bucketOpenedThisScan[_bucket] || 0);
      if (_inBucket >= c.maxPerBucket) {
        out.skipped.push({ ...record, why: `correlated-risk cap: ${_inBucket} position(s) already in '${_bucket}' (max ${c.maxPerBucket})` });
        continue;
      }
    }
    if (c.maxGrossPct > 0 && c.maxGrossPct < 100) {
      // The overnight book's names count here (its notional is exposure); the reserve fund does not (it is the cash kept).
      const _gross = _grossThisScan + Object.values(heldPos).filter((p) => !_fundOnly.has(String((p && p.symbol) || '').toUpperCase())).reduce((a, p) => a + Math.abs(Number(p.market_value) || (Number(p.qty) || 0) * (Number(p.current_price) || 0)), 0);
      const _budget = account.equity * (c.maxGrossPct / 100);
      if (_gross + qty * price > _budget) {
        out.skipped.push({ ...record, why: `cash reserve: gross $${Math.round(_gross).toLocaleString()} + $${Math.round(qty * price).toLocaleString()} would exceed ${c.maxGrossPct}% of equity ($${Math.round(_budget).toLocaleString()})` });
        continue;
      }
    }

    // acceptWarnings on entries: leveraged/inverse disclosure prompts are acknowledged by design.
    // refPrice = the quote this entry was sized from, so the guard's cap can price a market buy. (H138)
    const enOrder = (extended && price > 0)
      ? { ticker: sym, side: 'buy', qty, type: 'limit', limitPrice: Math.round(price * 1.002 * 100) / 100, outsideRth: true, equity: account.equity, acceptWarnings: true, refPrice: price }
      : { ticker: sym, side: 'buy', qty, type: 'market', equity: account.equity, acceptWarnings: true, refPrice: price };
    // ENTRY RE-QUOTE GUARD — see requoteRead.
    //   TRADER_ENTRY_REQUOTE=shadow : fresh print fetched BESIDE the order; rows only.
    //   TRADER_ENTRY_REQUOTE=refuse : fresh print fetched BEFORE the order; past TRADER_ENTRY_REQUOTE_CAP_BPS from
    //     the decision quote the entry is skipped (skip row + entry_requote refused:true). No fresh quote = the
    //     order places. Default off. (H139)
    const _rqMode = String(process.env.TRADER_ENTRY_REQUOTE || '').toLowerCase();
    const _rqCap = Number(process.env.TRADER_ENTRY_REQUOTE_CAP_BPS) || 5;
    const _rqWanted = (_rqMode === 'shadow' || _rqMode === 'refuse') && !extended && price > 0;
    const _rqFetch = () => yahoo.getQuotes([sym], { fresh: true }).then((qs) => (qs && qs[0] && Number(qs[0].price) > 0 ? Number(qs[0].price) : null)).catch(() => null);
    const _rqScanTs = scan && scan.timestamp ? Date.parse(scan.timestamp) : NaN;
    const _rqAge = Number.isFinite(_rqScanTs) ? Math.max(0, Date.now() - _rqScanTs) : null;
    let r = null, _rqQuote = null;
    if (_rqWanted && _rqMode === 'refuse') {
      _rqQuote = await _rqFetch();
      const _rqPre = requoteRead({ decisionPx: price, freshPx: _rqQuote, capBps: _rqCap });
      if (_rqPre && _rqPre.would_refuse) {
        logTrade({ event: 'entry_requote', symbol: sym, mode: 'refuse', decision_px: price, requote_px: _rqQuote, ..._rqPre, decision_age_ms: _rqAge, refused: true });
        out.skipped.push({ ...record, why: `requote_guard: the quote ran ${_rqPre.drift_bps >= 0 ? '+' : ''}${_rqPre.drift_bps} bp past the decision ${price} (cap ${_rqCap} bp) — entry refused` });
        continue;
      }
      r = await bridge.placeIBKROrder(userId, enOrder).catch((e) => ({ status: 'error', reason: e.message }));
    } else {
      [r, _rqQuote] = await Promise.all([
        bridge.placeIBKROrder(userId, enOrder).catch((e) => ({ status: 'error', reason: e.message })),
        _rqWanted ? _rqFetch() : Promise.resolve(null),
      ]);
    }
    if (_rqWanted && r && r.status === 'placed') {
      const _rq = requoteRead({ decisionPx: price, freshPx: _rqQuote, capBps: _rqCap });
      if (_rq) _requoteShadow.set(sym, { requote_px: _rqQuote, limit_px: _rq.limit_px, cap_bps: _rq.cap_bps, would_refuse: _rq.would_refuse });
      logTrade({ event: 'entry_requote', symbol: sym, mode: _rqMode, decision_px: price, requote_px: _rqQuote,
        ...(_rq || { drift_bps: null, cap_bps: _rqCap, limit_px: null, would_refuse: null }),
        decision_age_ms: _rqAge, why: _rqQuote ? undefined : 'no fresh quote' });
    }
    const exec = { ...record, action: 'open_long', qty, notional: Math.round(qty * price), result: r };
    // Attach a broker-side protective stop on the placed long — the hard stop the
    // position keeps even if the scan loop dies. Cancelled on the signal exit above.
    if (r && r.status === 'placed') {
      // The PLACED stop is the same stop that sized the position and passed the RR gate (_stopDistEff). (H140)
      const stopDist = _stopDistEff;   // resolved before sizing (risk-based)
      _stopDistPct.set(sym, stopDist);
      const stop = stopPriceFor(price, stopDist);
      if (stop) {
        const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc', acceptWarnings: true }).catch((e) => ({ status: 'error', reason: e.message }));
        _registerStop(sym, sr, stop, qty);   // #3379: remember our own stop's id
        exec.stop = { price: stop, status: sr && sr.status, order_id: sr && sr.order_id };
      }
    }
    if (r && r.status === 'placed' && c.zoneExit
      && (c.zoneExitSyms === 'all' || c.zoneExitSyms.has(sym))) {
      // Arm the ladder for EVERY entry (#3285); blue sky arms rungs at the plan targets. Tightening the rungs was
      // falsified (TRADER_LADDER_VOL_MULT>0 keeps it for a re-test; off by default). (H141)
      const res = _resAbove;
      const pl0 = s.plan || {};
      let _fbR1 = Number(pl0.target1) > price ? Number(pl0.target1) : price * 1.03;
      let _fbR2 = Number(pl0.target2) > _fbR1 ? Number(pl0.target2) : price * 1.051;
      if (c.ladderVolMult > 0) {           // experimental, falsified at defaults — see table above
        const _atr15 = Number(s.atr) || 0;
        const _dayVolPct = Math.min(6, Math.max(0.6, (_atr15 > 0 && price > 0)
          ? (_atr15 / price) * Math.sqrt(26) * 100 : 1.2));
        _fbR1 = price * (1 + (c.ladderVolMult * _dayVolPct) / 100);
        _fbR2 = price * (1 + (1.7 * c.ladderVolMult * _dayVolPct) / 100);
      }
      const _r1 = res[0] ? Number(res[0].level) : _fbR1;              // zone first — #3165 unchanged
      let _r2 = res[1] ? Number(res[1].level) : Math.max(_fbR2, _r1 * 1.004);
      if (!(_r2 > _r1)) _r2 = _r1 * 1.004;                            // rungs must ascend
      const _r1top = res[0] ? (res[0].top || res[0].level) : _r1;
      _zoneLadder.set(sym, { r1: _r1, r1top: _r1top, r2: _r2, broke: false });
    }
    if (r && r.status === 'placed') {
      // A cadence-exempt RE-ENTRY does not spend the bar: it was never this bar's
      // decision to make, so consuming the hour would take the slot from a fresh
      // symbol and re-create the lockout this exemption exists to remove.
      if (!_cadenceExemptReentry) _markCadenceDecided();
      const pl = s.plan || {};
      _pendingFillBasis.set(sym, { quote: price, ts: now });   // #3407: basis check armed
      _limitShadowArm(sym, price, now);                        // #3424: journal the limits we did not place
      logTrade({ event: 'entry', symbol: sym, side: 'long', qty, entry: price, reentry: _cadenceExemptReentry || undefined, notional: Math.round(qty * price), stress_mult: _stress.mult > 1 ? _stress.mult : undefined, stress_why: _stress.why || undefined, vix_prior: _vixPrior != null ? _vixPrior : undefined, sym_mult: _symMult !== 1 ? _symMult : undefined, p_win: s.convergence && s.convergence.p_win, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null, target1: pl.target1 ?? null, target2: pl.target2 ?? null, hold_days: pl.hold_days ?? null, tier: _tier, room_r: _roomR != null ? +_roomR.toFixed(2) : null, vol_ratio: Number(s.volume_ratio) || null,
        // drift-day attribution (2026-08-11): SPY's same-day % at entry time, so
        // the report can split entry outcomes by tape without guessing later.
        spy_1d: (scan && Number.isFinite(Number(scan.spy_1d))) ? Number(scan.spy_1d) : null,
        entry_src: 'quote',   // #3407: honest label — the fill basis arrives via entry_fill
        // Mirror journal (#3390): for leveraged entries, record the same-leverage opposite instrument and its price
        // at decision time. Fail-soft. (H142)
        ...(await (async () => {
          try {
            const _mir = require('./direction-lock').mirrorOf(sym);
            if (!_mir) return {};
            const _q = await yahoo.getQuotes([_mir]).catch(() => null);
            const _px = _q && _q[0] && Number(_q[0].price) > 0 ? Number(_q[0].price) : null;
            return { mirror: _mir, mirror_px: _px };
          } catch (_e) { return {}; }
        })()) });
      // ENTRY JUDGE (#3390): a second opinion on this exact entry, in SHADOW —
      // journal-only, fire-and-forget, scored later against the real outcome
      // and the redirect counterfactual. Cannot delay or touch the order.
      try {
        const _ej = require('./entry-judge');
        if (_ej.enabled()) {
          _ej.judge({ symbol: sym, price, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null,
            notional: Math.round(qty * price), p_win: s.convergence && s.convergence.p_win,
            ...(s.decision_context || {}) }).catch(() => {});
        }
      } catch (_e) { /* the judge must never touch an entry */ }
      _riseShadowTag({ symbol: sym, account: userId, qty, price, now });   // journal only, never awaited (lib/rise-shadow.js)
      tagEntry({ symbol: sym, account: userId, qty, price, now, order_id: r.order_id ?? r.orderId, source: 'trader' });   // journal only, never awaited (lib/entry-tags.js)
      planEntry({ symbol: sym, account: userId, qty, price, now, order_id: r.order_id ?? r.orderId, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null }, s, scan);   // journal only, never awaited (lib/trade-plan.js)
    }
    // ── An entry that did NOT place is narrated (entry_blocked row with the broker's reason) and arms the
    // re-entry cooldown, so a warned symbol cannot re-fire every scan. Entries never pass acceptWarnings on a
    // warning; this adds observability + a brake only. (H143)
    if (r && r.status !== 'placed' && r.status !== 'dry_run') {
      // Surface the broker's actual warning messages (its note is generic). (H144)
      const _warnTxt = Array.isArray(r.warnings) && r.warnings.length
        ? r.warnings.map((w) => (w && (w.message || w.text || w)) ?? '').join(' || ').slice(0, 300)
        : '';
      const why = r.reason || r.error || (_warnTxt ? `${r.note || r.status}: ${_warnTxt}` : r.note) || r.status || 'unknown';
      logTrade({
        event: 'entry_blocked', symbol: sym, side: 'long', qty,
        entry: price, notional: Math.round(qty * price),
        status: r.status || 'unknown', reason: String(why).slice(0, 400),
      });
      console.warn(`[Trading] entry BLOCKED ${sym} x${qty} — ${r.status}: ${String(why).slice(0, 180)}`);
    }
    out.executed.push(exec);
    // Fresh position = fresh excursions: reset _peak/_trough at placement. (H145)
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') { _peak.delete(sym); _trough.delete(sym); _entryAt.set(sym, now); _saveState(); opened += 1; _openedThisScan += 1;
      try { const _b = require('./direction-lock').riskBucket(sym); _bucketOpenedThisScan[_b] = (_bucketOpenedThisScan[_b] || 0) + 1; } catch (_e) { /* bucketing is advisory */ } _grossThisScan += qty * price;
      // CSP SHADOW BOOK (#3219, observer only — never places orders): record the
      // paper cash-secured-put leg for this same signal, paired by symbol+ts.
      // Fire-and-forget: the chain fetch must never delay or break the scan.
      try { require('./csp-shadow').onEntry({ symbol: sym, price, qty, ts: now }).catch(() => {}); } catch (_e) { /* shadow book absent → nothing */ }
    } }
    else if (r) { _lastOrderAt.set(sym, now); }   // blocked → back off for the cooldown rather than re-fire every scan
  }
  return { _openedThisScan };
}

// Slot-utilization row on change. Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
function _logSlotUtil({ _notFund, _openedThisScan, account, c, heldPos }) {
  if (process.env.TRADER_LOG_SKIPS !== '0' && c.maxConcurrent > 0) {
    const _dustFloorU = account.equity * (c.dustPct / 100);
    const _slotSyms = Object.values(heldPos).filter((p) => {
      const q = Math.abs(Number(p.qty) || 0);
      if (!(q > 0)) return false;
      if (!_notFund(p)) return false;   // same slot definition as the cap: the reserve fund is not a slot
      if (_unclosable.has(String(p.symbol).toUpperCase())) return false;
      const mv = Math.abs(Number(p.market_value) || q * (Number(p.current_price) || 0));
      return mv >= _dustFloorU;
    }).map((p) => String(p.symbol).toUpperCase()).sort();
    const _used = _slotSyms.length + _openedThisScan;
    const _sig = `${_used}/${c.maxConcurrent}:${_slotSyms.join(',')}`;
    if (_lastSlotSig !== _sig) {
      _lastSlotSig = _sig;
      logTrade({
        event: 'slot_util', slots_used: _used, cap: c.maxConcurrent,
        held: _slotSyms, opened_this_scan: _openedThisScan,
      });
    }
  }
}

// Session record at/after the close (+ the optional post-close review). Moved verbatim out of _runAutoTradeInner; the caller passes the locals it uses.
async function _writeSessionRecord({ _notFund, _ourSyms, account, heldPos, now, userId }) {
  try {
    const _sr = require('./session-record');
    const _ledger = fs.existsSync(TRADES_LOG) ? fs.readFileSync(TRADES_LOG, 'utf8') : '';
    if (_sr.shouldWriteSession(_ledger, now)) {
      // Ownership filter: only this engine's symbols (_ourSyms) feed carried_out / open_risk / Day P&L. The
      // partition (reserve fund + overnight book) is taken out first and reported as partition_out. (H148)
      const _held = Object.values(heldPos).filter((p) => Math.abs(Number(p && p.qty) || 0) > 0);
      const _mine = _held.filter((p) => {
        const k = String(p && p.symbol || '').toUpperCase();
        if (!_notFund(p)) return false;
        return !_ourSyms.size || _ourSyms.has(k);
      });
      const _dp = await require('./day-pnl').computeDayPnl({
        positions: _mine,
        ledgerText: _ledger,
        now,
        getQuotes: (syms) => require('./market-data-yahoo').getQuotes(syms),
      }).catch(() => ({}));
      // The ACCOUNT's day beside this book's (2026-10-26): the equity change since the previous
      // session's close, from this ledger's own session rows (lib/day-pnl prevSessionEquity). Recorded
      // next to day_pnl, never mixed into it: a sleeve's book is not the whole account.
      try {
        const _prevEq = require('./day-pnl').prevSessionEquity(_ledger, now);
        if (_prevEq && Number(account && account.equity) > 0) {
          _dp.account_day_pnl = Math.round((Number(account.equity) - _prevEq.equity) * 100) / 100;
          _dp.prev_equity = _prevEq.equity;
        }
      } catch (_e) { /* the book's own figures stand */ }
      logTrade(_sr.buildSessionRecord({
        ledgerText: _ledger, now, account, positions: _mine, dayPnl: _dp,
        partition: _held.filter((p) => !_notFund(p)),
      }));
      // Post-close review (#3359): fire-and-forget after the session row is written, reading the ledger FRESH
      // (the _ledger snapshot predates that row; fall back to it if the read fails). It holds no bridge — it can
      // only journal findings. Default off: TRADER_SESSION_REVIEW=1. (H149)
      try {
        const _rev = require('./session-review');
        if (_rev.enabled()) {
          const _day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          let _ledgerFresh = _ledger;
          try { _ledgerFresh = fs.readFileSync(TRADES_LOG, 'utf8'); } catch (_e) { /* snapshot fallback */ }
          _rev.review({ ledgerText: _ledgerFresh, day: _day })
            .then((r) => {
              // Summarise into the trade ledger (a pointer row); the findings stay in session-reviews.jsonl. (H150)
              const _ptr = _rev.pointerRow(r, { ts: new Date(now).toISOString(), user: userId, date: _day });
              if (_ptr) logTrade(_ptr);
            })
            .catch(() => { /* the reviewer never escalates */ });
        }
      } catch (_e) { /* a missing reviewer must not affect the close */ }
    }
  } catch (_e) { /* observability only — never breaks the scan */ }
}
let _lastSlotSig = null;   // last logged slots-in-use signature (change-only dedupe)

// ── SKIP-REASON OBSERVABILITY: log a symbol's skip reason only when it CHANGES (digits normalised out of
// the key). Kill: TRADER_LOG_SKIPS=0. (H151)
const _lastSkipWhy = new Map();
function _logSkips(skipped) {
  if (process.env.TRADER_LOG_SKIPS === '0' || !Array.isArray(skipped)) return;
  const seen = new Set();
  for (const s of skipped) {
    if (!s || !s.symbol) continue;
    seen.add(s.symbol);
    const why = String(s.why || 'unknown');
    const key = why.replace(/\d+(\.\d+)?/g, '#');          // ignore churning counters
    if (_lastSkipWhy.get(s.symbol) === key) continue;      // same blocker as last scan → already on record
    _lastSkipWhy.set(s.symbol, key);
    // Evidence pass-through (#3381): the skip-row whitelist includes the decision_context evidence keys. (H152)
    const _ev = {};
    for (const k of ['ibs', 'spy_tape', 'spy_mom30', 'regime', 'et_min', 'macd_hist', 'in_zone', 'sign', 'knife_hist', 'knife_prev']) {
      if (s[k] !== undefined) _ev[k] = s[k];
    }
    logTrade({
      event: 'skip', symbol: s.symbol, direction: s.direction ?? null,
      p_win: s.p_win ?? null, reason: why.slice(0, 300), ..._ev,
    });
  }
  // A symbol that stops being skipped must forget its reason, so that if the
  // SAME blocker returns later it is recorded again as a new occurrence.
  for (const sym of [..._lastSkipWhy.keys()]) if (!seen.has(sym)) _lastSkipWhy.delete(sym);
}

/** Test/ops helper: clear the per-symbol state (memory + on-disk snapshot). */
function _resetCooldowns() { _exitKeptOpen.clear(); _lastSlotSig = null; _stopCooldownThrough.clear(); _stopFillsDay = null; _stopFillsCount = 0; _lastSkipWhy.clear(); _ordersSeenWorking.clear(); _lastOrderAt.clear(); _entryAt.clear(); _holdClockAt.clear(); _dirStreak.clear(); _peak.clear(); _trough.clear(); _excursion.clear(); _exitAt.clear(); _exitStatus.clear(); _lastPos.clear(); _exitFailures.clear(); _unclosable.clear(); _unclosableAt.clear(); _exitNoOrder.clear(); _zoneLadder.clear(); _stopDistPct.clear(); _lastConfirmedHold.clear(); _stopOrders.clear(); _beStopAt.clear(); _gapAuction.clear(); _limitShadow.clear(); _absentStreak.clear(); _seenStreak.clear(); _trustedBook.clear(); _exitsHeldNoted.clear(); _maxLossHeldNoted.clear(); _cadenceDecided = { day: null, boundary: null }; _pendingCadence = { day: null, boundary: null }; _saveState(); }

module.exports = { _noFridayEntry, _parseSymbolWindows, _symbolEntryBlocked, _symbolEntryBlockJournal, _sessionsHeld, _holdClockAt, _peak, _trough, _reconcileFills, _entryAtSet: (sym, ts) => _entryAt.set(sym, ts), _entryConfirmRead, _cadenceReentryExempt, _exitAtSet: (sym, ts) => _exitAt.set(sym, ts), _deferredExit, _isDeferrableExit, _extDeferEnabled, _closeLongForTest: closeLong, _sellAfterCancel, _isQtyReservedReject, _exitKeptOpen, _entryAtGet: (sym) => _entryAt.get(sym), _exitAtGet: (sym) => _exitAt.get(sym), _exitStatusGet: (sym) => _exitStatus.get(sym), _manageHeldExitsForTest: manageHeldExits, _isFailedStop: isFailedStop, _STOP_WORKING: STOP_WORKING, _STOP_TERMINAL: STOP_TERMINAL, runAutoTrade, fastExitTick, sizePosition, cfg, trailTriggerPct, isFallingKnife, knifeReading, snapshotForeignRows, manageHeldExits, _feedGuard: { absentStreak: _absentStreak, seenStreak: _seenStreak }, _stopOrders, _beStopAt, _entryHourBlocked, _parseEtWindows, _entryCadenceBlocked, _sessionMinutes, _markCadenceDecided, _cadenceForTest: { decided: () => ({ ..._cadenceDecided }), setPending: (p) => { _pendingCadence = { ...p }; }, forgetInMemory: () => { _cadenceDecided = { day: null, boundary: null }; _pendingCadence = { day: null, boundary: null }; } }, _signalIbs, _exitAuthorityConflicts, _orderEntries, _regimeFirst30Read, _stressMultiplier, _stressCfg, _vixPriorClose, _symbolSizeMult, _limitShadow: { map: _limitShadow, arm: _limitShadowArm, tick: _limitShadowTick, close: _limitShadowClose, depths: LIMIT_SHADOW_DEPTHS }, cancelRestingStops, _pendingFillBasis, _checkFillBasis, _firstLockCfg, requoteRead, _requoteShadow, _resetCooldowns, _logSkips, _saveState, _loadState, STATE_FILE, logTrade, tagEntry };
