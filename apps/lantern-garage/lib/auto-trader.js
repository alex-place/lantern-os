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
// PER-USER ATTRIBUTION. The autopilot drives every connected account, but the
// ledger was one undifferentiated book: a row said WHAT was traded and never FOR
// WHOM, so one user's journal could only ever be answered with everyone's. Each
// row now carries the account it was traded for.
//
// A module scalar (rather than threading userId through ~15 logTrade call sites)
// is safe because the account loop is SEQUENTIAL — routes/trading.js awaits each
// account's pass before starting the next — and every entry point sets it inside
// a try/finally that restores the previous value.
let _actingUser = null;
function logTrade(rec) {
  try {
    fs.mkdirSync(path.dirname(TRADES_LOG), { recursive: true });
    fs.appendFileSync(TRADES_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      // `user` first so an explicit rec.user (e.g. a backfill) still wins.
      ...(_actingUser ? { user: _actingUser } : {}),
      ...rec,
    }) + '\n');
  } catch (_e) { /* logging must never break trading */ }
  // Converge stage (#3286). Every entry is a falsifiable claim and every exit is
  // the market's answer, so the pair belongs in the convergence store — which sat
  // at 0 bytes while the trader took 118 entries over 24 sessions. Hooked HERE, at
  // the single ledger write point, so no path can bypass it: the reconstructed
  // `closed_externally` exits are graded too, and a future exit site inherits it.
  // Fire-and-forget by design — a record must never delay or break a trade.
  try {
    if (rec && (rec.event === 'entry' || rec.event === 'exit')) {
      const tc = require('./trader-convergence');
      const p = rec.event === 'entry' ? tc.recordEntryHypothesis(rec) : tc.recordExitOutcome(rec);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_e) { /* convergence emission is best-effort, always */ }
  // A CONFIRMED exit explains the position leaving the book, so the flat reading
  // is no longer suspect (#3282). Hooked here, at the single ledger write point,
  // so no exit path can miss it.
  //
  // ONLY A REAL FILL COUNTS. A `reconstructed` row is itself INFERRED from the
  // same absence the veto exists to distrust — letting it clear the veto would
  // be circular, and would defeat the fix precisely in the dropout case: the
  // sweep would invent an exit, that invention would license a fresh entry, and
  // the position would double exactly as it did on 2026-08-13. An estimate
  // cannot corroborate itself.
  try {
    if (rec && rec.event === 'exit' && rec.symbol
      && (rec.status === 'filled' || rec.source === 'fill')) {
      _lastConfirmedHold.delete(String(rec.symbol).toUpperCase());
    }
  } catch (_e) { /* never break logging */ }
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
    // Portfolio-level cash reserve (2026-08-06): gross exposure across ALL
    // positions is capped at this % of equity; the rest stays in cash. 0 or
    // >=100 disables. Default 80 = always keep 20% cash.
    maxGrossPct: n('TRADER_MAX_GROSS_PCT', 80),
    maxNewPerScan: n('TRADER_MAX_NEW_PER_SCAN', DEFAULTS.maxNewPerScan),
    cooldownMs: n('TRADER_COOLDOWN_MS', DEFAULTS.cooldownMs),
    stopPct: n('TRADER_STOP_PCT', DEFAULTS.stopPct),                     // protective stop distance
    maxLossPct: n('TRADER_MAX_LOSS_PCT', DEFAULTS.maxLossPct),           // hard max-loss backstop exit
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
    // MINIMUM STOP DISTANCE, % of price (2026-08-06). Gated 2% vs 3% on 5
    // symbols, fit 2000-2014 + holdout 2015-2026, 3bp costs, ranked by PERCENT
    // CAPTURED PER TRADE (avg_R is normalised by stop width and inverts the
    // ranking — the best-avg_R config captured the fewest dollars):
    //   floor 2%: fit +0.072%/trade  holdout +0.275%/trade
    //   floor 3%: fit +0.159%/trade  holdout +0.312%/trade   <- wins BOTH
    // 3% also lifts win rate (45% -> 59%) by not tagging out on noise. At the
    // unchanged 7% notional cap that is ~$210/trade vs ~$85 today.
    // NOTE: the gate covered UNLEVERAGED symbols (SPY QQQ GLD TLT SMH). On a 3x
    // ETF a 3% stop is only a ~1% move in the underlying, so it is tighter in
    // real terms there, not wider — see TRADER_STOP_MIN_PCT_BY_SYMBOL.
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
    // EOD DE-CARRY (#3298 finding 3). Stops cannot protect through a gap, and a
    // 3x wrapper carries 3x the overnight exposure at equal notional — 64% of
    // the 2026-08-13→14 give-back happened before any stop could act. The
    // operator ran this policy by hand twice (pre-open trim, weekend flat);
    // this automates it: leveraged holdings are flattened into the close.
    eodDecarry: process.env.TRADER_EOD_DECARRY !== '0',
    // SESSION-END FLAT (2026-08-24, operator: "never hold over the weekend").
    // TRADER_EOD_FLAT: 'weekend' = flat EVERY held long into the close of the
    // last session before a weekend; 'all' = flat every session close; unset/
    // 'off' = hold (the validated default). TRADER_EOD_FLAT_MIN is the ET minute
    // it starts (default: the de-carry clock, 15:50). Measured on the four
    // surfaces (experiments/overnight_policy_lab.js) under the armed stack:
    //   weekend  h1 36.1% div4.14 | d-fit 8,723% div800 | h2 53.1% div11.47 | 26y 15,405% div857  (+4% vs armed, better on BOTH holdouts)
    //   all      h1 25.1% div2.80 | d-fit 8,463% div760 | h2 50.2% div10.87 | 26y 14,622% div891  (costs 3 of 4 surfaces)
    // The live book agrees: weekend holds are 8 trades for -$228, while weekday
    // overnight holds are profit factor 2.58 and 71% of all profit — so the
    // weekend leg is the part worth cutting, not the overnight leg.
    eodFlat: String(process.env.TRADER_EOD_FLAT || 'off').trim().toLowerCase(),
    eodFlatMin: n('TRADER_EOD_FLAT_MIN', n('TRADER_DECARRY_MIN', 950)),
    decarryMin: n('TRADER_DECARRY_MIN', 950),                       // 15:50 ET
    decarrySyms: new Set(String(process.env.TRADER_DECARRY_SYMBOLS
      || 'TQQQ,SQQQ,SOXL,SOXS,SPXL,SPXS,TNA,TZA')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    // Positions below this % of equity are DUST and never consume a
    // concurrency slot (nor do unclosable ones). 0 counts every row.
    dustPct: n('TRADER_DUST_PCT', 0.1),
    // Minimum reward:risk, measured against the FLOORED stop. 0 disables.
    minEntryRr: n('TRADER_MIN_ENTRY_RR', 1),
    // Max simultaneous positions sharing ONE correlated risk bucket
    // (equity_long / equity_short / metals / per-symbol). 0 disables.
    maxPerBucket: n('TRADER_MAX_PER_BUCKET', 0),
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
    // LADDER FOR EVERY ENTRY (#3285, 2026-08-14). The 9-symbol allowlist was a
    // fossil from before the 27-symbol watchlist: SOXL/XLK/IWM/DIA/TQQQ and the
    // sectors could never arm a ladder at all, so their exits fell through to
    // first-weak-scan scratches. Live cost, 2026-08-14: a SOXL re-entry 0.08%
    // off the session low — bounce +3.83% — was scratched at +$72 of a $1,036
    // move. Default is now ALL entered symbols; set TRADER_ZONE_EXIT_SYMBOLS to
    // a list only to restrict deliberately.
    zoneExitSyms: (String(process.env.TRADER_ZONE_EXIT_SYMBOLS || 'all').trim().toLowerCase() === 'all')
      ? 'all'
      : new Set(String(process.env.TRADER_ZONE_EXIT_SYMBOLS)
        .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
    // EXPERIMENTAL vol-scaled rung tightening — FALSIFIED at defaults by the
    // two-window sweep (37,518 trades: every ATR multiple and the MFE-adaptive
    // variant lose BOTH windows on total income vs plan targets; monotonic —
    // nearer full-exit targets amputate the winners' tail). OFF (0) by default;
    // kept only for a future re-test with a partial-bank runner structure.
    ladderVolMult: n('TRADER_LADDER_VOL_MULT', 0),
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
// STOP-ORDER STATUS VOCABULARY (#3352). Three sites ask "what state is this stop
// in?" and each carried its own regex. The dangerous one was the accumulation
// cap, which recognised FAILURE by an ALLOWLIST (inactive/reject/needs_confirm).
// A status in NEITHER vocabulary — an empty/absent status field, or any term the
// broker uses that we have not seen — is invisible to both checks: not working,
// so the re-protect pass places another; not a known failure, so the cap never
// trips. Unbounded. Live 2026-08-18 04:00: QQQ carried 1,200 shares of resting
// stops against 80 held and SPY 1,125 against 75 — exactly 15 duplicates each,
// while the cap sat at 3. Had one triggered, IBKR either sells shares we do not
// own (a short, on a longs-only strategy) or rejects and leaves the position
// naked.
//
// So classify by COMPLEMENT, never by allowlist: a stop is WORKING, or it is
// TERMINAL (cancelled/filled — lifecycle, not failure, per the 2026-08-10
// hardening that stopped counting our own cancel-first exits), or it is a FAILED
// placement. Unknown statuses land in the last bucket, which is the safe side:
// the cap stops adding and the ledger says why.
const STOP_WORKING = /submit|pending|presubmit|open|accepted|new|working|held/i;
const STOP_TERMINAL = /cancel|fill|done|expire/i;
/** A stop order that exists but never protected anything (incl. unknown status). */
const isFailedStop = (status) => {
  const v = String(status || '');
  return !STOP_WORKING.test(v) && !STOP_TERMINAL.test(v);
};

async function cancelRestingStops(bridge, userId, sym) {
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
    // SETTLE BEFORE SELLING (#3407). A cancel is not instantaneous: Alpaca holds
    // the order in pending_cancel while the shares stay reserved, so a market
    // sell issued immediately after is rejected for insufficient quantity. That
    // is exactly how the race book's eod_decarry errored TWICE on 2026-08-21
    // and carried a 3x position into a weekend (and how the operator's manual
    // champion flatten bounced on 08-20). Wait — bounded — until the canceled
    // ids leave the working book; IBKR usually settles on the first check.
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
// Fills older than this process are not reconciled: after a restart the entry
// price is not in memory, so back-filling only produces pnl:null noise (observed
// 2026-08-07). Their ids are still remembered, so they can never resurface.
const _PROCESS_START = Date.now();
const _exitIntent = new Map();    // sym -> reason for the exit we just ordered (labels the fill row)
const fillLedger = require('./fill-ledger');
const MAX_EXIT_FAILURES = 3;      // structural failure (e.g. fractional-only qty) -> stop
// How long an unclosable freeze holds before ONE clean retry cycle is allowed.
// Permanent freezing turned a ~25-min transient order-path outage into positions
// stranded from every engine exit until they left the book (audit 2026-08-08);
// hourly retry bounds the churn for the genuinely-structural case (the 0.8-share
// SOXS class) to ~3 error rows/hour instead of the historical every-9-minutes.
const _unclosableRetryMs = () => Math.max(5, parseFloat(process.env.TRADER_UNCLOSABLE_RETRY_MIN) || 60) * 60000;
const _stopDistPct = new Map(); // sym -> protective-stop distance % at entry (ATR stops make it per-trade)
// POST-STOP RE-ENTRY COOLDOWN (2026-08-08 tail gate). After a protective stop
// fills, the symbol is barred from re-entry for the rest of that session plus
// TRADER_STOP_COOLDOWN_DAYS trading days. Lab (both windows, 19 symbols, live
// config): halves the holdout's worst day (-2.86% -> -1.40%) at -0.004%/trade.
// sym -> ET date string (inclusive) through which entries are refused.
const _stopCooldownThrough = new Map();
// DAILY CIRCUIT BREAKER (2026-08-08 tail gate #2). The 2008-class worst days
// were CROSS-symbol churn: stops freed slots, fresh symbols refilled them into
// the same crashing market. Once TRADER_STOP_BREAKER stop fills land in one ET
// session, entries are refused for the rest of it. Replay (both windows, on top
// of the cooldown): worst day -3.97% -> -1.40% (= the pure 4x0.35% structural
// bound) AND %/trade improved in both windows — crash-day refills were -EV.
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
// STOP ATTRIBUTION THRESHOLD (#3281). A position that leaves the book outside our
// own exit path is reported only as an absence — "protective stop, manual close,
// or another engine" — so a stop-out arriving that way armed neither counter
// above. Treat the close as a stop when it gave up at least this fraction of its
// stop distance. 0.9 covers the real case (SQQQ left at -2.88% against a 3% stop,
// 96%) with room for the mark lagging the trigger tick, while still ignoring an
// ordinary small-loss exit.
//
// Read per call, like cfg(), so the lab can sweep it without a reload. <= 0
// disables attribution entirely and restores the pre-#3281 behaviour — note the
// explicit > 0 guard at the use site: a bare `loss <= -(pct * 0)` is `loss <= 0`,
// which attributes EVERY loss. That inversion is the whole reason the check is
// spelled out rather than folded into the arithmetic.
// LAST CONFIRMED HOLDING (#3282). sym -> ms when the broker last reported a
// non-zero position in it.
//
// The `already long` guard trusts a single position snapshot. On 2026-08-13 the
// feed dropped SOXS for two scans — 11:13 held, 11:14 and 11:15 ABSENT, 11:16
// held again — with no exit of any kind on record. During the gap the engine
// evaluated SOXS as a fresh candidate and opened a full-size tier-A+ entry on
// top of the 1,490 shares it already had, taking the position to 3,057.8: twice
// the intended maximum, behind a stop sized for part of it. It happened to earn
// +$4,218; a double-size loss was equally available.
//
// A position leaving the book is normally EXPLAINED — our exit fills, or the
// external-close sweep reconstructs one. An absence with no exit row at all is
// the dropout signature, so this map is cleared by any exit row for the symbol
// (see logTrade) and otherwise stands as the reason to distrust a flat reading.
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
// STRESS MULTIPLIER (#3428 gates/caps lab; Nagel 2012 "Evaporating Liquidity":
// short-term reversal returns rise strongly with VIX). Size UP when the tape is
// stressed — the other direction from the rejected regime-half sizing. Lab:
// 12% -> 18% when the prior VIX close >= 20 lifted the 26y holdout from 445%
// to 841% at an UNCHANGED drawdown (-13.9%); the fit-chosen rule (VIX >= 20 OR
// SPY session IBS <= 0.3, x2) took holdout return/DD from 32 to 69 and tied
// the recent hourly half. Absolute drawdown grows with the multiplier — the
// operator picks the size.
//   TRADER_STRESS_MULT     multiplier (e.g. 1.5); unset or <= 1 = OFF
//   TRADER_STRESS_VIX      prior-session VIX close at/above which it applies (default 20)
//   TRADER_STRESS_SPY_IBS  SPY session IBS at/below which it applies (default 0.3)
// Either condition arms it (OR). It scales BOTH the risk target and the
// notional cap, like the room tier — otherwise the 12% cap binds and nothing
// changes. Conviction sizing (size_mult) is untouched. Entries only.
function _stressCfg() {
  const mult = Number(process.env.TRADER_STRESS_MULT);
  return { mult: mult > 1 ? Math.min(2.5, mult) : 1,
    vix: process.env.TRADER_STRESS_VIX === undefined ? 20 : Number(process.env.TRADER_STRESS_VIX),
    spyIbsLvl: process.env.TRADER_STRESS_SPY_IBS === undefined ? 0.3 : Number(process.env.TRADER_STRESS_SPY_IBS) };
}
// SYMBOL TILT (#3434 stack-sweep lab). Per-symbol size weights chosen on the
// FIT surfaces only (weight = clamp(fit edge / median edge, 0.5, 1.5)) and
// confirmed on both holdouts: recent half 31.5% vs 19.4% (return/DD 5.7 vs
// 4.3), 26y holdout 1,494% vs 841% (89 vs 60). The first sizing change that
// improved the ratio instead of scaling it. Validated weights:
//   SOXL:1.5,SMH:1.5,QQQ:1.5,XLK:1.0,IWM:1.02,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5
// TRADER_SYMBOL_SIZE_MULT="SYM:w,SYM:w,..." (unset = flat). Scales the risk
// target and the notional cap together, like the room tier and the stress
// multiplier; composes with both. Clamped to [0.25, 2].
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
// ENTRY-HOUR BLOCK (#3427 overnight-leg lab). The washout edge is concentrated
// late in the session — last-hour entries earn ~+0.8%/trade, the 13:30-14:30
// bar's entries are NEGATIVE on both halves of the 2y hourly window; skipping
// that bar lifted the 2y analog from 22.3% to 30.5% on fewer trades (the full
// fit-chosen set {09:30-10:30, 12:30-13:30, 13:30-14:30}: 37.4%, confirmed on
// the second half). Mechanism per the literature (Lou/Polk/Skouras; NY Fed
// "Overnight Drift"): the return accrues overnight and the intraday leg
// reverts; an early-afternoon washout sits through the worst of it.
// TRADER_ENTRY_BLOCK_ET="13:30-14:30[,HH:MM-HH:MM...]" — ET windows, half-open;
// unset = off. Entries only; exits and stops are untouched.
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
// ENTRY CADENCE (#3435). The engine reads the session IBS every scan (~60s) and
// buys at the first two scans where it crosses the threshold; every lab that
// validated this stack read it at BAR CLOSES. On 20 sessions of 1-minute data
// with identical rules (experiments/cadence_validate_1m.js) the engine analog
// is payoff 0.57 / -0.2%; the same entries confirmed on an hourly close, exit
// unchanged, are payoff 0.68-1.64 with 8 of 9 boundary phases beating the
// engine (mean ~+3.7%) and a lower drawdown in every case. The 2y hourly labs,
// which sample at :30 closes, make +23% / +25% per half. Mechanism: IBS is a
// CLOSE phenomenon - a washout still at the session low when an hour closes is
// the pattern the research measured; a two-minute poke at a level is noise.
// TRADER_ENTRY_CADENCE_MIN=60 (unset/0 = off). TRADER_ENTRY_CADENCE_PHASE=0 is
// the boundary's minute offset (0 = :00, 30 = :30 = the labs' phase).
// TRADER_ENTRY_CADENCE_WINDOW=3: entries are allowed for this many minutes after
// a boundary, so a busy scan loop still lands one decision scan per bar.
// Entries only - exits, floors, trails and the broker stop are untouched.
// ONE DECISION PER BAR (follow-up, 2026-08-23). The scan loop is setTimeout(60s)
// AFTER each scan completes, so scan spacing is 60s + scan time: live 8/18-8/21
// median 58s, p90 139s, p99 564s. A fixed 3-minute window therefore misses an
// hourly boundary outright roughly once in 15-20, and that hour's decision is
// skipped for every symbol. Semantics now: the FIRST scan after a boundary
// decides even if it is late (up to half a bar - beyond that it is a different
// bar), and a second scan inside the same bar never decides twice. `decided` is
// the boundary (ET minute) of the last decision scan; the caller records it.
let _cadenceDecided = { day: null, boundary: null };   // the boundary whose decision was SPENT (an entry placed), per process
let _pendingCadence = { day: null, boundary: null };   // the boundary this scan is deciding for; promoted only when an entry places
// THE BAR'S DECISION IS SPENT WHEN THE WINDOW CLOSES, NOT ON THE FIRST FILL
// (2026-08-25). Spending it on the first placement let whichever symbol happened
// to resolve first take the whole hour: on 8/25 the 11:00 bar went to DIA (tilt
// 0.71, the lowest-weighted name on the list) at 11:00:35 and then blocked QQQ
// and SMH (tilt 1.5) at 11:01 with three slots free — bypassing the very ranking
// #3438 measured at 2,866% vs 1,494%. Inside the window every name that becomes
// eligible now competes on rank; outside it (the late-first-scan allowance) the
// first placement still spends the bar, so the cadence itself cannot widen.
function _markCadenceDecided() {
  if (!_pendingCadence.day) return;
  if (_pendingCadence.since != null && _pendingCadence.win != null
      && _pendingCadence.since < _pendingCadence.win) return;   // still inside the decision window — let the rest compete
  _cadenceDecided = { day: _pendingCadence.day, boundary: _pendingCadence.boundary };
}

// THE SESSION IBS OF A SIGNAL (2026-08-25). scan.js builds the signal with the
// reading on `decision_context.ibs` (#3375/#3381 moved the evidence there); there
// is NO top-level `s.ibs`. Every consumer that read `s.ibs` was therefore reading
// undefined, silently and permanently:
//   - the IBS bounce exit — the validated exit, 1,494% vs 462% on the 26y holdout
//     (#3437) — never fired once. Every held symbol logged "no session IBS reading
//     yet" instead: live 8/25, 28 such rows across exactly the three held names,
//     while sessionIbs() computed fine from the same cache (DIA 0.492, SPXL 0.468,
//     SOXL 0.249).
//   - _orderEntries' depth tie-break always scored Infinity, so slot priority
//     silently degraded to weight-only with ties broken by scan order (#3438).
// Read both, preferring an explicit top-level value if one ever appears.
function _signalIbs(s) {
  if (!s) return null;                                   // Number(null) is 0 — a nullish signal must not read as IBS 0
  const top = Number(s.ibs);
  if (Number.isFinite(top)) return top;
  const ctx = Number(s.decision_context && s.decision_context.ibs);
  return Number.isFinite(ctx) ? ctx : null;
}
const _etDateStr = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// Minutes elapsed in the REGULAR session (09:30-16:00 ET); null outside it.
// The bounce exit reads a session range, so it needs the session to have one.
function _sessionMinutes(now) {
  const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 570 || m >= 960) return null;    // outside regular hours: the extended-hours guard already owns this path
  return m - 570;
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
const _zoneLadder = new Map();  // sym -> {r1, r1top, r2, broke} — zone-ladder exit state, set at entry (#3165)
const _exitStatus = new Map();  // sym -> broker status of the last exit order (an UNCONFIRMED exit — e.g. needs_confirmation — keeps the symbol frozen from re-exit until the position actually leaves the book)
// sym -> last observed broker snapshot { qty, entry, mark, ts } while we held it.
// This is what makes an EXTERNAL close (a resting protective stop filling, a manual
// flatten, another engine) reconstructable: when the position vanishes from the book
// without an autopilot exit of our own, this is the only record of what we held and
// where it was marked. Persisted, so an overnight stop-out is still landed at boot.
const _lastPos = new Map();
// FEED-FLAP GUARD STATE (#3378). Both maps demand agreement between two
// consecutive snapshots before anything irreversible happens:
//   _absentStreak — a tracked position books as externally CLOSED only after it
//                   is missing twice in a row (a single-read absence booked
//                   DIA/XLK/SOXS as closed on 2026-08-19 17:26 ET; all three
//                   were confirmed held two minutes later).
//   _seenStreak   — a position with no engine state is ADOPTED for tracking and
//                   exit management only after it is seen held twice in a row
//                   (one foreign snapshot injected another book's GLD/TLT; they
//                   were adopted on sight and their disappearance two minutes
//                   later was booked as our exits, at alien cost bases).
const _absentStreak = new Map();
const _seenStreak = new Map();
// FILL-BASIS CHECK (#3407). The entry row logs the decision-time quote; the
// broker's avg basis is only knowable later. sym -> { quote, ts }; when the
// held position first shows a basis differing by >1bp, ONE entry_fill row
// records both numbers (append-only correction, the ledger never mutates).
const _pendingFillBasis = new Map();
// ── LIMIT SHADOW (#3424 lab, journal-only) ────────────────────────────────────
// The depth sweep showed limit-filled entries earn 3-4x the touch entry per
// trade while the signals whose limit never fills are the weak ones — but the
// 26y daily bar cannot express an intraday limit, so the mechanism gets a live
// SHADOW before any order path changes. On every real entry we record the
// hypothetical resting limits at LIMIT_SHADOW_DEPTHS under the touch price;
// each scan marks which ones the mark has touched (a resting limit fills at
// its level — queue position is not modelled, the same optimism as the lab);
// the shadow closes with the session or the position. Nothing reads it in the
// engine; experiments/limit_shadow_score.js joins it to the exit rows.
// TRADER_LIMIT_SHADOW=0 disables.
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
function _checkFillBasis(sym, brokerEntry) {
  const p = _pendingFillBasis.get(sym);
  if (!p || !(Number(brokerEntry) > 0)) return;
  _pendingFillBasis.delete(sym);
  const q = Number(p.quote);
  if (!(q > 0)) return;
  const bps = Math.abs(brokerEntry / q - 1) * 1e4;
  if (bps <= 1) return;                                  // same price — nothing to correct
  logTrade({ event: 'entry_fill', symbol: sym, quote_px: q, fill_px: Number(brokerEntry),
    delta_bps: Math.round(bps * 10) / 10 });
}
// PROTECTIVE-STOP REGISTRY (#3379). sym -> { id, px, qty, at } for the stop THIS
// engine last placed. The point: /iserver/account/orders does not reliably show
// a prior-session GTC stop once it fills (SMH, 2026-08-19 — placed 08-18, filled
// 10:12, absent from the feed), so the fill reconciler cannot see the loss path
// it exists for. But the engine names these order ids itself at placement; with
// the id remembered — and PERSISTED, because a stop that outlives the process is
// exactly the case — the per-order status endpoint can answer "did my stop
// fill?" directly when a position vanishes.
const _stopOrders = new Map();
// #3413 BREAKEVEN RATCHET state: sym -> the stop level pinned at entry once the
// position has been up TRADER_BE_RATCHET. Never lowered while the position
// lives; cleared when it leaves the book. Persisted — the broker stop it
// mirrors is a GTC and outlives the process; even if this map is lost, the
// ratchet pass re-records a working stop it finds at/above entry.
const _beStopAt = new Map();
function _registerStop(sym, r, px, qty) {
  if (r && r.order_id && !/error/i.test(String(r.status || ''))) {
    _stopOrders.set(sym, { id: String(r.order_id), px, qty, at: Date.now() });
  }
}
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
/**
 * RECONCILE THE LEDGER AGAINST BROKER FILLS.
 *
 * Exits used to be written at order-PLACEMENT time from the position's last
 * MARK, which was wrong in both directions every session 2026-08-05..07:
 * stop-outs understated 30-60% (XLK -$319 logged vs -$641 filled), and an exit
 * order that never filled still logged as a completed exit (QQQ logged twice,
 * +$453 vs +$217 real). This makes the broker the source of truth — a row is
 * written when, and only when, a sell actually filled, priced at the fill.
 */
function _reconcileFills(orders) {
  const done = new Set();
  try {
    const rows = fillLedger.newExitRows(orders, _loggedFills, (sym) => {
      const lp = _lastPos.get(sym);
      // Excursions (#3241): the placement snapshot when this exit came from
      // closeLong (which clears the live maps), else the live maps — a protective
      // STP fills without ever passing through closeLong.
      const ex = _excursion.get(sym) || { peak: _peak.get(sym) ?? null, trough: _trough.get(sym) ?? null, stopDistPct: _stopDistPct.get(sym) ?? null };
      return { avg_entry_price: lp && lp.entry, reason: _exitIntent.get(sym), ...ex };
    }, _PROCESS_START);
    for (const row of rows) {
      // Case-insensitive (#3407): IBKR reports 'Stop', Alpaca reports 'stop'.
      // The exact-case compare cost a cooldown on 2026-08-21 — a real Alpaca
      // stop fill classified as plain 'broker fill', re-entry the same minute.
      const _isStopFill = /^stop$/i.test(String(row.order_type || '')) || /(^|\b)stop\b/i.test(String(row.reason || ''));
      // #3413: a fill of a RATCHETED stop (sitting at entry after the position
      // was up TRADER_BE_RATCHET) is a round trip, not a thesis failure — mark
      // the row so review/analytics can tell the two apart.
      if (_isStopFill && _beStopAt.has(row.symbol)) row.be_ratchet = true;
      logTrade(row);
      done.add(row.symbol);
      // #3379: a fill row for our registered stop consumes the registry entry —
      // the same-session path (the feed DID show this fill) needs no lookup.
      const _reg = _stopOrders.get(row.symbol);
      if (_reg && String(row.order_id) === _reg.id) _stopOrders.delete(row.symbol);
      _exitIntent.delete(row.symbol);
      _excursion.delete(row.symbol);   // consumed by the fill row it was frozen for
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
      trough: Object.fromEntries(_trough),
      excursion: Object.fromEntries(_excursion),   // placement→fill handoff must survive a restart

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
      unclosableAt: Object.fromEntries(_unclosableAt),
      loggedFills: [..._loggedFills].slice(-500),   // bounded: ids only matter within a session
      zoneLadder: Object.fromEntries(_zoneLadder),
      stopDistPct: Object.fromEntries(_stopDistPct),
      stopCooldownThrough: Object.fromEntries(_stopCooldownThrough),
      stopOrders: Object.fromEntries(_stopOrders),   // #3379: a GTC stop OUTLIVES the process by design
      beStopAt: Object.fromEntries(_beStopAt),       // #3413: the ratchet must not un-ratchet on restart
      limitShadow: Object.fromEntries(_limitShadow), // #3424: a restart mid-session must not lose the day's shadow
      stopFills: { day: _stopFillsDay, count: _stopFillsCount },   // breaker survives restarts
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
    for (const [k, v] of Object.entries(o.trough || {})) _trough.set(k, v);
    for (const [k, v] of Object.entries(o.excursion || {})) _excursion.set(k, v);
    for (const [k, v] of Object.entries(o.entryAt || {})) _entryAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitAt || {})) _exitAt.set(k, v);
    for (const [k, v] of Object.entries(o.exitStatus || {})) _exitStatus.set(k, v);
    for (const [k, v] of Object.entries(o.lastOrderAt || {})) _lastOrderAt.set(k, v);
    for (const [k, v] of Object.entries(o.dirStreak || {})) _dirStreak.set(k, v);
    for (const [k, v] of Object.entries(o.lastPos || {})) _lastPos.set(k, v);
    for (const [k, v] of Object.entries(o.exitFailures || {})) _exitFailures.set(k, v);
    for (const s of (o.unclosable || [])) _unclosable.add(s);
    for (const [k, v] of Object.entries(o.unclosableAt || {})) _unclosableAt.set(k, v);
    for (const id of (o.loggedFills || [])) _loggedFills.add(String(id));
    for (const [k, v] of Object.entries(o.zoneLadder || {})) _zoneLadder.set(k, v);
    for (const [k, v] of Object.entries(o.stopDistPct || {})) _stopDistPct.set(k, v);
    for (const [k, v] of Object.entries(o.stopCooldownThrough || {})) _stopCooldownThrough.set(k, v);
    for (const [k, v] of Object.entries(o.stopOrders || {})) _stopOrders.set(k, v);   // #3379: GTC stops outlive the process
    for (const [k, v] of Object.entries(o.beStopAt || {})) _beStopAt.set(k, v);       // #3413
    for (const [k, v] of Object.entries(o.limitShadow || {})) _limitShadow.set(k, v); // #3424
    if (o.stopFills && o.stopFills.day) { _stopFillsDay = o.stopFills.day; _stopFillsCount = Number(o.stopFills.count) || 0; }
    for (const [k, v] of Object.entries(o.lastConfirmedHold || {})) {
      const t = Number(v);
      if (Number.isFinite(t)) _lastConfirmedHold.set(k, t);
    }
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
// OPERATOR HOLD PIN (#3318). "Keep GLD" was not expressible: the operator
// trimmed the carry to GLD-only pre-open 2026-08-14 and the engine
// signal-exited it nine minutes into the session. A pinned symbol keeps every
// PROTECTIVE mechanism — stop, ladder banking, breaker — but signal-derived
// exits (signal_exit, momentum_died) are suppressed with an honest skip row.
// Sources, unioned: TRADER_PIN env (SYM1,SYM2) and pins.json next to the trade
// ledger ({"pins":["GLD"]}) — the file is re-read (2s mtime cache) so a pin
// works MID-SESSION without a restart, and a UI toggle can write it later.
const PIN_FILE = process.env.TRADER_PIN_FILE
  ? path.resolve(process.env.TRADER_PIN_FILE)
  : path.join(path.dirname(TRADES_LOG), 'pins.json');
let _pinCache = { at: 0, set: new Set() };
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

/**
 * How many held rows in a position snapshot does this engine have NO state for?
 * Pure so the 2026-08-19 flap is replayable in a test. `isKnown` receives the
 * uppercased symbol. (#3378)
 */
function snapshotForeignRows(rows, isKnown) {
  return (rows || []).filter((p) => Math.abs(Number(p && p.qty) || 0) > 0
    && !isKnown(String((p && p.symbol) || '').toUpperCase())).length;
}

/** Round for the ledger — MACD histograms live in the third decimal. */
const r4 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e4) / 1e4 : null);

/**
 * The knife READING, not just its verdict — { hist, prev, fires } or null.
 *
 * Split out so the skip row can record the two numbers the gate actually
 * decided on. Reconstructing them afterwards does not work: an offline replay
 * against the stored 5m corpus reproduces `hist < 0` on 91% of recorded fires
 * but `hist < prev` on only 72%, because the engine decides on bars fetched
 * live at scan time and a one-bar offset flips a difference between two
 * adjacent MACD reads. 70% fidelity is not enough to ask anything — a model
 * shown the reconstruction correctly objected that the rule's own premise was
 * unmet on 11 of 47 fires, which is a harness defect wearing the costume of a
 * finding. Recording beats rebuilding.
 */
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
  // WHOLE-SHARE EXITS (2026-08-10, dust re-entry companion). IBKR CPAPI rejects
  // fractional sells on these ETFs (the 0.8-share SOXS lesson). A position of
  // 300.8 must sell 300 and leave the inert sub-share tail — otherwise the
  // whole exit is rejected and the symbol re-strands. Sub-1 positions keep
  // their raw qty (nothing to floor to) and stay the unclosable-freeze's job.
  if (Number(qty) >= 1) qty = Math.floor(Number(qty));
  // Regular hours: a market SELL closes instantly. Pre/post market: IBKR rejects market
  // orders outside RTH, so use a marketable LIMIT (≈0.2% below the last print, to cross
  // the wider extended-hours spread) with outsideRTH=true so the exit still fills.
  // acceptWarnings: this is the engine's PRIMARY exit path (take-profit, max-loss,
  // momentum-died, trailing stop, signal exit). It only ever SELLS an existing long,
  // so it strictly reduces risk — an IBKR warning must not leave it unfilled.
  const order = (extended && refPrice > 0)
    ? { ticker: sym, side: 'sell', qty, type: 'limit', limitPrice: Math.round(refPrice * 0.998 * 100) / 100, outsideRth: true, acceptWarnings: true }
    : { ticker: sym, side: 'sell', qty, type: 'market', acceptWarnings: true };
  // CANCEL THE RESTING STOP **BEFORE** SELLING (2026-08-10, QQQ 9:33 incident).
  // Sell-first left both the protective stop AND the market sell open at the
  // broker for a beat — IBKR's oversell protection saw 2x the held quantity in
  // sells and CANCELLED the market exit (QQQ order 1119264656: Cancelled, 0
  // filled; XLK/IWM merely won the same race). Cancel-first closes that window;
  // if the sell then errors, the fast-exit tick re-attaches the missing stop
  // within seconds, so the position is never left unprotected for long.
  await cancelRestingStops(bridge, userId, sym);
  const r = await bridge.placeIBKROrder(userId, order).catch((e) => ({ status: 'error', reason: e.message }));
  // Freeze the excursion run BEFORE clearing per-symbol state — the fill row that
  // needs it is only written later, at broker reconcile (#3241).
  _excursion.set(sym, { peak: _peak.get(sym) ?? null, trough: _trough.get(sym) ?? null, stopDistPct: _stopDistPct.get(sym) ?? null });
  _entryAt.delete(sym); _peak.delete(sym); _trough.delete(sym); _lastOrderAt.set(sym, now); _exitAt.set(sym, now);
  _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
  _exitIntent.set(sym, reason);
  logTrade({ event: 'exit_intent', symbol: sym, qty, entry: hp.avg_entry_price ?? null, mark: hp.current_price ?? null, reason, status: r && r.status,
    // #3407: keep the broker's words — status:'error' alone cost a diagnosis round trip on 08-21
    error: (r && /error/i.test(String(r.status || '')) && (r.reason || r.error)) || null });
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
async function manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended = false, workingSells = new Set(), exclude = new Set(), protectiveOnly = false }) {
  // SUB-SHARE DUST NEVER EXITS (2026-08-10). A fractional-only order can never
  // fill on this API — the 0.8-share SOXS split remnant sprayed 3 error orders
  // at IBKR after EVERY restart (the failure-freeze is per-process-lifecycle in
  // practice). Skip by construction: qty < 1 = unfillable, full stop. Real
  // fractional positions ≥1 share still exit via the whole-share floor.
  // DELIBERATELY UNFILTERED (#3378). An early draft gated this on engine state,
  // which broke the max-loss backstop for any position whose bookkeeping was
  // lost (a restart with a stale state file would have left a -10% loser
  // unmanaged for two scans). Safety exits run on whatever the account truly
  // holds; the foreign-book problem this draft chased is handled UPSTREAM — the
  // bridge account pin refuses the wrong account's book outright, and the
  // foreign-snapshot tell stands the whole scan down before this function runs.
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
      if (_dm >= c.decarryMin && _dm < 960) {
        if (_isPinned(sym)) {
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

    // SESSION-END FLAT — see cfg.eodFlat. Runs after the leveraged de-carry so a
    // de-carry name is already handled; regular hours only (an extended-session
    // mark is not a close), and never against a pinned symbol.
    if ((c.eodFlat === 'weekend' || c.eodFlat === 'all') && qty >= 1 && !extended) {
      const _et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const _fm = _et.getHours() * 60 + _et.getMinutes();
      const _dow = _et.getDay();                       // 5 = Friday, the last session before a weekend
      const _due = c.eodFlat === 'all' || _dow === 5;
      if (_due && _fm >= c.eodFlatMin && _fm < 960) {
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

/**
 * PRICE-ONLY exit tick (#3165 "fast exit loop") — runs BETWEEN full scans so the
 * ladder / trailing / max-loss exits react in seconds, not the 60s scan cadence
 * (operator: a near-miss of R1 with dying momentum must exit near the peak, not a
 * minute later). Deliberately fetches NO bars and skips the momentum-death read —
 * everything here needs only the broker's live mark, so the added API cost is one
 * positions + one open-orders call per tick against the LOCAL gateway. All the
 * anti-churn gates (min-hold, exit debounce, oversell guard) apply unchanged.
 */
async function fastExitTick(opts = {}) {
  const prev = _actingUser;
  _actingUser = (opts && opts.userId) || null;
  try { return await _fastExitTickInner(opts); } finally { _actingUser = prev; }
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
/**
 * EXTENDED-HOURS PROTECTIVE MODE (`protectiveOnly`, 2026-08-12).
 *
 * Between 16:00 and 09:30 the scan loop is idle, so a winner's trailing floor is
 * never evaluated: on 2026-08-12 SOXS sat at +$3,617 exactly on its R2 target,
 * riding a trail that could not ratchet, and gave back into the after-hours
 * session with nothing but the -3% GTC stop underneath it. 17.5 hours of every
 * weekday the book was unmanaged.
 *
 * This mode runs the loop in pre/after-hours for MANAGEMENT ONLY:
 *   - NO entries. IBS is a position-within-session-range signal and the extended
 *     session has almost no range, so the signal is undefined there, and nothing
 *     in the lab covers extended-hours entries.
 *   - Only PRICE-THRESHOLD exits: r2_trail, zone floors, peak_giveback,
 *     trailing_stop, targets, max_loss. Each protects a gain or caps a loss at a
 *     level decided during regular hours.
 *   - NO signal-derived exits (momentum_died, the bearish signal_exit): a read
 *     computed off three thin pre-market bars is noise, and acting on it would
 *     dump a six-figure position into a wide spread.
 *
 * Orders still route as marketable LIMIT + outsideRth (closeLong's `extended`
 * path), never naked market orders into a thin book.
 */
// EXIT AUTHORITY (round-7 lab, 2026-08-23). The validated exit is the BOUNCE:
// sell at session IBS >= TRADER_IBS_EXIT (+ floor / trail / stop). Three older
// exits sit in front of it on this path and pre-empt it whenever they are on:
//   - the zone ladder (armed for EVERY entry since #3285; "zone ladder owns this
//     exit" blocked the bounce 305 times on live 8/10-8/21): an R1 target at the
//     zone or +3% with a give-back floor. round7_lab: ladder-owned exits earn
//     462% vs 1,494% on the 26y holdout (return/DD 26 vs 89) - ANY +3% target
//     clips the tail the bounce sells into.
//   - take_profit_R (default 1R = +3%) - the same clip, one layer down.
//   - momentum_died - a MACD read no lab has validated.
//   - exitMinPwin (0.6) - a legacy "bearishness" confidence that has nothing to
//     say about a bounce ("bearish too weak to exit" blocked 51 times).
// The validated structure needs all four out of the way:
//   TRADER_ZONE_EXIT=0 TRADER_TAKE_PROFIT_R=0 TRADER_MOMENTUM_EXIT=0 TRADER_EXIT_MIN_PWIN=0
// This does not change behaviour; it journals ONE config_warning row per process
// when the bounce gate is armed while something still pre-empts it, so the
// ledger shows the exit structure that is actually running.
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
// SLOT PRIORITY (round-7 lab, 2026-08-23). When more names fire in one scan
// than slots remain, the ADMISSION ORDER decides which get in - and with the
// hourly decision windows (#3435) several names routinely fire in the same
// minute on market-wide washout days, the paydays. round7_lab F, 26y holdout:
// arbitrary order 643%, shallowest-first 910%, deepest IBS first 1,494%,
// highest tilt weight then deepest IBS 2,866% (return/DD 129 vs 89; recent
// year 44.6% vs 31.5%) - fit winner, holdout confirms. The scan's own order is
// the legacy confidence score, which is arbitrary with respect to expectancy.
// TRADER_SLOT_ORDER: unset/confidence = the scan's order (current behaviour);
// depth = deepest session IBS first; expectancy = highest TRADER_SYMBOL_SIZE_MULT
// weight first, deepest IBS as the tie-break. Pure; never drops a candidate.
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
async function runAutoTrade(scan, opts = {}) {
  const prev = _actingUser;
  _actingUser = (opts && opts.userId) || null;
  try { return await _runAutoTradeInner(scan, opts); } finally { _actingUser = prev; }
}
async function _runAutoTradeInner(scan, { bridge, userId, now = Date.now(), caps = {}, extended = false, excludeSymbols = [], protectiveOnly = false } = {}) {
  // Position partitioning: symbols owned by ANOTHER engine (the overnight sleeve book)
  // are completely off-limits — no exits, no re-protect stops, no signal-sells, no
  // entries. Each engine manages only its own positions; the caller (trading.js)
  // supplies the live exclusion set.
  const exclude = new Set([...(excludeSymbols || [])].map((s) => String(s).toUpperCase()));
  const c = cfg();
  const out = { executed: [], skipped: [], enabled: c.enabled, manageExits: c.manageExits };
  _warnExitAuthority(c);
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
  // NEVER TRADE BLIND. Without a readable book the engine sees no holdings, so the
  // entry loop's `already long` guard cannot fire and it would happily re-buy a
  // symbol it is already carrying. Same contract as the account fetch above: no
  // broker truth, no orders. Exits are skipped too — the broker-side protective
  // stops are what guard the book in this state.
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
  for (const [k, q] of Object.entries(heldQty)) if (Math.abs(q) > 0) _lastConfirmedHold.set(k, now);
  // Snapshot every long we can still see, so a position that VANISHES before the next
  // scan can be reconstructed into the ledger (see the external-close sweep below).
  // OWNERSHIP FILTER (2026-08-13). heldPos is EVERY position in the account,
  // including other books' (champion holds XMMO/SPMO, the overnight sleeve holds
  // its own). Snapshotting them made the sweep below "reconstruct" their exits as
  // ours: on 2026-08-13 it logged SPMO -$199 and XMMO -$107 into the day-trader's
  // ledger. Only track symbols this engine actually scans — the scan's own signal
  // set is that list — plus anything we already have engine state for (ladder /
  // entry timestamp), so a position opened before a restart is still reconciled.
  const _ourSyms = new Set([
    ...signals.map((x) => String(x && x.symbol || '').toUpperCase()),
    ..._zoneLadder.keys(), ..._entryAt.keys(),
  ].filter(Boolean));
  const _driftPending = [];   // #3432 position-drift rows, journaled once the orders feed is in hand
  for (const [k, p] of Object.entries(heldPos)) {
    if (!(Number(heldQty[k]) > 0)) continue;
    if (_ourSyms.size && !_ourSyms.has(k)) continue;   // another engine's position
    // ADOPTION DWELL (#3378). Being in the watchlist is not proof a position is
    // ours: a foreign snapshot put GLD/TLT rows — another book's lots, other
    // cost bases — into heldPos and they were adopted on sight. A symbol with no
    // engine state must be seen held on two consecutive snapshots before this
    // engine tracks (and therefore later manages or books) it. Our own entries
    // carry state and are tracked immediately; a manual buy in our account is
    // adopted one scan later than before.
    const _stateful = _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)
      || _exitStatus.has(k) || _stopDistPct.has(k);
    if (!_stateful) {
      const _seen = (_seenStreak.get(k) || 0) + 1;
      if (_seen < 2) { _seenStreak.set(k, _seen); continue; }
    }
    _seenStreak.delete(k);
    // POSITION DRIFT (#3432). SPY grew 75 -> 76 -> 77 -> 78 on three consecutive
    // opens (2026-08-18..20) with no entry row in any ledger: something outside
    // this engine's order path was buying one share at a time, and nothing
    // noticed until the stop-size reconciliation complained. A held quantity
    // that changes between scans with no engine order in the last 10 minutes is
    // journaled here with both quantities and the broker orders the feed shows
    // for the symbol — the evidence the investigation was missing. Journal-only.
    {
      const _prev = _lastPos.get(k);
      const _newQ = Number(p.qty) || 0;
      if (_prev && Number.isFinite(Number(_prev.qty)) && Math.abs(_newQ - Number(_prev.qty)) >= 1e-6
          && (now - (_lastOrderAt.get(k) || 0)) > 10 * 60 * 1000) {
        _driftPending.push({ event: 'position_drift', symbol: k, qty_was: Number(_prev.qty), qty_now: _newQ,
          delta: +(_newQ - Number(_prev.qty)).toFixed(6), entry: p.avg_entry_price ?? null, mark: p.current_price ?? null,
          reason: _newQ > Number(_prev.qty) ? 'quantity grew with no engine order — external/phantom buy' : 'quantity shrank with no engine order — partial external sell' });
      }
    }
    _lastPos.set(k, {
      qty: Number(p.qty) || 0,
      entry: p.avg_entry_price ?? p.avg_fill_price ?? null,
      mark: p.current_price ?? null,
      ts: now,
    });
  }
  // consecutive means CONSECUTIVE: a dwell candidate that skips a scan starts
  // over — otherwise two one-off flap sightings days apart would sum to adoption.
  for (const k of [..._seenStreak.keys()]) if (!(Number(heldQty[k]) > 0)) _seenStreak.delete(k);

  // ── External-close sweep: THE LOSS PATH ────────────────────────────────────────
  // Broker orders are fetched HERE (before the reconstruct loop) because the
  // fill-based reconciliation must run first: a real fill is authoritative and
  // the reconstruct loop below must yield to it rather than logging a second,
  // mark-priced row for the same exit.
  const _ordersEarly = await bridge.getIBKROpenOrders(userId).catch(() => []);
  for (const _dr of _driftPending) {   // #3432: journaled with the broker orders the feed shows for the symbol
    logTrade({ ..._dr, feed_orders: (_ordersEarly || []).filter((o) => String(o.symbol || '').toUpperCase() === _dr.symbol)
      .map((o) => ({ id: o.orderId, side: o.side, type: o.orderType || o.type, qty: o.qty, status: o.status, price: o.price })).slice(0, 12) });
  }
  const _filledSyms = _reconcileFills(_ordersEarly);   // authoritative exits, priced at the fill
  // REGISTRY SEEDING (#3386). The #3379 registry only learns about stops the
  // engine places AFTER it shipped — QQQ, carried since 08-14 with a GTC stop
  // from a pre-registry process, stopped out on 2026-08-20 (-$1,718) and still
  // booked closed_externally with stop_order_id:null. The broker's own open-
  // orders book names those legacy stops, so adopt them: any WORKING sell-stop
  // on a symbol we hold, absent from the registry, is one of ours (the #3378
  // account pin guarantees this feed is our account). Seeded entries carry
  // seeded:true so a later audit can tell adoption from placement.
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
  // TRUST GUARD (2026-08-13). This sweep infers "closed" from ABSENCE, so it is
  // only as sound as the snapshot. Two ways the snapshot lies:
  //   (a) the fetch failed — now null, never an empty array;
  //   (b) IBKR returned an EMPTY/partial book at the open. Observed live on
  //       2026-08-13 09:30: every tracked position vanished for one cycle and the
  //       sweep invented four exits (SOXS double-counted at +$4,174 on top of its
  //       real +$2,740 fill; SQQQ "closed" while 1,566 shares were still held),
  //       inflating the day's ledger to +$7,305 against a broker equity that had
  //       FALLEN $4,634.
  // Absence is only evidence of a close when we can see the rest of the book. A
  // genuine simultaneous multi-symbol external close is vanishingly rare — real
  // stop fills arrive through _reconcileFills, which runs first and marks them.
  const _vanished = [..._lastPos.keys()].filter((k) => !(Number(heldQty[k]) > 0));
  // FOREIGN-BOOK TELL (#3378, live 2026-08-19 17:26 ET). During IBKR's daily
  // maintenance the gateway re-resolved "first discovered" and served the
  // OVERNIGHT book — 7 rows including an options leg — to this engine for two
  // minutes. The 2026-08-13 heuristic below (vanished>=3 && vanished>rows)
  // missed it because the alien snapshot was BIG: 3 vanished against 7 rows.
  // The tell that survives both shapes: several tracked positions gone WHILE
  // several rows appear that this engine has no state for. A legit mass
  // stop-out has only the first half; a legitimately growing book only the
  // second.
  const _knownSym = (k) => _lastPos.has(k) || _entryAt.has(k) || _zoneLadder.has(k)
    || _exitStatus.has(k) || _stopDistPct.has(k);
  const _foreignRows = snapshotForeignRows(positions, _knownSym);
  const _snapshotForeign = _vanished.length >= 2 && _foreignRows >= 2;
  const _snapshotSuspect = !_positionsOk
    || (positions.length === 0 && _lastPos.size > 0)
    || (_vanished.length >= 3 && _vanished.length > positions.length)
    || _snapshotForeign;
  if (_snapshotForeign) {
    // The FOREIGN shape is the only suspect flavor where NOTHING in the snapshot
    // can be trusted — not the sweep, not 'already long', not the exit loops
    // (this is the scan that tried to trailing-stop XMMO, a position this engine
    // never owned). Stand the whole scan down, same contract as a failed fetch.
    // Real fills were already reconciled above (they come from orders, not this
    // snapshot); broker-side protective stops keep guarding the real book. The
    // OTHER suspect flavors (empty book, mass-vanish) keep their 2026-08-13
    // behavior — sweep deferred, scan continues — because an empty-but-honest
    // book must still clear exit freezes and manage what remains.
    out.skipped.push({ symbol: '*', why: `foreign snapshot: ${_vanished.length} tracked position(s) absent while ${_foreignRows} unrecognised row(s) appeared — standing down this scan` });
    logTrade({ event: 'skip', symbol: '*', reason: `foreign snapshot: ${_vanished.length} tracked absent, ${_foreignRows} unrecognised rows — standing down this scan` });
    out.reason = 'position snapshot looks like another account\'s book — standing down this scan (never trade blind)';
    return out;
  }
  if (_snapshotSuspect && _vanished.length) {
    out.skipped.push({ symbol: '*', why: `external-close sweep deferred: ${_vanished.length} position(s) absent from a ${_positionsOk ? positions.length + '-row' : 'FAILED'} snapshot (${_foreignRows} foreign row(s)) — treating as unreadable, not closed` });
  }
  for (const sym of (_snapshotSuspect ? [] : [..._lastPos.keys()])) {
    if (Number(heldQty[sym]) > 0) { _absentStreak.delete(sym); continue; }           // still held → nothing to reconcile
    if (exclude.has(sym)) { _lastPos.delete(sym); _absentStreak.delete(sym); continue; }  // another engine owns it
    // An absence that is EXPLAINED needs no second read and no reconstruction:
    // our own exit already produced a row (this must catch every status — an
    // exit logged as needs_confirmation/dry_run is still a row, and
    // reconstructing on top of one produced two rows for one SHOP position),
    // and a broker fill reconciled this cycle is authoritative and priced at
    // the fill (reconstructing over it is the QQQ double-count of 2026-08-07).
    // Acknowledge these immediately, exactly as before #3378.
    if (_exitStatus.has(sym) || (_filledSyms && _filledSyms.has(sym))) {
      _lastPos.delete(sym);
      _absentStreak.delete(sym);
      continue;
    }
    // TWO CONSECUTIVE ABSENCES (#3378) — for the INFERENCE path only. One
    // missing read is a data point, not a close: single-read absences booked
    // three still-held positions as closed on 2026-08-19. A real stop-out still
    // books — one scan later — which delays the post-stop cooldown by that same
    // scan and changes nothing else.
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
    // ── STOP RECONCILIATION (#3379) ──────────────────────────────────────────
    // Before inventing a mark-priced reconstruction, ask the broker about the
    // stop THIS ENGINE placed for the symbol. The orders feed does not reliably
    // list a prior-session GTC stop once it fills (SMH 2026-08-19: placed 08-18,
    // filled 10:12 at 560.79, never in the feed), but the per-order status
    // endpoint answers for any id we can name — and we named this one. A hit
    // books a REAL stop exit, priced at the fill: stops_fired counts it, the
    // cooldown and breaker arm on it, and the row carries the order id instead
    // of a guess. Anything else falls through to the honest reconstruction.
    const _regStop = _stopOrders.get(sym);
    let _regStatus = null;
    if (_regStop && _regStop.id && !_loggedFills.has(_regStop.id)
        && typeof bridge.getIBKROrderStatus === 'function') {   // #3381: demo/practice facades lack it
      _regStatus = await bridge.getIBKROrderStatus(userId, _regStop.id).catch(() => null);
      if (_regStatus && /fill/i.test(String(_regStatus.status || ''))) {
        const _fillPx = Number(_regStatus.avgPrice) > 0 ? Number(_regStatus.avgPrice) : mark;
        const _fillQty = Number(_regStatus.filledQty) > 0 ? Number(_regStatus.filledQty) : qty;
        const _fillPnl = _round2((_fillPx - entry) * _fillQty);
        const _beHit = _beStopAt.has(sym);   // #3413: ratcheted stop → round trip, not failure
        logTrade({
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
          const _cd = cfg().stopCooldownDays;
          if (_cd > 0) _stopCooldownThrough.set(sym, _nextTradingDates(_etDate(Date.now()), _cd));
          _noteStopFill(Date.now());
        }
        _loggedFills.add(_regStop.id);          // a late feed appearance must not double-book
        _stopOrders.delete(sym);
        _peak.delete(sym); _trough.delete(sym); _entryAt.delete(sym); _excursion.delete(sym);
        continue;
      }
    }
    const pnl = _round2((mark - entry) * qty);
    const _lossPct = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
    // ── STOP ATTRIBUTION (#3281) ─────────────────────────────────────────────
    // The tail-defense counters — the per-symbol re-entry cooldown and the daily
    // circuit breaker — armed ONLY in _reconcileFills, which needs a broker stop
    // fill it can see. A stop-out that surfaces here instead, as an absence, armed
    // nothing. Live 2026-08-13: SQQQ stopped out at 10:29:35 for -$1,674.06 and was
    // re-entered at 10:29:38 — three seconds — and the day ended with
    // stopCooldownThrough {} and stopFills {day:null,count:0} after a real stop
    // fired. Both defenses were inert all session.
    //
    // We cannot KNOW this was the stop; the reason string says so ("protective
    // stop, manual close, or another engine"). But a position that left the book
    // having given up essentially its whole stop distance is a stop-out for every
    // purpose these two counters exist to serve, whoever pulled the trigger.
    // SQQQ left at -2.88% against a 3% stop — 96% of the distance.
    //
    // Deliberately asymmetric: arming costs one symbol one day of re-entry, while
    // NOT arming costs an immediate re-entry into the position that just stopped.
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

  // Fetch the account's working orders ONCE. Two uses: (1) re-protect naked longs, and
  // (2) the OVERSELL GUARD — a Set of symbols that already have a resting NON-stop SELL
  // (an exit/cover order that hasn't filled, common in thin extended hours). We never
  // stack another sell on those, so a lagging position snapshot can't make the loop sell
  // `held` again and blow through flat into a short. Survives restarts (broker-side state),
  // unlike the in-memory cooldown. Excludes protective STP sells (every long has one).
  let _openOrders = _ordersEarly;
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
      _stopOrders.delete(sym);                               // #3379: closeLong cancelled it; the record is dead
      _exitFailures.delete(sym); _unclosable.delete(sym);   // position gone → a future re-entry starts clean
      _unclosableAt.delete(sym); _exitNoOrder.delete(sym);
      _zoneLadder.delete(sym); _stopDistPct.delete(sym);
      _trough.delete(sym); _excursion.delete(sym);
      _beStopAt.delete(sym);                                 // #3413: ratchet dies with the position
      _limitShadowClose(sym, 'position_closed');             // #3424
    } else if (_isExitInFlight(_exitStatus.get(sym))) {
      // FREEZE EXPIRY AGAINST BROKER TRUTH (2026-08-08). The in-flight freeze had
      // no expiry and was never re-checked: a parked exit later cancelled/expired
      // at the broker kept the symbol frozen from EVERY engine exit — including
      // the max-loss backstop — until the position left the book. If no sell
      // order for the symbol is alive at the broker in ANY resurrectable status
      // (parked 'Inactive' counts as alive — a human can still confirm it) for
      // two consecutive scans AND the re-fire debounce has passed, the exit is
      // dead: release the freeze so the position can be managed again. Two misses
      // are required so a fill racing this scan's positions snapshot can't
      // unfreeze into a double-sell.
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

  // ── Re-protect naked longs: any held long that's lost its protective stop (the
  //    stop was consumed/cancelled while the position stayed open) gets a fresh GTC
  //    SELL STP. Runs every scan so a long is never left unprotected. ──
  try {
    // EMPTY ORDERS != NO STOPS (2026-08-12). Every re-protect decision below reads
    // ONE orders fetch. IBKR's CPAPI intermittently answers /iserver/account/orders
    // with an empty array (cold endpoint, session re-auth, maintenance window) —
    // and an empty list makes hasStop() false for EVERY symbol, so the pass
    // concludes the whole book is naked and stacks a duplicate GTC stop on each
    // position. That is precisely the mechanism behind the 2026-07-27 incident
    // (488 resting stop-sells, 95,561 shares against 3,772 held). The correct
    // reading of "no orders came back while positions exist" is UNKNOWN, not
    // UNPROTECTED: skip the pass and re-check next scan (~60s), by which point
    // the fetch has recovered. A genuinely naked position stays naked one extra
    // scan; a duplicate stop is an oversell that can flip the account short.
    // A truly empty book (no positions) is unambiguous and still passes through.
    const _heldCount = Object.values(heldPos).filter((p) => (Number(p.qty) || 0) > 0).length;
    const _ordersUnknown = _heldCount > 0 && (!Array.isArray(_openOrders) || _openOrders.length === 0);
    if (_ordersUnknown) {
      (out.skipped = out.skipped || []).push({ symbol: '*', why: `re-protect deferred: broker returned 0 orders while holding ${_heldCount} position(s) — treating as UNKNOWN, not unprotected` });
    }
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
      STOP_WORKING.test(o.status || ''));
    // ACCUMULATION CAP. A stop that never transmits (IBKR parks it 'Inactive' when an
    // order warning goes unconfirmed) is not protection, so hasStop() correctly ignores
    // it — but then this pass retries every scan forever: 2026-07-27 left 972 inert
    // stop attempts, ~33 per symbol. Retry a bounded number of times, then stop adding
    // and let the ledger show the failure instead of burying it under duplicates.
    const REPROTECT_MAX_ATTEMPTS = 3;
    // COUNT ONLY FAILED placements (2026-08-10 stop-lifecycle hardening). This
    // cap originally counted EVERY stop order for the symbol — including stops
    // we ourselves cancelled during healthy exit cycles (cancel-first sell) and
    // stops that FILLED. On 2026-08-10 each exit/retry cycle added a
    // Cancelled-by-us row until attemptsFor hit 3, and re-protection was then
    // refused for the rest of the session (149 're-protect capped' rows; IWM
    // and SOXL ran naked-stop stretches during venue retry cycles). A stop we
    // cancelled on purpose is lifecycle, not failure; only the parked/refused
    // vocabulary (Inactive / needs_confirmation / rejected) marks a placement
    // that never protected anything — the 972-order incident this cap exists
    // for was exactly that shape, and it still trips the cap.
    const attemptsFor = (sym) => (_openOrders || []).filter((o) =>
      String(o.symbol || '').toUpperCase() === sym &&
      /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '') &&
      isFailedStop(o.status)).length;
    // STOP-SIZE RECONCILIATION (2026-08-13). hasStop() asks "is there a stop?"
    // but never "is it the RIGHT SIZE?". After a partial exit the original stop
    // keeps its old quantity: live today GLD held 66 shares behind a 147-share
    // stop. Had it triggered it would have sold 81 shares we do not own — an
    // oversell opening an unintended SHORT, or (per IBKR's oversell protection,
    // seen on the QQQ race this morning) an outright rejection leaving the
    // position naked. Both unacceptable.
    //
    // A stop whose size does not match the position is not protection. Cancel it
    // here; the pass below then places a correctly-sized one. The failure cap is
    // untouched: a deliberate cancel is lifecycle, not a failed placement
    // (2026-08-12 hardening).
    const _stopQtyFor = (sym) => (_openOrders || [])
      .filter((o) => String(o.symbol || '').toUpperCase() === sym
        && /stp|stop/i.test(o.orderType || o.type || '') && /sell/i.test(o.side || '')
        && STOP_WORKING.test(o.status || ''))
      .reduce((a, o) => a + (Number(o.qty) || 0), 0);
    if (!_ordersUnknown) {
      for (const [sym, p] of Object.entries(heldPos)) {
        if (exclude.has(sym)) continue;
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
    // ── BREAKEVEN RATCHET (#3413 lab, 2026-08-22). Once a held long has been up
    // TRADER_BE_RATCHET (fraction, e.g. 0.02), its protective stop rises to the
    // entry price and never goes back down: the worst path a 2%-up position can
    // take becomes a round trip instead of a full -3% loser. Validated on all
    // four lab surfaces (hourly 2y halves + daily 26y two-window) with 5-10bp
    // stop-fill slippage charged: loss metrics improve everywhere with total
    // return kept (daily fit worst month -8.7% vs -10.3%, DD -19.2% vs -21.0%,
    // total 274% vs 215%). The mechanism reuses the resize→re-protect path: we
    // cancel the low stop here and pin the level; the re-protect pass below
    // places the new stop AT entry with all its usual guards (attempt caps,
    // whole-share, below-market clamp). DEFAULT OFF: unset/0 disables.
    const _bePct = Number(process.env.TRADER_BE_RATCHET) || 0;
    // TRADER_BE_LOCK (#3415 lab): the level the stop rises TO, as a fraction
    // above entry (0 = breakeven, the #3414 default). The stop/trail lab
    // validated a +1% PROFIT FLOOR (ratchet 0.01 + lock 0.01) on every surface
    // with entry+exit slippage charged: daily fit 419% vs 87%, holdout 549% vs
    // 261%, drawdown roughly halved. With lock == ratchet the stop sits at the
    // touch level and fills on the next downtick — effectively a take-profit.
    const _beLock = Math.max(0, Number(process.env.TRADER_BE_LOCK) || 0);
    const _stepPct = Math.max(0, Number(process.env.TRADER_STEP_FLOOR) || 0);   // 2026-08-24: stepped floor, % per step (0 = flat lock)
    if ((_bePct > 0 || _stepPct > 0) && !_ordersUnknown) {
      let _beCancels = 0;
      for (const [sym, p] of Object.entries(heldPos)) {
        if (exclude.has(sym)) continue;
        const qty = Number(p.qty) || 0;
        const entry = Number(p.avg_entry_price || p.avg_fill_price) || 0;  // genuine basis only — no mark fallback
        const mark = Number(p.current_price) || 0;
        if (qty < 1 || !entry || !mark) continue;    // dust cannot carry a stop at all
        // STEPPED FLOOR (#step, 2026-08-24 — operator: "if it's at 1%+ the exit
        // should be 1%, if 2%+ it should be 2%, if 3%+ it should be 3%").
        // TRADER_STEP_FLOOR = step size in PERCENT (1 = lock each whole percent);
        // unset/0 keeps the flat one-shot lock. Measured on the four surfaces:
        // step 1% beats the flat +1% floor on both holdouts (h2 49.7% ÷8.88 vs
        // 44.5% ÷7.57, 26y ÷161 vs ÷129) and — unlike the round-6 ratchet trail —
        // it SURVIVES finer bars (5m: +0.4% vs −0.9%, smaller drawdown at every
        // bar size), because it only moves at discrete levels rather than
        // following the peak continuously. It also subsumes the generic trail.
        const _prevLock = Number(_beStopAt.get(sym)) || 0;
        let _wantPct = null;
        if (_stepPct > 0) {
          const _gain = (mark / entry - 1) * 100;
          const _steps = Math.floor(_gain / _stepPct);
          if (_steps >= 1) _wantPct = (_steps * _stepPct) / 100;
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
          reason: _stepPct > 0
            ? `step_floor: mark +${((mark / entry - 1) * 100).toFixed(2)}% — stop steps up to entry+${(_wantPct * 100).toFixed(2)}% (${_stepPct}% steps, 2026-08-24)`
            : `be_ratchet: mark +${((mark / entry - 1) * 100).toFixed(2)}% >= +${(_bePct * 100).toFixed(1)}% — stop rises to ${_beLock > 0 ? `entry+${(_beLock * 100).toFixed(2)}% (profit lock, #3415)` : 'entry (#3413)'}`,
          entry, mark, stop_was: _top || null, stop_want: _lockLvl, lock: _wantPct || undefined, step: _stepPct || undefined });
        _saveState();   // the ratchet must survive a restart between cancel and re-protect
      }
      // Re-read orders after any cancel so the re-protect pass below sees the
      // symbol as unprotected and places the entry-level stop this scan.
      if (_beCancels) {
        const _fresh = await bridge.getIBKROpenOrders(userId).catch(() => null);
        if (Array.isArray(_fresh)) _openOrders = _fresh;
      }
    }
    for (const [sym, p] of Object.entries(heldPos)) {
      if (_ordersUnknown) break;                  // orders fetch unreadable this scan — never re-protect blind
      if (exclude.has(sym)) continue;             // overnight-owned: its own engine protects/exits it
      const qty = Number(p.qty) || 0;
      if (qty > 0 && !hasStop(sym) && attemptsFor(sym) >= REPROTECT_MAX_ATTEMPTS) {
        (out.skipped = out.skipped || []).push({ symbol: sym, why: `re-protect capped: ${attemptsFor(sym)} prior stop order(s) exist but none is working (check for unconfirmed/Inactive orders)` });
        continue;
      }
      if (qty > 0 && !hasStop(sym)) {
        // STACKING GUARD (#3432). The orders FEED can go blind to a WORKING stop
        // for hours: on 2026-08-17 this pass saw SPY and QQQ as naked on every
        // scan and placed a fresh stop each time — fifteen deep (1,125 shares of
        // stops on a 75-share position) by the 04:00 reconciliation. The per-
        // order status endpoint answers for any id we can name (#3379), and we
        // registered this one. A working answer means the feed is lying, not
        // the position naked — do not stack another.
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
        // A sell-STOP must sit BELOW the market or the broker rejects it. For a position
        // already underwater, the entry-based stop (entry×0.98) is ABOVE the current
        // price — so re-protect would silently fail and the loser stays naked. Clamp the
        // stop to just below the current price so an underwater long still gets a working
        // protective stop that caps further downside. (The max-loss backstop in
        // manageHeldExits is the harder floor if price is already past maxLossPct.)
        if (stop && curPx > 0 && stop >= curPx) {
          // A RATCHETED level at/above the market (lock == ratchet, or price
          // dipped back between the raise and this placement) must NOT take the
          // underwater clamp — that would park the stop a full stopPct under the
          // market and erase the lock. The lock was reached: sit 0.1% under the
          // market, the broker-order analog of "sell on the next downtick" the
          // lab validated (#3415).
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

  // ── Manage held longs on their own merits (trailing stop / take-profit / momentum
  //    death) — runs every scan, independent of new ENTER signals. This is what stops
  //    a winner from peaking and giving it all back. ──
  try { await manageHeldExits({ bridge, userId, heldPos, heldQty, c, now, out, extended, workingSells, exclude, protectiveOnly }); } catch (_e) { /* fail-soft */ }
  // manageHeldExits updates every held position's peak; persist NOW so the common
  // early-return paths below (exits-only mode, no ENTER signals) don't drop it.
  _saveState();

  // Entries require the full autopilot arm; exits-only mode stops here.
  if (!c.enabled) { out.reason = 'exit-management only (TRADER_MANAGE_EXITS) — entries off'; return out; }

  if (!enters.length) { out.reason = 'no ENTER signals'; return out; }

  // Daily-loss circuit breaker: once the account's day P&L is at/below the limit,
  // stop opening NEW positions (exits still run — closing losers is allowed).
  const dailyLimit = account.equity * (c.maxDailyLossPct / 100);
  // Broker shape normalization: the IBKR bridge returns a NUMBER, but the Alpaca,
  // house-paper, and demo facades return { dailyPnl, ... } objects — so the
  // `typeof === 'number'` check silently never armed the breaker on any of those
  // accounts (a -3% day kept opening fresh positions; audit 2026-08-08). Accept
  // both shapes; anything else (fetch failure) still fails open by design.
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
  if (c.entryKnifeFilter && enters.length) {
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
  if (protectiveOnly && enters.length) {
    out.skipped.push({ symbol: '*', why: `extended hours: protective exits only — ${enters.length} entry signal(s) not taken` });
  }
  for (const s of _entryCandidates) {
    const sym = String(s.symbol).toUpperCase();
    const price = Number(s.entry_price) || 0;
    const held = heldQty[sym] || 0;
    const bullish = s.direction === 'BULLISH';
    // The skip row carries the EVIDENCE, not just the verdict (#3374 follow-up).
    // Every gate below is judged on these numbers; recording them here is what
    // makes "was that veto right?" answerable later without rebuilding the
    // inputs from a bar corpus that disagrees with the engine 30% of the time.
    // scan.js computes the bundle as part of producing the signal, so this is a
    // spread, not a second calculation. Entry candidates only — exit-side skips
    // never reach this loop, so the ledger does not grow for them.
    const record = { symbol: sym, direction: s.direction, p_win: s.convergence.p_win, news: s.news || null,
      ...(s.decision_context || {}) };

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
    // OPENING FAST-PATH (2026-08-11). Two consecutive sessions showed the same
    // structural miss: the biggest washout bounces happen 09:45-09:55 (SLV +3.7%
    // and GLD +1.65% Mon; SOXL +2.72%, TQQQ +1.36% Tue) and the 2-scan
    // persistence requirement systematically eats them — by the second scan the
    // bounce is underway. During the opening window one scan suffices; every
    // other gate (falling-knife veto, cap, cooldown, breaker, dust) still
    // applies. TRADER_OPEN_FASTPATH=0 disables; window ends 10:00 ET.
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
      if (held >= 1) {
        // (held >= 1, not > 0: a sub-share split remnant can never fill a sell on
        // this API — same rule as manageHeldExits' dust guard, 2026-08-10.)
        // Anti-churn gates on the signal-exit (the broker stop still protects the
        // downside independently): (1) don't dump a long we just opened, (2) only
        // exit on a STRONG bearish read, (3) require it to persist across scans.
        // ── IBS THESIS GATE (fidelity lab, 2026-08-22). In IBS mode the read flips
        //    BULLISH→NEUTRAL the moment the session IBS rises above the entry
        //    threshold — i.e. the instant the washout starts to bounce — and that
        //    NEUTRAL read was selling winners ~50 minutes in for a median +0.09%
        //    (57 signal_exits 8/10–8/21, 36 inside ±0.2%; the analog on the same
        //    symbols/weeks earned ~9x by holding to the bounce). The validated exit
        //    is the BOUNCE: session IBS ≥ TRADER_IBS_EXIT (0.6). Until then the
        //    thesis is intact — the profit floor, stop and ladder protect; the
        //    signal does not sell. Off by default; a missing IBS reading falls
        //    through to the legacy behaviour.
        const _sIbs = _signalIbs(s);
        if (c.ibsExit > 0 && _sIbs != null && _sIbs < c.ibsExit) {
          out.skipped.push({ ...record, why: `washout thesis intact (IBS ${_sIbs.toFixed(2)} < ${c.ibsExit}) — no signal exit; floor/stop/ladder protect` });
          continue;
        }
        // ── SESSION-RANGE MATURITY (2026-08-24, the Monday morning liquidation).
        //    The gate above only holds a position when the IBS reading is FINITE.
        //    `sessionIbs()` returns null while `!(hi > lo)` — no regular-hours
        //    range yet — so in the first minutes of a session the gate fell
        //    through to the legacy exit; and with a range only cents wide the
        //    reading is hypersensitive (a two-cent uptick reads IBS 1.0). On
        //    2026-08-24 that dumped the whole overnight book in six signal_exits
        //    between 09:31 and 09:41, every one a loss, −$2,514 — and the ledger
        //    recorded ZERO "washout thesis intact" skips all day.
        //    Two guards, both entry-agnostic (stops, floor and trail untouched):
        //      a) a missing reading means HOLD, never sell (TRADER_EXIT_NEEDS_IBS=0 restores the old fallthrough)
        //      b) no signal exit until TRADER_EXIT_MIN_SESSION_MIN minutes into
        //         the regular session (default 30), by which time the range is
        //         wide enough for IBS to mean something.
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
        const r = await bridge.placeIBKROrder(userId, exOrder).catch((e) => ({ status: 'error', reason: e.message }));
        await cancelRestingStops(bridge, userId, sym);
        _entryAt.delete(sym); _exitAt.set(sym, now);
        _exitStatus.set(sym, r && r.status);   // freeze re-exit until this order confirms / the position leaves the book
        const hp = heldPos[sym] || {};
        // Realized P&L on the closed long (the position's unrealized P&L becomes real).
        _exitIntent.set(sym, 'signal_exit');
        logTrade({ event: 'exit_intent', symbol: sym, qty: held, entry: hp.avg_entry_price ?? null, mark: hp.current_price ?? null, reason: 'signal_exit', status: r && r.status });
        out.executed.push({ ...record, action: 'exit_long', qty: held, result: r });
        _lastOrderAt.set(sym, now);
      } else {
        out.skipped.push({ ...record, why: held < 0 ? 'already short — not deepening (longs-only)' : 'bearish, no long to exit' });
      }
      continue;
    }

    // ── BULLISH: open a long only if flat. Never pyramid; never sell. ──
    // DUST DOES NOT BLOCK RE-ENTRY (2026-08-10). The 0.8-share SOXS remnant
    // ($34, unclosable) made 'already long' permanent for its symbol — the slot
    // fix excluded dust from the CAP but not from this gate, so SOXS's +2.7%
    // washout this morning was unenterable. Same dust rule as the cap: a
    // position below dustPct of equity is not a position. The new integer-qty
    // entry merges with the remnant; exits floor to whole shares (closeLong),
    // so the sub-share tail stays inert instead of re-stranding the symbol.
    const _heldMv = Math.abs(Number(heldPos[sym] && heldPos[sym].market_value)
      || held * (Number(heldPos[sym] && heldPos[sym].current_price) || price || 0));
    const _isDustHolding = held > 0 && c.dustPct > 0 && _heldMv < account.equity * (c.dustPct / 100);
    if (held > 0 && !_isDustHolding) { out.skipped.push({ ...record, why: 'already long' }); continue; }
    // UNEXPLAINED FLAT = FEED DROPOUT, NOT AN OPPORTUNITY (#3282).
    //
    // `already long` above trusts one position snapshot. On 2026-08-13 the feed
    // dropped SOXS for two scans (11:13 held, 11:14 and 11:15 absent, 11:16 held)
    // and wrote no exit row of any kind. In the gap this loop saw `held === 0`,
    // treated SOXS as a fresh candidate, and opened a full-size tier-A+ entry on
    // top of the 1,490 shares already there — 3,057.8 total, twice the intended
    // maximum, behind a stop sized for part of it.
    //
    // A position genuinely leaving the book is EXPLAINED: our exit fills, or the
    // external-close sweep reconstructs one. Either clears _lastConfirmedHold.
    // A confirmed holding still sitting here means nothing explained the absence,
    // so the flat reading is not evidence we can open against.
    //
    // Bounded by _flatConfirmMs so stale state can never bar a symbol forever.
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
    // Falling-knife veto: don't buy the dip while down-momentum is still accelerating.
    // Wait for the momentum to turn (histogram rising, even if negative).
    //
    // MEASURED 2026-08-19 (#3357). This was the highest-firing gate in the engine
    // — 182 skips in a single session — and its only justification was the
    // sentence above plus a "(#c)" placeholder that referenced nothing. It was
    // also the gate most open to the objection that it fights the strategy: IBS
    // mean-reversion BUYS washouts, and a washout is exactly where MACD is
    // negative and deepening, so the veto looked like it might be filtering out
    // the very edge it was meant to protect.
    //
    // Replaying 565 first-IBS fires over 29 sessions and 35 symbols (same-day
    // close exit, 3% stop), evaluating this predicate on the closes available AT
    // each fire:
    //     vetoed  n=312   47% WR   -0.038%/trade   -11.9% total
    //     allowed n=253   45% WR   +0.041%/trade   +10.4% total
    // It earns its place: blocking those 312 avoided -11.9% of cumulative return.
    // Note it does NOT pick winners — the hit rates are within 2pp — it avoids
    // MAGNITUDE. The objection was wrong; waiting for the histogram to turn beats
    // buying into the acceleration.
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
      // MINIMUM STOP DISTANCE (stopMinPct). The zone stop can land INSIDE the
      // instrument's noise band: live 2026-08-06 SPY entered with a 0.20% stop
      // and was tagged in 29 minutes; four stop-outs that session fired within
      // ~20 minutes and cost -$1,235 against +$475 from the two positions that
      // survived long enough to reach a zone. Push the stop out so it marks a
      // broken thesis, not a wiggle. Must move the STOP PRICE, not just the
      // distance used for sizing — clamping the distance alone leaves the stop
      // where it was and it still gets tagged (the bug this replaces).
      if (_supStopPx != null && c.stopMinPct > 0) {
        _supStopPx = Math.min(_supStopPx, price * (1 - c.stopMinPct / 100));
      }
    }

    let sizeMult = (s.convergence && s.convergence.size_mult) || 1;
    // LOW-CONVICTION SIZE CUT (2026-08-11). On the first red-drift session all
    // four sub-0.5-p_win entries underperformed (XLK 0.483 took the day's only
    // loss; QQQ 0.452 scratched; the carried reds were 0.48-0.54) while every
    // >=0.55 entry won. Sizing already scales with conviction, but the curve
    // barely bit (0.452 still sized 0.76x). Below the coin-flip line the
    // position is a probe, not a bet: hard-cap the multiplier at 0.5x.
    // TRADER_LOWCONV_MULT tunes (0 disables). Entry count is unchanged — this
    // cuts exposure to weak signals, not the signals themselves.
    const _lowConvMult = process.env.TRADER_LOWCONV_MULT === undefined ? 0.5 : Number(process.env.TRADER_LOWCONV_MULT);
    if (_lowConvMult > 0 && Number(record.p_win) > 0 && Number(record.p_win) < 0.5) {
      sizeMult = Math.min(sizeMult, _lowConvMult);
    }
    // Stop distance is now an INPUT to sizing (risk-based), so it must be resolved
    // before the order is sized. Structural (support-entry) stop wins when armed.
    // The minimum-stop floor applies to EVERY entry, not just support entries.
    // Shipped 2026-08-06 wired only into the support-entry branch, so the four
    // symbols outside supEntrySyms (XLK IWM DIA SOXL) kept taking plan/ATR stops
    // of 1.0-1.5%. On 2026-08-07 all three entries were such symbols: XLK went in
    // with a 1.00% stop and was tagged 24 minutes later for -$642 on a 1% wiggle
    // — exactly the failure the floor exists to prevent, on a symbol the floor
    // did not cover. Applied to NEW entries only; stops already resting at the
    // broker are left alone.
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
    // STOP DERIVED FROM TARGET (stopFromTgt, 2026-08-07). Traders don't carry a
    // flat RR — they judge how far price can run and set the stop at a fraction
    // of that. Today stop and target are chosen INDEPENDENTLY (stop under the
    // support zone, target wherever R1 lands), so RR is an accident of geometry:
    // live 2026-08-06 produced targets of 0.53R-1.62R, i.e. winners paying LESS
    // than the 1R they risked. Deriving the stop as (distance to first real
    // resistance) / n makes RR exactly n:1 by construction and lets the stop
    // scale with the size of the opportunity.
    //   gate, holdout 2015-2026, %/trade: off +0.334  2:1 +0.355  3:1 +0.378
    //   (all three beat off in BOTH windows; 3:1 best on holdout)
    // The stopMinPct floor still wins afterwards — a derived stop must never
    // land back inside the noise band.
    let _stopDistEff = _stopDist;
    if (c.stopFromTgt > 0 && _resAbove[0]) {
      const _tgtPct = ((Number(_resAbove[0].level) - price) / price) * 100;
      _stopDistEff = Math.min(15, Math.max(c.stopMinPct, _tgtPct / c.stopFromTgt));
    }
    // MINIMUM ENTRY RR (minEntryRr). The stop floor and the 3:1 derivation fight
    // each other: stopFromTgt wants stop = target/3, but if that lands inside the
    // floor the floor wins (Math.max) and RR collapses. 2026-08-07 SOXL took a
    // 3.00% stop against a 1.60% target — 0.53:1, a trade that loses more than it
    // wins even when right — and closed -$217. When the floored stop cannot pay
    // at least minEntryRr, SKIP rather than take it.
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
    // HARD PER-POSITION CAP (operator, 2026-08-25). The tier / stress / tilt multipliers
    // still scale the RISK TARGET — that is what sizing by expectancy means — but they may
    // no longer lift the NOTIONAL CEILING above TRADER_MAX_POSITION_PCT. Before this, SOXL
    // and SMH and QQQ (tilt 1.5) sized to 18% of equity and 27% at VIX >= 20, which is also
    // why trading-guard refused to transact them: it read the bare 12%. One number now.
    // Cost, measured before arming (experiments/hard_cap_lab.js): return/DD h1 -15%,
    // d-fit -40%, h2 -22%, d-hold -44% — on the 26-year holdout 2,866% -> 1,202% of return
    // against a drawdown of 22.1% -> 16.5%. Down-weights are untouched: SPY 0.83 still
    // sizes to 9.96%, GLD/TLT 0.5 to 6%.
    const _capMult = Math.min(1, _tierMult * _stress.mult * _symMult);
    const qty = sizePosition({ equity: account.equity, price, sizeMult, positionPct: c.positionPct, maxPositionPct: c.maxPositionPct * _capMult, riskPct: c.riskPct * _tierMult * _stress.mult * _symMult, stopDistPct: _stopDistEff });
    if (qty < 1) { out.skipped.push({ ...record, why: 'size < 1 share' }); continue; }
    // CASH RESERVE (operator, 2026-08-06): total deployed capital is capped at
    // maxGrossPct of equity — the account always keeps (100 - maxGrossPct)% in
    // cash. Per-position caps alone don't bound the SUM: 12 tradelist symbols x
    // a 7% cap could theoretically deploy 84%. This is the portfolio-level
    // brake: an entry that would push gross exposure past the cap is skipped
    // (exits are never blocked — reducing risk is always allowed).
    // DAILY CIRCUIT BREAKER (2026-08-08). Two stop fills in one session = the
    // market is hostile today; refilling freed slots with fresh symbols into the
    // same tape built every 2008-class worst day. Entries only — exits and the
    // protective stops are untouched.
    if (_breakerTripped(now, c.stopBreaker)) {
      out.skipped.push({ ...record, why: `circuit breaker: ${_stopFillsCount} stop-outs today (max ${c.stopBreaker}) — no new entries this session` });
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
    // ENTRY CADENCE (#3435) — see _entryCadenceBlocked. Entries only.
    if (Number(process.env.TRADER_ENTRY_CADENCE_MIN) > 0) {
      const _ecMin = (() => { const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); })();
      const _ecDay = _etDateStr(now);
      const _ecDecided = _cadenceDecided.day === _ecDay ? _cadenceDecided.boundary : null;   // decisions never carry across sessions
      const _ecb = _entryCadenceBlocked(_ecMin, process.env.TRADER_ENTRY_CADENCE_MIN, process.env.TRADER_ENTRY_CADENCE_PHASE, process.env.TRADER_ENTRY_CADENCE_WINDOW, _ecDecided);
      if (_ecb) {
        out.skipped.push({ ...record, why: `entry_cadence: ${String(Math.floor(_ecMin / 60)).padStart(2, '0')}:${String(_ecMin % 60).padStart(2, '0')} ET ${_ecb.why === 'decided' ? 'already decided this bar' : 'is between bar closes'} — next decision ${_ecb.label} (#3435)` });
        continue;
      }
      // This scan reached the entry stage for this bar. The boundary is NOT
      // recorded here (2026-08-24): on 2026-08-24 the 10:00 scan spent the hour
      // on SMH, and SOXL — whose read turned eligible at 10:04, two minutes
      // after the 3-minute window closed — was locked out until 11:00 with slots
      // still free ("entry_cadence: already decided this bar"). The bar's
      // decision is spent only when an entry actually PLACES (see _markCadenceDecided
      // at the placement site), so a scan that enters nothing leaves the hour open.
      const _ecBoundary = _ecMin - ((((_ecMin - (Number(process.env.TRADER_ENTRY_CADENCE_PHASE) || 0)) % Number(process.env.TRADER_ENTRY_CADENCE_MIN)) + Number(process.env.TRADER_ENTRY_CADENCE_MIN)) % Number(process.env.TRADER_ENTRY_CADENCE_MIN));
      // `since`/`win` travel with the pending boundary so the placement site can tell an
      // in-window fill (others still get to compete) from a late-first-scan fill (spends the bar).
      _pendingCadence = { day: _ecDay, boundary: _ecBoundary, since: _ecMin - _ecBoundary,
        win: Math.max(1, Math.floor(Number(process.env.TRADER_ENTRY_CADENCE_WINDOW)) || 3) };
    }
    // POST-STOP RE-ENTRY COOLDOWN (2026-08-08). A stop-out means the washout kept
    // falling — re-buying the same knife the same/next session is the churn that
    // built the worst backtest days. Barred through the recorded ET date.
    if (c.stopCooldownDays > 0) {
      const _cdThrough = _stopCooldownThrough.get(sym);
      if (_cdThrough && _etDate(now) <= _cdThrough) {
        out.skipped.push({ ...record, why: `post-stop cooldown: stopped out, no re-entry through ${_cdThrough}` });
        continue;
      }
      if (_cdThrough) { _stopCooldownThrough.delete(sym); _saveState(); }   // expired → clean up
    }
    // CONCURRENT-POSITION CAP (maxConcurrent, 2026-08-07). Portfolio replay of
    // the holdout showed the left tail is a product of CONCURRENCY x STOP WIDTH,
    // not of any single bad trade: every worst day pinned at exactly -9.00% =
    // 3 positions x the 3% stop floor. Capping concurrency at 2 cut days worse
    // than -5% by 15% while AVERAGE %/trade actually improved (+0.384 vs
    // +0.378) and total return fell only 10%.
    // Honest limit: this does NOT reduce the negative-DAY rate (59-60% positive
    // at every cap tested, including off) — it truncates severity, not frequency.
    if (c.maxConcurrent > 0) {
      // DUST EXCLUSION (2026-08-07). The cap counts RISK SLOTS, not rows in the
      // book. Counting any qty>0 position saturated it with garbage: on the
      // morning after this shipped the account held QQQ ($32,983, real) plus the
      // SOXS remnant (0.8 shares, $35, flagged unclosable since 2026-08-04) —
      // 2 of 2 slots, so EVERY entry that session would have been refused by a
      // position worth 0.004% of equity that cannot even be sold.
      // A slot is consumed only by a position that is (a) economically
      // meaningful and (b) actually exitable.
      const _dustFloor = account.equity * (c.dustPct / 100);
      // heldPos is a snapshot taken ONCE at scan start, so several entries in the
      // same cycle all saw the same pre-scan count and each took "the last slot".
      // 2026-08-07: SOXL exited at 19:36:08, then XLK (:10) and QQQ (:11) both
      // entered in that cycle, leaving 3 positions open against maxConcurrent=2 —
      // the cap that bounds the left tail silently did not hold.
      const _openN = _openedThisScan + Object.values(heldPos).filter((p) => {
        const q = Math.abs(Number(p.qty) || 0);
        if (!(q > 0)) return false;
        if (_unclosable.has(String(p.symbol).toUpperCase())) return false;   // cannot be exited -> not a slot
        const mv = Math.abs(Number(p.market_value) || q * (Number(p.current_price) || 0));
        return mv >= _dustFloor;
      }).length;
      if (_openN >= c.maxConcurrent) {
        out.skipped.push({ ...record, why: `concurrent cap: ${_openN} positions open (max ${c.maxConcurrent})` });
        continue;
      }
      // SLOT RESERVE BY CONVICTION (#3317, 2026-08-15). Slots were first-come-
      // first-served, so weak signals could starve strong ones: on 2026-08-14
      // five slots were held largely by sub-0.50 probes when SMH fired at 0.61
      // and was refused — it ran +0.82% to the close. Week of 8/11: the sub-0.50
      // cohort netted −$516 (n=11) while ≥0.50 entries made money; 21 cap-blocks
      // in 4 sessions. The LAST slot is now reserved for conviction: a signal
      // below TRADER_SLOT_RESERVE_PWIN may fill up to (cap − reserve); only
      // ≥threshold signals may take the final slot(s).
      //
      // NOT lab-gated — the daily harness has no p_win dimension, so honesty
      // demands the opposite discipline: every refusal logs its own audit row
      // (symbol, p_win, what was held), so the live ledger accumulates the
      // counterfactual and the rule can be judged on real data. Kill:
      // TRADER_SLOT_RESERVE=0.
      if (c.slotReserve > 0 && (Number(record.p_win) || 0) < c.slotReservePwin
        && _openN >= c.maxConcurrent - c.slotReserve) {
        out.skipped.push({ ...record, why: `slot reserve: ${_openN}/${c.maxConcurrent} open and the last ${c.slotReserve} slot(s) are reserved for p_win ≥ ${c.slotReservePwin} — this signal is ${(Number(record.p_win) || 0).toFixed(3)}` });
        continue;
      }
    }
    // CORRELATED-RISK CAP (2026-08-13). The concurrency cap counts SYMBOLS; risk
    // is carried by DIRECTION. Live that day the book held SOXS + SQQQ + SPXS —
    // three families, so the direction-lock (which only blocks OPPOSING
    // exposure) permitted all three and the cap counted three independent slots.
    // They were one bet, "the market falls", held in triplicate; the market
    // rallied and they lost together for -$1,431 while a single position would
    // have lost a third of that.
    //
    // Structural, not bad luck: IBS buys whatever sits at the bottom of its
    // session range, and in a rally that is always the inverse ETFs — so the
    // engine concentrates short exactly when it is most wrong. Counting by
    // bucket bounds that. Positions opened THIS scan count too (same
    // start-of-scan-snapshot blind spot the concurrency cap had).
    if (c.maxPerBucket > 0) {
      const { riskBucket, bucketCounts } = require('./direction-lock');
      const _bucket = riskBucket(sym);
      const _counts = bucketCounts(Object.values(heldPos));
      const _inBucket = (_counts[_bucket] || 0) + (_bucketOpenedThisScan[_bucket] || 0);
      if (_inBucket >= c.maxPerBucket) {
        out.skipped.push({ ...record, why: `correlated-risk cap: ${_inBucket} position(s) already in '${_bucket}' (max ${c.maxPerBucket})` });
        continue;
      }
    }
    if (c.maxGrossPct > 0 && c.maxGrossPct < 100) {
      const _gross = _grossThisScan + Object.values(heldPos).reduce((a, p) => a + Math.abs(Number(p.market_value) || (Number(p.qty) || 0) * (Number(p.current_price) || 0)), 0);
      const _budget = account.equity * (c.maxGrossPct / 100);
      if (_gross + qty * price > _budget) {
        out.skipped.push({ ...record, why: `cash reserve: gross $${Math.round(_gross).toLocaleString()} + $${Math.round(qty * price).toLocaleString()} would exceed ${c.maxGrossPct}% of equity ($${Math.round(_budget).toLocaleString()})` });
        continue;
      }
    }

    // acceptWarnings on ENTRIES too (2026-08-10). IBKR attaches disclosure
    // prompts to leveraged/inverse-ETF orders ("intended for daily use…");
    // exits and stops already auto-confirm them, but entries did not — so the
    // first inverse signal of the session (SPXS, $115k, A-tier) died at
    // needs_confirmation while its exit would have sailed through. These
    // symbols were deliberately gated INTO the watchlist; the disclosure is
    // acknowledged by design, not per-order.
    // refPrice: the SAME quote this entry was sized from, so the guard's per-position
    // cap can price a market buy. Without it a market order's notional reads as zero
    // and the cap never binds on the engine's normal path (2026-08-25).
    const enOrder = (extended && price > 0)
      ? { ticker: sym, side: 'buy', qty, type: 'limit', limitPrice: Math.round(price * 1.002 * 100) / 100, outsideRth: true, equity: account.equity, acceptWarnings: true, refPrice: price }
      : { ticker: sym, side: 'buy', qty, type: 'market', equity: account.equity, acceptWarnings: true, refPrice: price };
    const r = await bridge.placeIBKROrder(userId, enOrder).catch((e) => ({ status: 'error', reason: e.message }));
    const exec = { ...record, action: 'open_long', qty, notional: Math.round(qty * price), result: r };
    // Attach a broker-side protective stop on the placed long — the hard stop the
    // position keeps even if the scan loop dies. Cancelled on the signal exit above.
    if (r && r.status === 'placed') {
      // The PLACED stop must be the same stop that sized the position and passed
      // the RR gate (_stopDistEff — target/3, floored, capped). It used to place
      // the pre-derivation structural stop (_stopDist) instead: sizing budgeted
      // risk at the derived stop while the broker held an 8-12% one, so realized
      // risk ran 1.6-2.4x the configured riskPct and the minEntryRr gate passed
      // trades whose true geometry was below 1:1 (audit 2026-08-08, probe-
      // verified). With no qualifying resistance _stopDistEff === _stopDist,
      // so structural/ATR stops are unchanged there.
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
      // Arm the ladder for EVERY entry (#3285, 2026-08-15). What actually failed
      // on 2026-08-14 was OWNERSHIP, not target distance: with no ladder armed
      // (blue sky + the fossil allowlist), the first weak scan owned the exit and
      // a SOXL entered 0.08% off the session low was scratched at +0.25% of a
      // +3.83% bounce. Blue sky now arms rungs at the PLAN targets — the same
      // distances the two-window lab validated — so every entry gets the
      // R1/R2/trail structure and signal_exit is pre-empted (#3165), everywhere.
      //
      // TIGHTENING THE RUNGS IS FALSIFIED. The obvious "make R1 reachable" fix
      // (rungs at k x daily-ATR) was swept 2000→2026, 10 symbols, 37,518 trades,
      // fit 2000-14 / holdout 2015-26, judged on total income:
      //
      //     base (plan targets)  fit  +852.0   holdout +1612.1   <- winner
      //     atr x1.5             fit  +664.7   holdout +1046.4
      //     atr x1.0             fit  +371.5   holdout  +728.8
      //     atr x0.75            fit  +250.4   holdout  +635.6
      //     MFE-p75 adaptive     fit  +516.4   holdout +1115.7
      //
      // Monotonic: the nearer the full-exit target, the more income dies — the
      // winners' tail pays for everything (the limit-entry lesson, exit-side).
      // TRADER_LADDER_VOL_MULT>0 keeps the tightened mode available for a future
      // re-test with a partial-bank runner structure; it is OFF by default.
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
      _markCadenceDecided();   // 2026-08-24: the bar's decision is spent only now, on a real placement
      const pl = s.plan || {};
      _pendingFillBasis.set(sym, { quote: price, ts: now });   // #3407: basis check armed
      _limitShadowArm(sym, price, now);                        // #3424: journal the limits we did not place
      logTrade({ event: 'entry', symbol: sym, side: 'long', qty, entry: price, notional: Math.round(qty * price), stress_mult: _stress.mult > 1 ? _stress.mult : undefined, stress_why: _stress.why || undefined, vix_prior: _vixPrior != null ? _vixPrior : undefined, sym_mult: _symMult !== 1 ? _symMult : undefined, p_win: s.convergence && s.convergence.p_win, stop: (exec.stop && exec.stop.price) ?? pl.stop ?? null, target1: pl.target1 ?? null, target2: pl.target2 ?? null, hold_days: pl.hold_days ?? null, tier: _tier, room_r: _roomR != null ? +_roomR.toFixed(2) : null, vol_ratio: Number(s.volume_ratio) || null,
        // drift-day attribution (2026-08-11): SPY's same-day % at entry time, so
        // the report can split entry outcomes by tape without guessing later.
        spy_1d: (scan && Number.isFinite(Number(scan.spy_1d))) ? Number(scan.spy_1d) : null,
        entry_src: 'quote',   // #3407: honest label — the fill basis arrives via entry_fill
        // MIRROR JOURNAL (#3390). The redirect counterfactual, priced at the
        // moment of decision: which same-leverage opposite instrument existed,
        // and what it cost right now. 2026-08-18 made the case — SOXL fired
        // BULLISH at 09:30 and lost -$2,433 while its mirror gained ~15%; a
        // regime-aware redirect is worth building only if rows like this keep
        // showing that swing, so every leveraged entry records the evidence.
        // Fail-soft: a missing quote journals null, never blocks the entry.
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
      // IBKR's `note` is a GENERIC instruction ("re-submit with acceptWarnings"),
      // identical for every warning type — it does not say WHICH warning fired.
      // On 2026-08-06 two entries parked ($67k notional) and the actual advisory
      // text existed only in r.warnings, which was never logged, so the block
      // could not be diagnosed from the ledger at all. Surface the real messages.
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
    if (r && (r.status === 'placed' || r.status === 'dry_run')) { _lastOrderAt.set(sym, now); if (r.status === 'placed') { _entryAt.set(sym, now); opened += 1; _openedThisScan += 1;
      try { const _b = require('./direction-lock').riskBucket(sym); _bucketOpenedThisScan[_b] = (_bucketOpenedThisScan[_b] || 0) + 1; } catch (_e) { /* bucketing is advisory */ } _grossThisScan += qty * price;
      // CSP SHADOW BOOK (#3219, observer only — never places orders): record the
      // paper cash-secured-put leg for this same signal, paired by symbol+ts.
      // Fire-and-forget: the chain fetch must never delay or break the scan.
      try { require('./csp-shadow').onEntry({ symbol: sym, price, qty, ts: now }).catch(() => {}); } catch (_e) { /* shadow book absent → nothing */ }
    } }
    else if (r) { _lastOrderAt.set(sym, now); }   // blocked → back off for the cooldown rather than re-fire every scan
  }
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
  // ── SLOT-UTILIZATION OBSERVABILITY (2026-08-08) ────────────────────────────
  // Throughput, not signal quality, is the open question at ~$235-400 captured
  // per trade: 0.5%/day needs both concurrency slots WORKING. This records every
  // transition of slots-in-use (same slot definition as the cap: dust and
  // unclosable positions excluded), so the daily report can time-weight how much
  // of the session ran 0/1/2 slots filled. One row per change, not per scan.
  if (process.env.TRADER_LOG_SKIPS !== '0' && c.maxConcurrent > 0) {
    const _dustFloorU = account.equity * (c.dustPct / 100);
    const _slotSyms = Object.values(heldPos).filter((p) => {
      const q = Math.abs(Number(p.qty) || 0);
      if (!(q > 0)) return false;
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
  // ── SESSION RECORD (#3286) ─────────────────────────────────────────────────
  // One row per trading day, at/after the close. The ledger held every trade but
  // nothing held the SESSION — no closing equity anywhere — so verifying a day's
  // P&L meant reconstructing yesterday's equity from bar closes. That
  // reconstruction is what exposed #3283; the check that should have caught it
  // years earlier, equity(today) − equity(yesterday), was simply unanswerable.
  //
  // Written from the same computeDayPnl the panel uses, so the stored figures
  // are the ones actually shown, and idempotence is checked against the ledger
  // (not memory) so a restart cannot double-write the date.
  try {
    const _sr = require('./session-record');
    const _ledger = fs.existsSync(TRADES_LOG) ? fs.readFileSync(TRADES_LOG, 'utf8') : '';
    if (_sr.shouldWriteSession(_ledger, now)) {
      // OWNERSHIP FILTER — heldPos is EVERY position in the account, not this
      // engine's. Champion holds XMMO/SPMO and the overnight sleeve holds its
      // own; feeding them in would put another book's positions into this
      // book's carried_out, open_risk and Day P&L. That is exactly the leak
      // that made the 2026-08-13 sweep reconstruct SPMO/XMMO exits as ours
      // (#3277). Same `_ourSyms` set that fix introduced.
      const _mine = Object.values(heldPos).filter((p) => {
        const k = String(p && p.symbol || '').toUpperCase();
        if (!(Math.abs(Number(p && p.qty) || 0) > 0)) return false;
        return !_ourSyms.size || _ourSyms.has(k);
      });
      const _dp = await require('./day-pnl').computeDayPnl({
        positions: _mine,
        ledgerText: _ledger,
        now,
        getQuotes: (syms) => require('./market-data-yahoo').getQuotes(syms),
      }).catch(() => ({}));
      logTrade(_sr.buildSessionRecord({
        ledgerText: _ledger, now, account, positions: _mine, dayPnl: _dp,
      }));
      // POST-CLOSE REVIEW (#3359). Fire-and-forget, AFTER the session row is
      // written — and read back FRESH, because `_ledger` is a string snapshot
      // taken BEFORE that row was appended. The reviewer's own first live run
      // (2026-08-19) caught the distinction: its top finding was "session_record
      // is null — the day's equity, day_pnl, stops_fired were never recorded",
      // and it was right about the text it was given. The snapshot structurally
      // cannot contain the record this role exists to audit, so every close
      // would have opened on the same false finding, burning one of its 12
      // finding slots and training whoever reads it to ignore the rest.
      // logTrade appends synchronously, so one re-read is guaranteed to include
      // today's row; if the read fails, fall back to the snapshot rather than
      // skip the review. It holds no
      // bridge and cannot place, cancel or size anything — the only thing it can
      // produce is a journal row of findings. Deliberately NOT awaited: a slow or
      // dead API must never delay the close, and its own failure paths already
      // return an empty review rather than throwing. Default OFF; enable with
      // TRADER_SESSION_REVIEW=1.
      try {
        const _rev = require('./session-review');
        if (_rev.enabled()) {
          const _day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          let _ledgerFresh = _ledger;
          try { _ledgerFresh = fs.readFileSync(TRADES_LOG, 'utf8'); } catch (_e) { /* snapshot fallback */ }
          _rev.review({ ledgerText: _ledgerFresh, day: _day })
            .then((r) => {
              // Summarise into the TRADE LEDGER, not stdout: every other
              // observable in this engine is queryable there, and a finding that
              // only exists in a console line is invisible to any post-mortem.
              // The findings themselves stay in session-reviews.jsonl; this row
              // is the pointer that shows up when you read the day back.
              if (r && !r.degraded && r.findings.length) {
                logTrade({
                  ts: new Date(now).toISOString(), user: userId, event: 'session_review',
                  date: _day, findings: r.findings.length,
                  high: r.findings.filter((f) => f.severity === 'high').length,
                  categories: [...new Set(r.findings.map((f) => f.category))].slice(0, 8),
                  summary: String(r.summary || '').slice(0, 200),
                });
              }
            })
            .catch(() => { /* the reviewer never escalates */ });
        }
      } catch (_e) { /* a missing reviewer must not affect the close */ }
    }
  } catch (_e) { /* observability only — never breaks the scan */ }
  // Persist the updated peaks/timers so the trailing stop survives a restart.
  _saveState();
  return out;
}
let _lastSlotSig = null;   // last logged slots-in-use signature (change-only dedupe)

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
    // EVIDENCE PASS-THROUGH (#3381). #3375 attached decision_context to every
    // entry-candidate record so a veto could be audited later — and this
    // whitelist then silently dropped every one of those fields before disk.
    // Found on the feature's first live day: the ledger rows were still bare.
    // The whitelist stays (a skip row must not balloon), but the evidence keys
    // are part of it now.
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
function _resetCooldowns() { _lastSlotSig = null; _stopCooldownThrough.clear(); _stopFillsDay = null; _stopFillsCount = 0; _lastSkipWhy.clear(); _lastOrderAt.clear(); _entryAt.clear(); _dirStreak.clear(); _peak.clear(); _trough.clear(); _excursion.clear(); _exitAt.clear(); _exitStatus.clear(); _lastPos.clear(); _exitFailures.clear(); _unclosable.clear(); _unclosableAt.clear(); _exitNoOrder.clear(); _zoneLadder.clear(); _stopDistPct.clear(); _lastConfirmedHold.clear(); _stopOrders.clear(); _beStopAt.clear(); _limitShadow.clear(); _absentStreak.clear(); _seenStreak.clear(); _saveState(); }

module.exports = { _isFailedStop: isFailedStop, _STOP_WORKING: STOP_WORKING, _STOP_TERMINAL: STOP_TERMINAL, runAutoTrade, fastExitTick, sizePosition, cfg, trailTriggerPct, isFallingKnife, knifeReading, snapshotForeignRows, manageHeldExits, _feedGuard: { absentStreak: _absentStreak, seenStreak: _seenStreak }, _stopOrders, _beStopAt, _entryHourBlocked, _parseEtWindows, _entryCadenceBlocked, _sessionMinutes, _markCadenceDecided, _signalIbs, _exitAuthorityConflicts, _orderEntries, _stressMultiplier, _stressCfg, _vixPriorClose, _symbolSizeMult, _limitShadow: { map: _limitShadow, arm: _limitShadowArm, tick: _limitShadowTick, close: _limitShadowClose, depths: LIMIT_SHADOW_DEPTHS }, cancelRestingStops, _pendingFillBasis, _checkFillBasis, _resetCooldowns, _logSkips, _saveState, _loadState, STATE_FILE };
