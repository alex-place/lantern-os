'use strict';

const fs = require('fs');
const path = require('path');
const yahoo = require('./market-data-yahoo');
const { macd, rsi, emaSeries } = require('./signal-engine/indicators');

// Per-trade outcome log (append-only JSONL) — the honest record that lets us
// MEASURE the autopilot's realized edge (win-rate / P&L) against the backtest,
// instead of eyeballing it. Resolved relative to this module so it's found
// regardless of the server's cwd (same reason as the credential store).
// TRADER_TRADES_LOG / TRADER_STATE_FILE override the paths so a test can exercise the
// real append + reconciliation without writing into the operator's live ledger.
const TRADES_LOG = process.env.TRADER_TRADES_LOG
  ? path.resolve(process.env.TRADER_TRADES_LOG)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
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
  maxLossPct: 8,           // HARD max-loss backstop: market-exit a long down ≥ this %
                           //    from entry, REGARDLESS of momentum. Catches a loser whose
                           //    broker stop never placed/filled (gap-down, missing stop) —
                           //    without it, the only loss protection is the entry STP, so a
                           //    position with no stop runs unbounded (the -17% TSLA case).
  maxDailyLossPct: 2,      // halt NEW entries once day P&L ≤ -this% of equity
  // ── Anti-churn (added after a 103-fill/-$1k whipsaw day) ──────────────────
  minHoldMin: 20,          // don't signal-EXIT a long within N min of entering
  exitMinPwin: 0.6,        // only exit on a STRONG bearish signal (p_win ≥ this)
  persistScans: 2,         // act only after the same direction holds N consecutive scans
  persistWindowMs: 200000, // …seen within this window (≈3 scans) — else it's stale
  // ── Momentum / trailing exits — capture the peak instead of round-tripping it ──
  trailPct: 2.5,           // BASE trailing stop: exit a long if price falls this % from its PEAK
                           //    (ratcheted TIGHTER as the peak gain grows — see trailTriggerPct)
  trailArmPct: 1.5,        // …but arm the trail only once the position has gained ≥ this %
                           //    (so it locks GAINS; the entry−stopPct broker stop covers losses)
  takeProfitPct: 0,        // hard take-profit % (0 = off — let the trailing stop run)
  takeProfitR: 1,          // R-MULTIPLE take-profit: exit at +takeProfitR × risk (risk =
                           //    stopPct). Backtests show this engine's winners don't run —
                           //    a tight 1R target beat 2R/3R on every basket (leveraged/
                           //    inverse ETFs: 55% win, PF 1.17 at 1R vs 33% / 0.77 at 2R).
                           //    0 = off (let the trailing stop run instead).
  // After firing an exit for a symbol, don't re-fire for this long. In extended hours an
  // exit limit can sit unfilled, and without this the loop re-placed the SAME exit every
  // scan — 30+ phantom "exit" log rows for one still-open position, and stacked orders.
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
    maxNewPerScan: n('TRADER_MAX_NEW_PER_SCAN', DEFAULTS.maxNewPerScan),
    cooldownMs: n('TRADER_COOLDOWN_MS', DEFAULTS.cooldownMs),
    stopPct: n('TRADER_STOP_PCT', DEFAULTS.stopPct),                     // protective stop distance
    maxLossPct: n('TRADER_MAX_LOSS_PCT', DEFAULTS.maxLossPct),           // hard max-loss backstop exit
    maxDailyLossPct: n('TRADER_MAX_DAILY_LOSS_PCT', DEFAULTS.maxDailyLossPct), // circuit breaker
    minHoldMs: n('TRADER_MIN_HOLD_MIN', DEFAULTS.minHoldMin) * 60000,    // anti-churn: min hold before exit
    exitReattemptMs: n('TRADER_EXIT_REATTEMPT_MIN', DEFAULTS.exitReattemptMin) * 60000, // anti-churn: min gap between exit attempts on the SAME symbol
    exitMinPwin: n('TRADER_EXIT_MIN_PWIN', DEFAULTS.exitMinPwin),        // anti-churn: exit only on strong bearish
    persistScans: n('TRADER_PERSIST_SCANS', DEFAULTS.persistScans),      // anti-churn: N consecutive scans
    persistWindowMs: n('TRADER_PERSIST_WINDOW_MS', DEFAULTS.persistWindowMs),
    requirePersist: process.env.TRADER_REQUIRE_PERSIST !== '0',          // on by default
    allowShorts: process.env.TRADER_ALLOW_SHORTS === '1',
    // Zone-ladder exit (#3165, OOS-validated on SPY+QQQ only): sell at the first
    // resistance zone unless price punches THROUGH it — then the second zone is the
    // target and the first becomes the floor. Ladder symbols skip take-profit/trail/
    // momentum/signal exits (the ladder + broker stop own the position).
    // ATR-based protective stops (operator decision 2026-08-04): use the signal's
    // own ATR/S-R trade-plan stop (what the backtests actually validated) instead of
    // a flat stopPct, clamped to [atrStopMinPct, atrStopMaxPct]. The flat stopPct
    // remains the fallback when a signal ships no plan. Kill: TRADER_ATR_STOPS=0.
    atrStops: process.env.TRADER_ATR_STOPS !== '0',
    // RISK-BASED SIZING (Phase 0, 2026-08-04). Notional sizing made risk-per-trade
    // an accidental byproduct of two independent knobs (position% x stop%), so
    // identical $36k positions carried 0.047%-0.068% risk purely because their stops
    // differed. Size from RISK instead: qty = equity*riskPct / (entry-stop). Default
    // 0.06 is calibrated to today's MEASURED average risk — same exposure, uniform
    // risk. Raising it is a separate, evidence-gated decision. 0 = legacy notional
    // sizing. The maxPositionPct notional cap still binds on top.
    riskPct: n('TRADER_RISK_PCT', 0.06),
    // ROOM TIERING (magnitude study 2026-08-05, OOS-validated on 5 symbols):
    // entries with the first resistance >= roomMinR away (in R) earn 3-10x more
    // per trade (0.48-1.6R vs 0.08-0.16R). A-tier (room) gets full risk;
    // B-tier (cramped) gets roomBMult x risk and keeps the tight R1 harvest.
    // Total risk goes DOWN, expectancy concentrates where the room is.
    // Kill: TRADER_ROOM_TIER=0 (all entries full risk).
    roomTier: process.env.TRADER_ROOM_TIER !== '0',
    roomMinR: n('TRADER_ROOM_MIN_R', 1.5),
    roomBMult: n('TRADER_ROOM_B_MULT', 0.5),
    // A+ TIER (confluence study 2026-08-05): room AND volume expansion. Pooled
    // OOS gate — fit +0.856R/trade, holdout +1.036R/trade vs +0.425R for room
    // alone (2.4x), positive on all 5 symbols in both windows. Held at the SAME
    // risk as A for now: 65 pooled trades is thin evidence for extra weight, so
    // A+ must first prove itself in live logging (TRADER_APLUS_MULT raises it).
    // Zone TOUCHES were tested alongside and FALSIFIED (+0.468R vs +0.425R at
    // the corrected >=2 threshold) — a proxy for what room/volume already catch.
    volAplus: n('TRADER_VOL_APLUS', 1.2),
    aplusMult: n('TRADER_APLUS_MULT', 1.0),
    // TARGET SEPARATION (2026-08-05). Measured live, the FIRST resistance above
    // price is routinely inside the noise — SMH +0.00%, QQQ +0.19%, IWM +0.20%,
    // i.e. 0.0-0.25R. A zone that close is not a target, it IS the entry, and
    // aiming the ladder there caps the trade at a scratch before it is placed no
    // matter how good the setup. So resistances nearer than tgtMinR are treated
    // as noise: skipped for BOTH the exit ladder and the room tier (they were
    // also demoting good entries to B for lack of "room" that never existed).
    // Nothing qualifying = blue sky overhead, which is the A-tier case already.
    // OOS gate, 5 symbols, fit 2000-2014 / holdout 2015-2026:
    //   0 (old): fit +0.326R  holdout +0.383R
    //   0.5    : fit +0.334R  holdout +0.400R   <- better in BOTH windows
    //   1.0    : fit +0.314R  holdout +0.404R   (holdout-only; rejected)
    // 0.5 is chosen because it improves fit AND holdout — the signature of a
    // structural effect rather than a fitted constant. Kill: TRADER_TGT_MIN_R=0.
    tgtMinR: n('TRADER_TGT_MIN_R', 0.5),
    atrStopMinPct: n('TRADER_ATR_STOP_MIN_PCT', 1),
    atrStopMaxPct: n('TRADER_ATR_STOP_MAX_PCT', 6),
    // Per-symbol stop tightening (OOS-validated 2026-08-05): scale the plan stop
    // distance for listed symbols. SPY at 0.65x earned +30% more R per $ risked in
    // BOTH the 2000-14 fit and 2015-26 holdout windows with flat drawdown; QQQ's
    // equivalent was a drawdown trade-off and is deliberately NOT defaulted.
    // Format: "SPY:0.65,QQQ:0.8". Kill: TRADER_STOP_SCALE_SYMBOLS="".
    stopScale: (() => {
      const m = new Map();
      for (const part of String(process.env.TRADER_STOP_SCALE_SYMBOLS ?? 'SPY:0.65').split(',')) {
        const [sym, k] = part.split(':');
        const v = parseFloat(k);
        if (sym && Number.isFinite(v) && v > 0.2 && v <= 1) m.set(sym.trim().toUpperCase(), v);
      }
      return m;
    })(),
    // SUPPORT-ENTRY GATE (#3165 RR-geometry, OOS-validated on SPY+QQQ,
    // operator green-light 2026-08-05): only enter AT the support zone (within
    // supEntryAtr ATRs of its top) and put the protective stop UNDER the zone
    // (bottom - 0.25 ATR) — structural: it has wiggle room below break-even and
    // only triggers when the entry thesis actually failed (price broke the zone).
    // Validated: RR flips 1:0.46 -> >1:1 in every window; QQQ holdout PF 2.06.
    // Kill: TRADER_SUP_ENTRY=0. Scope: TRADER_SUP_ENTRY_SYMBOLS (validated names).
    supEntry: process.env.TRADER_SUP_ENTRY !== '0',
    supEntryAtr: n('TRADER_SUP_ENTRY_ATR', 0.5),
    supEntrySyms: new Set(String(process.env.TRADER_SUP_ENTRY_SYMBOLS || 'SPY,QQQ,GLD,SMH,TLT,SQQQ,SOXS,SPXS')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    zoneExit: process.env.TRADER_ZONE_EXIT !== '0',
    zoneExitSyms: new Set(String(process.env.TRADER_ZONE_EXIT_SYMBOLS || 'SPY,QQQ,SSO,GLD,SMH,TLT,SQQQ,SOXS,SPXS')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    enabled: process.env.TRADER_AUTO_EXECUTE === '1',
    // ── Exit management (trailing stop / take-profit / momentum death) ──────────
    trailPct: n('TRADER_TRAIL_PCT', DEFAULTS.trailPct),
    trailArmPct: n('TRADER_TRAIL_ARM_PCT', DEFAULTS.trailArmPct),
    takeProfitPct: n('TRADER_TAKE_PROFIT_PCT', DEFAULTS.takeProfitPct),
    takeProfitR: n('TRADER_TAKE_PROFIT_R', DEFAULTS.takeProfitR),        // R-multiple take-profit (tight target)
    momentumExit: process.env.TRADER_MOMENTUM_EXIT !== '0',              // on unless disabled
    // Momentum-death needs a MINIMUM PROFIT before it may fire. Measured on 131 real
    // filled exits: 31 of 33 sub-0.15% "wins" were momentum_died at RSI~50 — banking
    // ~nothing, paying two commissions, then re-entering the same name hours later.
    // A fading winner needs a winner to fade; below this floor the protective stop
    // (capped at 1R) is the better risk manager. Expressed in R (x stop distance).
    momentumMinR: n('TRADER_MOMENTUM_MIN_R', 0.5),
    momentumTf: process.env.TRADER_MOMENTUM_TF || '5m',                  // candle size for the momentum-death read (5m = faster peak capture; 15m = smoother)
    entryKnifeFilter: process.env.TRADER_ENTRY_KNIFE_FILTER !== '0',      // veto buying into still-cratering momentum (falling knife); on by default
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

/**
 * Position size in whole shares. Pure + exported for tests.
 *   base notional = min(equity · positionPct%, maxNotional)   ← never exceeds the cap
 *   notional      = base · sizeMult (conviction, 0.5–1.5)
 *   qty           = clamp(floor(notional / price), 1, maxQty), then re-capped so
 *                   qty·price ≤ maxNotional.
 * Returns 0 when unpriced/negative — the caller then skips.
 */
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
const _dirStreak = new Map();   // sym -> { dir, count, at } (signal-persistence filter)
const _peak = new Map();        // sym -> highest price seen since entry (trailing stop)
const _exitAt = new Map();      // sym -> ts of the last exit attempt (don't re-fire while an exit may be resting)
const _exitFailures = new Map();  // sym -> consecutive terminal exit failures
const _unclosable = new Set();    // syms declared unclosable (logged once, no re-attempts)
const MAX_EXIT_FAILURES = 3;      // structural failure (e.g. fractional-only qty) -> stop
const _stopDistPct = new Map(); // sym -> protective-stop distance % at entry (ATR stops make it per-trade)
const _zoneLadder = new Map();  // sym -> {r1, r1top, r2, broke} — zone-ladder exit state, set at entry (#3165)
const _exitStatus = new Map();  // sym -> broker status of the last exit order (an UNCONFIRMED exit — e.g. needs_confirmation — keeps the symbol frozen from re-exit until the position actually leaves the book)
// sym -> last observed broker snapshot { qty, entry, mark, ts } while we held it.
// This is what makes an EXTERNAL close (a resting protective stop filling, a manual
// flatten, another engine) reconstructable: when the position vanishes from the book
// without an autopilot exit of our own, this is the only record of what we held and
// where it was marked. Persisted, so an overnight stop-out is still landed at boot.
const _lastPos = new Map();
function _round2(n) { return Math.round(n * 100) / 100; }

// An exit whose broker result is non-terminal: the order is resting, queued, or awaiting
// manual confirmation and has NOT reduced the position. While one is outstanding for a
// symbol we must not re-fire (or re-log) another exit for it — that manufactured the
// phantom "exit ×12 on one position, $46k of re-counted P&L" churn. A `placed` market
// fill / `error` / `dry_run` is terminal (position leaves the book, or nothing went out),
// so those do NOT freeze the symbol.
function _isExitInFlight(status) {
  return /needs?[_-]?confirm|pending|presubmit|submitted?|working|accepted/i.test(String(status || ''));
}

// ── Persist the trailing state across restarts ──────────────────────────────────
// The high-water mark (_peak) and the per-symbol timers live in memory. Without
// persistence a server restart RESETS every position's peak to its price at boot,
// so the trailing stop silently measures from a lower peak and lets a winner give
// back a full leg before firing (the SOXS "+35% peak → gave back $3k, no exit" bug —
// the box had been restarted repeatedly). Snapshot to disk each scan; reload at boot.
const STATE_FILE = process.env.TRADER_STATE_FILE
  ? path.resolve(process.env.TRADER_STATE_FILE)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'trader-state.json');
function _saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      peak: Object.fromEntries(_peak),
      entryAt: Object.fromEntries(_entryAt),
      exitAt: Object.fromEntries(_exitAt),
      exitStatus: Object.fromEntries(_exitStatus),
      lastOrderAt: Object.fromEntries(_lastOrderAt),
      dirStreak: Object.fromEntries(_dirStreak),
      lastPos: Object.fromEntries(_lastPos),
      // The unclosable freeze must survive a restart. exitStatus was persisted but
      // its two companions were not, so every restart reset the failure count to 0,
      // cleared the freeze, and let a structurally-unclosable position re-attempt its
      // exit 3 more times and re-log exit_frozen (the 0.8-share SOXS dust did this
      // after each restart on 2026-08-03). Released as before the moment the position
      // leaves the book — see the reconcile loop, which deletes both.
      exitFailures: Object.fromEntries(_exitFailures),
      unclosable: [..._unclosable],
      zoneLadder: Object.fromEntries(_zoneLadder),
      stopDistPct: Object.fromEntries(_stopDistPct),
      savedAt: Date.now(),
    }));
  } catch (_e) { /* best-effort — a write failure must never break a scan */ }
}
function _loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(o.peak || {})) _peak.set(k, v);
    for (const [k, v] of Object.entries(o.entryAt || {})) _entryAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitAt || {})) _exitAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitStatus || {})) _exitStatus.set(k, v);
    for (const [k, v] of Object.entries(o.lastOrderAt || {})) _lastOrderAt.set(k, v);
    for (const [k, v] of Object.entries(o.dirStreak || {})) _dirStreak.set(k, v);
    for (const [k, v] of Object.entries(o.lastPos || {})) _lastPos.set(k, v);
    for (const [k, v] of Object.entries(o.exitFailures || {})) _exitFailures.set(k, v);
    for (const s of (o.unclosable || [])) _unclosable.add(s);
    for (const [k, v] of Object.entries(o.zoneLadder || {})) _zoneLadder.set(k, v);
    for (const [k, v] of Object.entries(o.stopDistPct || {})) _stopDistPct.set(k, v);
  } catch (_e) { /* no snapshot yet / unreadable → start fresh */ }
}
_loadState();

/**
 * Falling-knife filter for ENTRIES. The autopilot buys mean-reversion dips (support
 * / oversold RSI), which is right in theory but catches knives when down-momentum is
 * still accelerating. Returns true when the recent trend is CRATERING — MACD histogram
 * negative AND still falling (this bar more negative than the last) — i.e. don't buy
 * yet; wait for the histogram to turn up (decelerating), even if still negative. A
 * histogram that is rising (turning) passes: that's the stabilization we want to buy.
 * Pure + testable; fail-open (insufficient data → NOT a knife, don't block entries).
 */
function isFallingKnife(closes) {
  if (!Array.isArray(closes) || closes.length < 36) return false;   // need 2 MACD reads
  const now = macd(closes);
  const prev = macd(closes.slice(0, -1));
  if (!now || !prev) return false;
  return now.histogram < 0 && now.histogram < prev.histogram;        // negative AND deepening
}

/**
 * Ratcheting trailing-stop distance: the more a winner has run, the TIGHTER we
 * protect it. A position up +35% at its peak shouldn't be allowed to give back a
 * flat 3% (≈a third of a leg) before exiting — lock big gains close. Returns the
 * %-drop-from-peak that triggers the exit, always ≤ the base.
 */
function trailTriggerPct(peakGainPct, base) {
  if (peakGainPct >= 25) return Math.min(base, 1.25);   // huge winner → lock tight
  if (peakGainPct >= 12) return Math.min(base, 1.75);
  if (peakGainPct >= 6) return Math.min(base, 2.25);
  return base;                                            // small gain → base (room to develop)
}

/** Close a held long at market: cancel its resting stop, clear per-symbol state,
 *  log the realized outcome, and record it on `out`. Shared by every exit path. */
async function closeLong(bridge, userId, sym, qty, hp, reason, out, now, { extended = false, refPrice = 0 } = {}) {
  // Regular hours: a market SELL closes instantly. Pre/post market: IBKR rejects market
  // orders outside RTH, so use a marketable LIMIT (≈0.2% below the last print, to cross
  // the wider extended-hours spread) with outsideRTH=true so the exit still fills.
  // acceptWarnings: this is the engine's PRIMARY exit path (take-profit, max-loss,
  // momentum-died, trailing stop, signal exit). It only ever SELLS an existing long,
  // so it strictly reduces risk — an IBKR warning must not leave it unfilled.
  const order = (extended && refPrice > 0)
    ? { ticker: sym, side: 'sell', qty, type: 'limit', limitPrice: Math.round(refPrice * 0.998 * 100) / 100, outsideRth: true, acceptWarnings: true }
    : { ticker: sym, side: 'sell', qty, type: 'market', acceptWarnings: true };
  const r = await bridge.placeIBKROrder(userId, order).catch((e) => ({ status: 'error', reason: e.message }));
  await cancelRestingStops(bridge, userId, sym);
  _entryAt.delete(sym); _peak.delete(sym); _lastOrderAt.set(sym, now); _exitAt.set(sym, now);
  _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
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
async function manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended = false, workingSells = new Set(), exclude = new Set() }) {
  const longs = Object.entries(heldPos).filter(([, p]) => (Number(p.qty) || 0) > 0);
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

    // Oversell guard: an exit sell is already resting for this symbol → don't stack another.
    if (workingSells.has(sym)) continue;

    const lossPct = ((cur - entry) / entry) * 100;   // signed P&L% (negative = losing)

    // 0) HARD MAX-LOSS BACKSTOP — market-exit a long down ≥ maxLossPct, regardless of
    //    momentum, peak, OR min-hold. This is the safety net for a loser whose broker
    //    protective stop never placed/filled (missing stop, gap-down through it): without
    //    it the ONLY loss protection is the entry STP, so an unprotected position runs
    //    unbounded (the -17% case). Still honors the exit-reattempt debounce so a still-
    //    unfilled exit isn't re-fired every scan.
    const _exitAtBackstop = _exitAt.get(sym) || 0;
    if (c.maxLossPct > 0 && lossPct <= -c.maxLossPct && !(_exitAtBackstop && (now - _exitAtBackstop) < c.exitReattemptMs)) {
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

    // ── ZONE-LADDER EXIT (#3165) — OOS-validated for SPY/QQQ-class names ──────────
    // Sell at R1 (first resistance above entry) unless price broke THROUGH the zone —
    // then hold for R2 with the floor ratcheted to R1. While the ladder owns a symbol
    // the generic exits below (take-profit/trail/momentum) are skipped; the broker
    // protective stop and the max-loss backstop above still guard the downside.
    // Live-price approximation of the sim's close-through: mark > zone TOP.
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
      } else if (_lad.r2 > 0 && cur >= _lad.r2) {
        await closeLong(bridge, userId, sym, qty, p, `zone_r2 (runner target ${_lad.r2})`, out, now, { extended, refPrice: cur });
        delete heldQty[sym]; continue;
      } else if (cur <= _lad.r1) {
        await closeLong(bridge, userId, sym, qty, p, `zone_r1_floor (gave back to ${_lad.r1})`, out, now, { extended, refPrice: cur });
        delete heldQty[sym]; continue;
      }
      continue;   // ladder owns this symbol — skip take-profit / trailing / momentum
    }

    const pnlPct = ((cur - entry) / entry) * 100;
    const peak = Math.max(_peak.get(sym) || 0, cur, entry);   // running high-water mark
    _peak.set(sym, peak);
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
        if (m && m.histogram < 0 && last < e9 && (r == null || r < 55)) {
          await closeLong(bridge, userId, sym, qty, p, `momentum_died (MACD hist<0, <EMA9${r != null ? `, RSI ${Math.round(r)}` : ''})`, out, now, { extended, refPrice: cur });
          delete heldQty[sym]; continue;
        }
      }
    }
  }
}

/**
 * PRICE-ONLY exit tick (#3165 "fast exit loop") — runs BETWEEN full scans so the
 * ladder / trailing / max-loss exits react in seconds, not the 60s scan cadence
 * (operator: a near-miss of R1 with dying momentum must exit near the peak, not a
 * minute later). Deliberately fetches NO bars and skips the momentum-death read —
 * everything here needs only the broker's live mark, so the added API cost is one
 * positions + one open-orders call per tick against the LOCAL gateway. All the
 * anti-churn gates (min-hold, exit debounce, oversell guard) apply unchanged.
 */
async function fastExitTick({ bridge, userId, now = Date.now(), extended = false, excludeSymbols = [] } = {}) {
  const c = cfg();
  if (!c.enabled && !c.manageExits) return { reason: 'disarmed' };
  if (!bridge || !userId) return { reason: 'no bridge/userId' };
  c.momentumExit = false;                        // price-only on the fast path
  const out = { executed: [], skipped: [] };
  const positions = await bridge.getIBKRPositions(userId).catch(() => []);
  const heldQty = {}, heldPos = {};
  for (const p of (positions || [])) { const k = String(p.symbol).toUpperCase(); heldQty[k] = Number(p.qty) || 0; heldPos[k] = p; }
  if (!Object.values(heldQty).some((q) => q > 0)) return out;   // flat → nothing to do
  const openOrders = await bridge.getIBKROpenOrders(userId).catch(() => []);
  const workingSells = new Set((openOrders || [])
    .filter((o) => /sell/i.test(o.side || '') && !/stp|stop/i.test(o.orderType || '') && /submit|pending|presubmit|working|needs?[_-]?confirm|accepted/i.test(o.status || ''))
    .map((o) => String(o.symbol || '').toUpperCase()));
  const exclude = new Set([...(excludeSymbols || [])].map((x) => String(x).toUpperCase()));
  // The fast path must honor the unclosable freeze and in-flight exits exactly like
  // the scan loop's reconcile does — without this it re-attempted the frozen SOXS
  // dust every debounce window (observed live 2026-08-04 09:31/09:39 ET).
  for (const sym of _unclosable) workingSells.add(sym);
  for (const [sym, st] of _exitStatus) if (_isExitInFlight(st)) workingSells.add(sym);
  try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended, workingSells, exclude }); } catch (_e) { /* fail-soft */ }
  _saveState();
  return out;
}

/**
 * Execute the ENTER verdicts from a scan against the user's IBKR account.
 * @param {object} scan   result of traderAgent.scanMarket() — { signals: [...] }
 * @param {object} deps   { bridge, userId, now?, caps? }
 * @returns {Promise<{executed:Array, skipped:Array, enabled:boolean, reason?:string}>}
 */
async function runAutoTrade(scan, { bridge, userId, now = Date.now(), caps = {}, extended = false, excludeSymbols = [] } = {}) {
  // Position partitioning: symbols owned by ANOTHER engine (the overnight sleeve book)
  // are completely off-limits — no exits, no re-protect stops, no signal-sells, no
  // entries. Each engine manages only its own positions; the caller (trading.js)
  // supplies the live exclusion set.
  const exclude = new Set([...(excludeSymbols || [])].map((s) => String(s).toUpperCase()));
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
  // Snapshot every long we can still see, so a position that VANISHES before the next
  // scan can be reconstructed into the ledger (see the external-close sweep below).
  for (const [k, p] of Object.entries(heldPos)) {
    if (!(Number(heldQty[k]) > 0)) continue;
    _lastPos.set(k, {
      qty: Number(p.qty) || 0,
      entry: p.avg_entry_price ?? p.avg_fill_price ?? null,
      mark: p.current_price ?? null,
      ts: now,
    });
  }

  // ── External-close sweep: THE LOSS PATH ────────────────────────────────────────
  // Only a symbol the autopilot itself decided to exit was ever reconciled below, so
  // a position closed by anything ELSE left no ledger row at all. The dominant such
  // path is the resting protective STOP filling — i.e. every stop-out, i.e. the
  // losses. Wins exit by an autopilot decision and get logged; losses exit at the
  // broker and did not. That asymmetry is why the scorecard read 100% win rate.
  //
  // So: any symbol we last saw held that is now off the book, with no CONFIRMED exit
  // of our own, is logged as a reconstructed exit. The P&L is computed from the last
  // observed mark, NOT a broker fill (the facade exposes no fills API) — so the row
  // is marked status:'reconstructed' + estimated:true and is deliberately excluded
  // from the scorecard's `confirmed` view. An estimate that is labelled beats a loss
  // that is silently dropped.
  for (const sym of [..._lastPos.keys()]) {
    if (Number(heldQty[sym]) > 0) continue;           // still held → nothing to reconcile
    if (exclude.has(sym)) { _lastPos.delete(sym); continue; }  // another engine owns it
    const snap = _lastPos.get(sym) || {};
    _lastPos.delete(sym);
    // Our own exit already produced a row — don't double-count it. This must catch
    // EVERY status, not just the confirmed ones: an exit logged as
    // needs_confirmation/dry_run is still a row in the ledger, and reconstructing on
    // top of it produced two rows for one SHOP position. The presence of a status at
    // all means we decided (and logged) an exit for this symbol.
    if (_exitStatus.has(sym)) continue;
    const entry = Number(snap.entry);
    const mark = Number(snap.mark);
    const qty = Number(snap.qty);
    if (!(qty > 0) || !Number.isFinite(entry) || !Number.isFinite(mark)) continue;  // can't value it → don't invent a number
    const pnl = _round2((mark - entry) * qty);
    logTrade({
      event: 'exit', symbol: sym, qty, entry, exit: mark,
      pnl, pnl_pct: entry > 0 ? ((mark - entry) / entry) * 100 : null,
      reason: 'closed_externally (position left the book with no autopilot exit — protective stop, manual close, or another engine)',
      status: 'reconstructed', estimated: true,
    });
  }

  // Fetch the account's working orders ONCE. Two uses: (1) re-protect naked longs, and
  // (2) the OVERSELL GUARD — a Set of symbols that already have a resting NON-stop SELL
  // (an exit/cover order that hasn't filled, common in thin extended hours). We never
  // stack another sell on those, so a lagging position snapshot can't make the loop sell
  // `held` again and blow through flat into a short. Survives restarts (broker-side state),
  // unlike the in-memory cooldown. Excludes protective STP sells (every long has one).
  const _openOrders = await bridge.getIBKROpenOrders(userId).catch(() => []);
  const workingSells = new Set((_openOrders || [])
    .filter((o) => /sell/i.test(o.side || '') && !/stp|stop/i.test(o.orderType || '') && /submit|pending|presubmit|working|needs?[_-]?confirm|accepted/i.test(o.status || ''))
    .map((o) => String(o.symbol || '').toUpperCase()));

  // ── Re-exit reconciliation (kills the phantom-exit churn) ──────────────────────
  // Reconcile the frozen-exit set against broker truth, every scan:
  //  • A symbol we're no longer holding has left the book — its exit filled (or it's
  //    flat). Clear ALL of its per-symbol state so a legitimate future re-entry starts
  //    clean and can be exited again.
  //  • A symbol with an exit order still IN FLIGHT (needs_confirmation / resting /
  //    unfilled) is added to workingSells, so BOTH exit paths (momentum/trailing and
  //    signal) skip it. This is what stops one un-filled exit from re-firing every ~8
  //    min and re-logging its unrealized P&L as realized (69 exit rows / 12 real
  //    positions, a fabricated $46k → the actual ~$5k, all still needs_confirmation).
  for (const sym of [..._exitStatus.keys()]) {
    if (!(Number(heldQty[sym]) > 0)) {
      // Position gone → exit resolved. Drop its state.
      _exitStatus.delete(sym); _exitAt.delete(sym); _peak.delete(sym); _entryAt.delete(sym);
      _exitFailures.delete(sym); _unclosable.delete(sym);   // position gone → a future re-entry starts clean
      _zoneLadder.delete(sym); _stopDistPct.delete(sym);
    } else if (_isExitInFlight(_exitStatus.get(sym))) {
      workingSells.add(sym);   // exit still outstanding on a still-held position → don't re-fire
    } else {
      // Position still held but the last exit was terminal-non-fill (error/dry_run).
      // Clearing the freeze lets a genuine later exit retry — but an exit that keeps
      // failing for a STRUCTURAL reason must not retry forever: on 2026-07-30 a
      // 0.8-share SOXS remnant (IBKR cannot trade fractional) re-decided every ~9
      // minutes for 5.5 hours, producing 39 identical error rows and drowning the
      // day's real activity. After MAX_EXIT_FAILURES consecutive terminal failures
      // the symbol is declared unclosable: frozen from re-firing, logged ONCE, and
      // released automatically the moment the position leaves the book (the branch
      // above) or grows back to a tradable size.
      const st = String(_exitStatus.get(sym) || '');
      if (/error/i.test(st)) {
        const n = (_exitFailures.get(sym) || 0) + 1;
        _exitFailures.set(sym, n);
        if (n >= MAX_EXIT_FAILURES) {
          workingSells.add(sym);                 // stop both exit paths re-deciding
          if (!_unclosable.has(sym)) {
            _unclosable.add(sym);
            logTrade({ event: 'exit_frozen', symbol: sym, qty: heldQty[sym],
              reason: `exit failed ${n}x consecutively — treating as unclosable, no further attempts`,
              status: 'frozen' });
          }
          continue;                              // keep the freeze; don't clear state
        }
      }
      _exitStatus.delete(sym);
    }
  }

  // ── Re-protect naked longs: any held long that's lost its protective stop (the
  //    stop was consumed/cancelled while the position stayed open) gets a fresh GTC
  //    SELL STP. Runs every scan so a long is never left unprotected. ──
  try {
    // Status vocabulary: this guard originally matched only IBKR's NATIVE words
    // (PreSubmitted/Submitted/Pending), but the normalized order shape the bridge and
    // Alpaca return says 'open' / 'accepted' / 'new'. So hasStop() never matched, the
    // engine believed every long was naked, and it added ANOTHER GTC stop every scan:
    // measured 2026-07-27 — 488 resting stop-sells, ~33 per symbol, 95,561 shares
    // against 3,772 held (a 25x oversell that would have gone short on any gap down).
    // Also accept an orderType/type field on either key, since the normalized shape
    // uses `type`.
    const hasStop = (sym) => (_openOrders || []).some((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
      /submit|pending|presubmit|open|accepted|new|working|held/i.test(o.status || ''));
    // ACCUMULATION CAP. A stop that never transmits (IBKR parks it 'Inactive' when an
    // order warning goes unconfirmed) is not protection, so hasStop() correctly ignores
    // it — but then this pass retries every scan forever: 2026-07-27 left 972 inert
    // stop attempts, ~33 per symbol. Retry a bounded number of times, then stop adding
    // and let the ledger show the failure instead of burying it under duplicates.
    const REPROTECT_MAX_ATTEMPTS = 3;
    const attemptsFor = (sym) => (_openOrders || []).filter((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '')).length;
    for (const [sym, p] of Object.entries(heldPos)) {
      if (exclude.has(sym)) continue;             // overnight-owned: its own engine protects/exits it
      const qty = Number(p.qty) || 0;
      if (qty > 0 && !hasStop(sym) && attemptsFor(sym) >= REPROTECT_MAX_ATTEMPTS) {
        (out.skipped = out.skipped || []).push({ symbol: sym, why: `re-protect capped: ${attemptsFor(sym)} prior stop order(s) exist but none is working (check for unconfirmed/Inactive orders)` });
        continue;
      }
      if (qty > 0 && !hasStop(sym)) {
        const entry = Number(p.avg_entry_price || p.avg_fill_price || p.current_price) || 0;
        const curPx = Number(p.current_price) || 0;
        let stop = stopPriceFor(entry, _stopDistPct.get(sym) || c.stopPct);
        // A sell-STOP must sit BELOW the market or the broker rejects it. For a position
        // already underwater, the entry-based stop (entry×0.98) is ABOVE the current
        // price — so re-protect would silently fail and the loser stays naked. Clamp the
        // stop to just below the current price so an underwater long still gets a working
        // protective stop that caps further downside. (The max-loss backstop in
        // manageHeldExits is the harder floor if price is already past maxLossPct.)
        if (stop && curPx > 0 && stop >= curPx) {
          stop = Math.round(curPx * (1 - Math.max(0.1, c.stopPct) / 100) * 100) / 100;
        }
        if (stop) {
          const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc', equity: account.equity, acceptWarnings: true }).catch((e) => ({ status: 'error', reason: e.message }));
          (out.reprotected = out.reprotected || []).push({ symbol: sym, qty, stop, status: sr && sr.status });
        }
      }
    }
  } catch (_e) { /* fail-soft — the daily-loss breaker still guards the account */ }

  // ── Manage held longs on their own merits (trailing stop / take-profit / momentum
  //    death) — runs every scan, independent of new ENTER signals. This is what stops
  //    a winner from peaking and giving it all back. ──
  try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended, workingSells, exclude }); } catch (_e) { /* fail-soft */ }
  // manageHeldExits updates every held position's peak; persist NOW so the common
  // early-return paths below (exits-only mode, no ENTER signals) don't drop it.
  _saveState();

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

  // Falling-knife filter: one batched fetch of the momentum-timeframe bars for the
  // ENTER candidates, so the BULLISH branch can veto buying into cratering momentum
  // without a per-symbol fetch. Fail-soft — no bars → filter simply doesn't block.
  let entryBars = {};
  if (c.entryKnifeFilter && enters.length) {
    try {
      const syms = [...new Set(enters.map((s) => String(s.symbol).toUpperCase()))];
      const bm = await yahoo.getBarsMulti(syms, c.momentumTf);
      entryBars = (bm && bm.bars) || {};
    } catch (_e) { entryBars = {}; }
  }

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
    if (exclude.has(sym)) { out.skipped.push({ ...record, why: 'overnight-book position — managed by its own engine' }); continue; }
    if (!bullish) {
      if (held > 0) {
        // Anti-churn gates on the signal-exit (the broker stop still protects the
        // downside independently): (1) don't dump a long we just opened, (2) only
        // exit on a STRONG bearish read, (3) require it to persist across scans.
        const entryAt = _entryAt.get(sym) || 0;
        if (entryAt && now - entryAt < c.minHoldMs) { out.skipped.push({ ...record, why: `min-hold (${Math.round((now - entryAt) / 60000)}<${Math.round(c.minHoldMs / 60000)}min) — stop still protects` }); continue; }
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
        const r = await bridge.placeIBKROrder(userId, exOrder).catch((e) => ({ status: 'error', reason: e.message }));
        await cancelRestingStops(bridge, userId, sym);
        _entryAt.delete(sym); _exitAt.set(sym, now);
        _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
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
    if (!persistent) { out.skipped.push({ ...record, why: `awaiting ${c.persistScans} consecutive bullish scans (persistence)` }); continue; }
    if (opened >= c.maxNewPerScan) { out.skipped.push({ ...record, why: 'max new/scan reached' }); continue; }
    // Falling-knife veto: don't buy the dip while down-momentum is still accelerating.
    // Wait for the momentum to turn (histogram rising, even if negative). (#c)
    if (c.entryKnifeFilter) {
      const closes = ((entryBars[sym] && entryBars[sym].bars) || []).map((b) => b.close).filter((x) => x > 0);
      if (isFallingKnife(closes)) { out.skipped.push({ ...record, why: 'falling_knife — momentum still cratering (MACD hist<0 & deepening); waiting for the turn' }); continue; }
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
    }

    const sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    // Stop distance is now an INPUT to sizing (risk-based), so it must be resolved
    // before the order is sized. Structural (support-entry) stop wins when armed.
    const _stopDist = _supStopPx != null
      ? Math.min(6, Math.max(0.2, ((price - _supStopPx) / price) * 100))
      : stopDistPctFor(price, s.plan, c, sym);
    // Room tier: distance to the first resistance, in R (this trade's stop units).
    // No resistance above = open room = A-tier.
    // Resistances above price that are FAR ENOUGH to be real targets (c.tgtMinR).
    // Anything nearer is noise sitting on top of the entry — see tgtMinR above.
    const _resAbove = (Array.isArray(s.zones) ? s.zones : [])
      .filter((z) => z && /RESIST/i.test(z.type || '') && Number(z.level) > price * 1.001)
      .filter((z) => c.tgtMinR <= 0
        || ((Number(z.level) - price) / price) * 100 / Math.max(_stopDist, 1e-9) >= c.tgtMinR)
      .sort((x, y) => x.level - y.level);
    let _roomR = null, _tier = 'A';
    if (c.roomTier) {
      const _res1 = _resAbove[0];
      if (_res1) {
        _roomR = ((_res1.level - price) / price) * 100 / Math.max(_stopDist, 1e-9);
        if (_roomR < c.roomMinR) _tier = 'B';
      }
      // A+ upgrade: room AND volume expansion (the confluence the OOS gate passed).
      if (_tier === 'A' && Number(s.volume_ratio) >= c.volAplus) _tier = 'A+';
    }
    // B-tier scales BOTH the risk target and the notional cap — support entries
    // have such tight structural stops that the 5% cap binds before the risk
    // target, and without scaling the cap the tiers would size identically.
    const _tierMult = _tier === 'B' ? c.roomBMult : (_tier === 'A+' ? c.aplusMult : 1);
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxPositionPct: c.maxPositionPct * _tierMult, riskPct: c.riskPct * _tierMult, stopDistPct: _stopDist });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }

    const enOrder = (extended && price > 0)
      ? { ticker: sym, side: 'buy', qty, type: 'limit', limitPrice: Math.round(price * 1.002 * 100) / 100, outsideRth: true, equity: account.equity }
      : { ticker: sym, side: 'buy', qty, type: 'market', equity: account.equity };
    const r = await bridge.placeIBKROrder(userId, enOrder).catch((e) => ({ status: 'error', reason: e.message }));
    const exec = { ...record, action: 'open_long', qty, notional: Math.round(qty * price), result: r };
    // Attach a broker-side protective stop on the placed long — the hard stop the
    // position keeps even if the scan loop dies. Cancelled on the signal exit above.
    if (r && r.status === 'placed') {
      // Structural stop for support entries (validated WITHOUT the per-symbol
      // stop-scale — the zone bottom IS the thesis line; scaling it would put the
      // stop inside the zone's noise).
      const stopDist = _stopDist;   // resolved before sizing (risk-based)
      _stopDistPct.set(sym, stopDist);
      const stop = stopPriceFor(price, stopDist);
      if (stop) {
        const sr = await bridge.placeIBKROrder(userId, { ticker: sym, side: 'sell', qty, type: 'stop', stopPrice: stop, timeInForce: 'gtc', acceptWarnings: true }).catch((e) => ({ status: 'error', reason: e.message }));
        exec.stop = { price: stop, status: sr && sr.status, order_id: sr && sr.order_id };
      }
    }
    if (r && r.status === 'placed' && c.zoneExit && c.zoneExitSyms.has(sym)) {
      // Arm the zone ladder (#3165): the two nearest resistance zones above entry
      // that clear c.tgtMinR. No qualifying zone above -> blue sky, no ladder; the
      // generic exits (trail/target) manage it instead of banking a scratch at a
      // level that was never more than noise.
      const res = _resAbove;
      if (res[0]) _zoneLadder.set(sym, { r1: res[0].level, r1top: res[0].top || res[0].level, r2: res[1] ? res[1].level : 0, broke: false });
    }
    if (r && r.status === 'placed') {
      const pl = s.plan || {};
      logTrade({ event: 'entry', symbol: sym, side: 'long', qty, entry: price, notional: Math.round(qty * price), p_win: s.convergence && s.convergence.p_win, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null, target1: pl.target1 ?? null, target2: pl.target2 ?? null, hold_days: pl.hold_days ?? null, tier: _tier, room_r: _roomR != null ? +_roomR.toFixed(2) : null, vol_ratio: Number(s.volume_ratio) || null });
    }
    // ── An entry that did NOT place must be narrated and must back off ────────────
    // Entries deliberately don't pass acceptWarnings (P0-8: never blindly click
    // through IBKR's margin/size/price warnings on a BUY). A warned entry therefore
    // returns needs_confirmation with the order ALREADY POSTed and parked at IBKR —
    // which is what shows there as `inactive`. Two consequences, both fixed here:
    //
    //   1. The reason was DISCARDED. The bridge computes r.reason from IBKR's own
    //      warning text, but nothing logged it unless the order placed. So 408 parked
    //      orders on 2026-07-31 told us nothing about WHICH warning fired. Every
    //      non-placed entry now lands an `entry_blocked` row carrying that text.
    //   2. The re-entry cooldown armed only on 'placed'/'dry_run', so a warned symbol
    //      re-fired every 60s scan indefinitely — 7 symbols became 408 orders in one
    //      session (QQQ alone 151). Arming it on any terminal outcome brakes that to
    //      one attempt per cooldown for as long as the entry stays blocked.
    //
    // Observability + a brake ONLY. No warning is confirmed, so this does not make any
    // entry more likely to reach the market than it already was.
    if (r && r.status !== 'placed' && r.status !== 'dry_run') {
      const why = r.reason || r.error || r.note || r.status || 'unknown';
      logTrade({
        event: 'entry_blocked', symbol: sym, side: 'long', qty,
        entry: price, notional: Math.round(qty * price),
        status: r.status || 'unknown', reason: String(why).slice(0, 400),
      });
      console.warn(`[Trading] entry BLOCKED ${sym} x${qty} — ${r.status}: ${String(why).slice(0, 180)}`);
    }
    out.executed.push(exec);
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') { _entryAt.set(sym, now); opened += 1; } }
    else if (r) { _lastOrderAt.set(sym, now); }   // blocked → back off for the cooldown rather than re-fire every scan
  }
  _logSkips(out.skipped);
  // Persist the updated peaks/timers so the trailing stop survives a restart.
  _saveState();
  return out;
}

// ── SKIP-REASON OBSERVABILITY (2026-08-05) ───────────────────────────────────
// out.skipped lived and died in memory, so a session where the trader declined
// every opportunity left NO record of why. On 2026-08-05 GLD ran +1.85% and
// SQQQ +4.75% untouched, and the post-mortem could only INFER the cause by
// replaying bars offline — the live reasons were gone.
//
// Logging every skip would write ~400 rows/day of pure repetition, so this logs
// a symbol's reason only when it CHANGES. Digits are normalised out of the
// comparison key first, otherwise counters embedded in the text ("min-hold
// (3<5min)") would look like a new reason on every scan and defeat the dedupe.
// Result: one row per symbol per distinct blocker — the day's story, not its
// transcript. Kill: TRADER_LOG_SKIPS=0.
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
    logTrade({
      event: 'skip', symbol: s.symbol, direction: s.direction ?? null,
      p_win: s.p_win ?? null, reason: why.slice(0, 300),
    });
  }
  // A symbol that stops being skipped must forget its reason, so that if the
  // SAME blocker returns later it is recorded again as a new occurrence.
  for (const sym of [..._lastSkipWhy.keys()]) if (!seen.has(sym)) _lastSkipWhy.delete(sym);
}

/** Test/ops helper: clear the per-symbol state (memory + on-disk snapshot). */
function _resetCooldowns() { _lastSkipWhy.clear(); _lastOrderAt.clear(); _entryAt.clear(); _dirStreak.clear(); _peak.clear(); _exitAt.clear(); _exitStatus.clear(); _lastPos.clear(); _exitFailures.clear(); _unclosable.clear(); _zoneLadder.clear(); _stopDistPct.clear(); _saveState(); }

module.exports = { runAutoTrade, fastExitTick, sizePosition, cfg, trailTriggerPct, isFallingKnife, _resetCooldowns, _logSkips, _saveState, _loadState, STATE_FILE };
