"use strict";
/**
 * brake-monitor.js — STREAMING intraday risk monitor for the ADR-0028 Phase-2
 * leverage overlay (brake-to-cash spec). This is the "intra-day risk monitoring"
 * prerequisite named in docs/adr/0028-managed-strategy-sharpe-gate-tax-aware.md.
 *
 * Loop stage: Verify. Each tick it re-measures the overlay's three brake signals
 * against live market data and re-derives the gross-exposure target:
 *
 *   gross = clamp( min(MAX_GROSS, VOL_TARGET / vol) , [MIN_GROSS, MAX_GROSS] )
 *           × trendGate(6mo down → cash floor)
 *           × drawdownTaper(dd past 30% tapers 1× → cash floor by 60%)
 *
 * with VOL_TARGET = 0.35, MAX_GROSS = 2, MIN_GROSS = 0 (cash floor 0 beat 0.5 in
 * every train config — see experiments/leverage_brake_to_cash.py, validated
 * 2013+ Sharpe 0.85 [0.31, 1.38], maxDD −24%, 0/1,000 crisis-path margin calls).
 *
 * ADVISORY / PAPER ONLY. This module computes and streams brake state; it NEVER
 * places orders and touches no execution path (Act stays behind the ADR-0020
 * gates). The virtual $25,000 paper book it marks tick-to-tick IS the live
 * practice record the ADR-0028 mandate gate requires: only a strategy whose
 * measured Sharpe clears the Buffett bar (0.79) at the CI lower bound
 * (`meets_ci`) is ever eligible for real capital, and this stream is how the
 * overlay accumulates that measurable track record without risking a dollar.
 *
 * Single-process server: everything here is async + interval-driven (no
 * execSync, no blocking loops — the event-loop-freeze bug class).
 *
 * Kill switch: BRAKE_MONITOR=0 · interval: BRAKE_MONITOR_MS (default 60000).
 */

const path = require("path");
const fs = require("fs");

const yahoo = require("./market-data-yahoo");
const pa = require("./portfolio-analytics");
const appPaths = require("./app-paths");
const { writeTextQueued } = require("./file-queue");

// ── ADR-0028 champion config (brake-to-cash, tuned 2000–2012 / validated 2013+) ──
const UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"];
const MAX_GROSS = 2.0;
const MIN_GROSS = 0.0;   // cash floor — trend-down/deep-dd de-risks ALL the way to T-bills
const VOL_TARGET = 0.35; // annualized vol target (the aggressive champion; ADR-0028 §4)
const DD_BRAKE = 0.30;   // drawdown where the taper starts; fully cash by 2× this
const TREND_DAYS = 126;  // ~6 months of trading days
const VOL_LOOKBACK = 20; // 20d realized-vol window
const TBILL_RATE = Number(process.env.BRAKE_TBILL_RATE) || 0.03;  // flat T-bill proxy (matches the experiments)
const FUNDING_SPREAD = 0.015; // borrow at T-bill + 150bp when gross > 1
const START_EQUITY = 25000;   // virtual paper book (the ADR stress-test stake)
const RING_MAX = 500;         // ~8h of 60s ticks
const DAILY_KEEP = 160;       // daily closes kept per symbol (~130 needed + slack)
const HISTORY_MAX = 200;      // gross-change records kept in memory (route streams 50)
const MS_PER_YEAR = 365 * 24 * 3600 * 1000;
// Intraday annualization base: US equities trade ~252 × 6.5h sessions/year.
const TRADING_MS_PER_YEAR = 252 * 6.5 * 3600 * 1000;

function intervalMs() {
  const v = Number(process.env.BRAKE_MONITOR_MS);
  return Number.isFinite(v) && v >= 5000 ? v : 60000;
}

function stateFilePath() {
  return process.env.BRAKE_MONITOR_STATE_FILE
    || path.join(appPaths.stateRoot(), "data", "trading", "brake-monitor.json");
}

// ── pure signal math (exported for offline tests) ────────────────────────────

/** Sample stdev. */
function _stdev(a) {
  if (!a || a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Annualized 20d realized vol of a daily portfolio-return stream. */
function annualizedDailyVol(dailyRets, lookback = VOL_LOOKBACK) {
  const tail = (dailyRets || []).slice(-lookback);
  if (tail.length < 5) return null;
  return _stdev(tail) * Math.sqrt(pa.TRADING_DAYS);
}

/**
 * Annualized realized vol from the tick ring. `snapshots` is the chronological
 * ring of { t, prices: {SYM: px} }. Portfolio tick return = equal-weight mean of
 * per-symbol returns over symbols present (px > 0) in both snapshots. Pairs
 * whose gap exceeds 5× the median interval (restart / overnight) are skipped.
 * Annualization uses TRADING time (252 × 6.5h), scaled by the median tick gap.
 */
function intradayVolFromTicks(snapshots, minReturns = 30) {
  const snaps = (snapshots || []).filter((s) => s && s.prices);
  if (snaps.length < minReturns + 1) return null;
  const gaps = [];
  for (let i = 1; i < snaps.length; i++) gaps.push(snaps[i].t - snaps[i - 1].t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medGap = sorted[Math.floor(sorted.length / 2)] || 0;
  if (!(medGap > 0)) return null;
  const rets = [];
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].t - snaps[i - 1].t > 5 * medGap) continue; // gap across close/restart
    let sum = 0, n = 0;
    for (const sym of Object.keys(snaps[i].prices)) {
      const p1 = snaps[i].prices[sym], p0 = snaps[i - 1].prices[sym];
      if (p1 > 0 && p0 > 0) { sum += p1 / p0 - 1; n++; }
    }
    if (n > 0) rets.push(sum / n);
  }
  if (rets.length < minReturns) return null;
  return _stdev(rets) * Math.sqrt(TRADING_MS_PER_YEAR / medGap);
}

/**
 * THE BLEND (documented): vol = max(dailyVol, RMS(dailyVol, intradayVol)).
 * A conservative ratchet — a live intraday vol spike TIGHTENS the brake between
 * daily refreshes (the RMS term pulls the blend up), but flat after-hours ticks
 * can never RELEASE it below what 20 days of daily closes support (the max
 * floor). Missing legs degrade honestly to whichever leg exists.
 */
function blendVol(dailyVol, intradayVol) {
  const d = Number.isFinite(dailyVol) && dailyVol > 0 ? dailyVol : null;
  const i = Number.isFinite(intradayVol) && intradayVol > 0 ? intradayVol : null;
  if (d == null) return i;
  if (i == null) return d;
  return Math.max(d, Math.sqrt(0.5 * d * d + 0.5 * i * i));
}

/**
 * 6-month trend gate over aligned daily closes. `closesBySym` = {SYM: number[]}
 * (chronological). Weights = equal-weight direction for v1 (documented ADR
 * deviation: the experiments used the tangency direction; equal-weight is the
 * deterministic, estimation-error-free v1). Returns { ok, value, symbolsUsed }
 * or null when no symbol has enough history yet.
 */
function trendSignal(closesBySym, lookbackDays = TREND_DAYS) {
  const vals = [];
  for (const sym of Object.keys(closesBySym || {})) {
    const c = closesBySym[sym];
    if (!Array.isArray(c) || c.length < lookbackDays + 1) continue;
    const p0 = c[c.length - 1 - lookbackDays], p1 = c[c.length - 1];
    if (p0 > 0 && p1 > 0) vals.push(p1 / p0 - 1);
  }
  if (!vals.length) return null;
  const value = vals.reduce((s, x) => s + x, 0) / vals.length;
  return { ok: value >= 0, value, symbolsUsed: vals.length };
}

/**
 * The ADR-0028 brake-to-cash gross formula (see module header). Pure; returns
 * the target rounded to 2dp so tick noise doesn't churn the change stream.
 */
function computeGross({ vol, trendOk, drawdown, volTarget = VOL_TARGET, maxGross = MAX_GROSS, minGross = MIN_GROSS, ddBrake = DD_BRAKE }) {
  // vol targeting, uncapped below 1× — clamps to [minGross, maxGross]
  let g = Math.min(maxGross, Math.max(minGross, volTarget / Math.max(Number(vol) || 0, 1e-6)));
  const volCap = g;
  // 6-mo trend down → the cash floor (fully to T-bills at minGross = 0)
  if (trendOk === false) g = Math.min(g, minGross);
  // drawdown taper: past ddBrake, cap slides linearly 1× → minGross by 2×ddBrake
  let ddCap = null;
  const dd = Number(drawdown) || 0;
  if (dd < -ddBrake) {
    const over = Math.min(1, (Math.abs(dd) - ddBrake) / ddBrake);
    ddCap = minGross + (1 - over) * Math.max(0, 1 - minGross);
    g = Math.min(g, ddCap);
  }
  g = Math.round(Math.max(minGross, Math.min(maxGross, g)) * 100) / 100;
  return { gross: g, volCap: Math.round(volCap * 100) / 100, ddCap: ddCap == null ? null : Math.round(ddCap * 100) / 100 };
}

/**
 * Mark the virtual paper book across one tick. Equal-weight direction v1:
 * portfolio return = previous APPLIED gross × avg symbol return. Carry is
 * pro-rated on CALENDAR time (funding/cash accrue around the clock):
 *   gross > 1 → PAYS (T-bill + 150bp) on the borrowed fraction  (negative carry)
 *   gross < 1 → EARNS the T-bill rate on the uninvested fraction (positive carry)
 * Mutates `book` ({equity, peak, gross}); returns { portR, carry } for tests.
 */
function applyPaperMark(book, { avgSymReturn, dtMs, rf = TBILL_RATE, spread = FUNDING_SPREAD }) {
  const g = Number(book.gross) || 0;
  const dtYears = Math.max(0, Number(dtMs) || 0) / MS_PER_YEAR;
  const portR = g * (Number(avgSymReturn) || 0);
  const carry = g > 1
    ? -(g - 1) * (rf + spread) * dtYears
    : (1 - g) * rf * dtYears;
  book.equity = Math.max(0, book.equity * (1 + portR + carry));
  if (book.equity > book.peak) book.peak = book.equity;
  return { portR, carry };
}

/** Plain-language action line for the current brake state. */
function describeAction({ warming, gross, trendOk, ddActive, volCap, maxGross = MAX_GROSS }) {
  if (warming) return "warming up — building daily history before applying leverage";
  if (trendOk === false) return "trend down → cash";
  if (ddActive && gross < volCap) return `drawdown taper → ${gross.toFixed(1)}×`;
  if (volCap < maxGross) return `vol brake → ${gross.toFixed(1)}×`;
  return `holding ${gross.toFixed(1)}×`;
}

// ── monitor state (module singleton, like kalshi-collector) ──────────────────

const state = {
  running: false,
  timer: null,
  lastTick: null,
  ring: [],                 // [{t, prices:{SYM:px}}], capped RING_MAX
  daily: {},                // SYM → Map<YYYY-MM-DD, adjclose> (last DAILY_KEEP)
  dailyRefreshedOn: null,   // YYYY-MM-DD of the last successful refresh
  dailyExcluded: [],        // [{symbol, reason}] from the last refresh
  dailyRefreshing: false,
  book: { equity: START_EQUITY, peak: START_EQUITY, gross: 0 }, // gross = APPLIED (prev tick's target)
  lastPrices: null,         // {SYM:px} at the last mark
  lastMarkTs: null,         // ms epoch of the last mark
  grossTarget: null,
  action: "not started",
  signals: { vol: null, trend: null, drawdown: null },
  grossHistory: [],         // [{ts, from, to, action}], capped HISTORY_MAX
  persistTimer: null,
  lastError: null,
};

function serializeState() {
  return {
    equity: state.book.equity,
    peak: state.book.peak,
    gross: state.book.gross,
    lastPrices: state.lastPrices,
    lastMarkTs: state.lastMarkTs,
    grossHistory: state.grossHistory.slice(-HISTORY_MAX),
    savedAt: new Date().toISOString(),
  };
}

function restoreState(saved) {
  if (!saved || typeof saved !== "object") return;
  if (Number.isFinite(saved.equity) && saved.equity >= 0) state.book.equity = saved.equity;
  if (Number.isFinite(saved.peak) && saved.peak > 0) state.book.peak = saved.peak;
  if (Number.isFinite(saved.gross)) state.book.gross = Math.max(0, Math.min(MAX_GROSS, saved.gross));
  if (saved.lastPrices && typeof saved.lastPrices === "object") state.lastPrices = saved.lastPrices;
  if (Number.isFinite(saved.lastMarkTs)) state.lastMarkTs = saved.lastMarkTs;
  if (Array.isArray(saved.grossHistory)) state.grossHistory = saved.grossHistory.slice(-HISTORY_MAX);
}

async function saveStateNow() {
  return writeTextQueued(stateFilePath(), JSON.stringify(serializeState(), null, 2));
}

async function loadStateFromDisk() {
  try {
    const raw = await fs.promises.readFile(stateFilePath(), "utf8");
    restoreState(JSON.parse(raw));
    return true;
  } catch (_e) {
    return false; // first boot / unreadable — start fresh
  }
}

// Debounced persist: state changes every tick; write at most once per 2s.
function schedulePersist() {
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    saveStateNow().catch((e) => { state.lastError = `persist: ${e.message}`; });
  }, 2000);
  if (typeof state.persistTimer.unref === "function") state.persistTimer.unref();
}

// ── daily-close refresh (once per UTC day, via the analytics engine's fetch) ──

async function refreshDailyIfDue() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyRefreshing) return;
  if (state.dailyRefreshedOn === today && Object.keys(state.daily).length) return;
  state.dailyRefreshing = true;
  try {
    const excluded = [];
    let got = 0;
    await Promise.all(UNIVERSE.map(async (sym) => {
      try {
        const m = await pa.fetchDailyHistory(sym, 2); // ~500 closes; keep the tail
        const dates = [...m.keys()].sort().slice(-DAILY_KEEP);
        state.daily[sym] = new Map(dates.map((d) => [d, m.get(d)]));
        got++;
      } catch (e) {
        excluded.push({ symbol: sym, reason: e.message }); // keep any prior data
      }
    }));
    state.dailyExcluded = excluded;
    if (got >= 2) state.dailyRefreshedOn = today; // partial is workable; total failure retries next tick
  } finally {
    state.dailyRefreshing = false;
  }
}

// Aligned daily closes + equal-weight portfolio daily returns from state.daily.
function _dailyAligned() {
  const have = Object.keys(state.daily).filter((s) => state.daily[s] && state.daily[s].size >= VOL_LOOKBACK + 2);
  if (!have.length) return null;
  const aligned = pa.alignReturns(Object.fromEntries(have.map((s) => [s, state.daily[s]])));
  if (!aligned.symbols.length || !aligned.dates.length) return null;
  const T = Math.min(...aligned.symbols.map((s) => aligned.returns[s].length));
  const port = new Array(T);
  for (let t = 0; t < T; t++) {
    let sum = 0;
    for (const s of aligned.symbols) sum += aligned.returns[s][t];
    port[t] = sum / aligned.symbols.length;
  }
  const closesBySym = {};
  for (const s of have) {
    closesBySym[s] = [...state.daily[s].keys()].sort().map((d) => state.daily[s].get(d));
  }
  return { port, closesBySym };
}

// ── the tick (all async; one batched quote fetch reusing the watchlist cache) ──

async function tick() {
  try {
    const now = Date.now();
    // 1) latest quotes — market-data-yahoo.getQuotes shares its 20s cache with
    //    the watchlist pollers, so this is usually a warm in-process read.
    const rows = await yahoo.getQuotes(UNIVERSE);
    const prices = {};
    for (const r of rows || []) if (r && r.price > 0) prices[r.ticker] = r.price;
    if (Object.keys(prices).length) {
      state.ring.push({ t: now, prices });
      if (state.ring.length > RING_MAX) state.ring.splice(0, state.ring.length - RING_MAX);
    }

    // 2) once-per-day slow-signal refresh (daily closes for vol20d + 6-mo trend)
    await refreshDailyIfDue();

    // 3) signals
    const dailyA = _dailyAligned();
    const dailyVol = dailyA ? annualizedDailyVol(dailyA.port) : null;
    const intradayVol = intradayVolFromTicks(state.ring);
    const vol = blendVol(dailyVol, intradayVol);
    const trend = dailyA ? trendSignal(dailyA.closesBySym) : null;
    const warming = vol == null || trend == null;

    // 4) mark the paper book with the PREVIOUS applied gross, then retarget
    if (state.lastPrices && state.lastMarkTs != null) {
      let sum = 0, n = 0;
      for (const sym of Object.keys(prices)) {
        const p0 = state.lastPrices[sym];
        if (p0 > 0) { sum += prices[sym] / p0 - 1; n++; }
      }
      if (n > 0) applyPaperMark(state.book, { avgSymReturn: sum / n, dtMs: now - state.lastMarkTs });
    }
    if (Object.keys(prices).length) { state.lastPrices = prices; state.lastMarkTs = now; }

    const drawdown = state.book.peak > 0 ? state.book.equity / state.book.peak - 1 : 0;
    // Until the slow signals exist the book sits UNLEVERED (1×) — honest warmup,
    // no leverage without the evidence the overlay is defined over.
    const g = warming
      ? { gross: 1.0, volCap: 1.0, ddCap: null }
      : computeGross({ vol, trendOk: trend.ok, drawdown });
    const ddActive = drawdown < -DD_BRAKE;
    const action = describeAction({ warming, gross: g.gross, trendOk: trend ? trend.ok : null, ddActive, volCap: g.volCap });

    if (state.grossTarget == null || Math.abs(g.gross - state.grossTarget) >= 0.01) {
      state.grossHistory.push({ ts: new Date(now).toISOString(), from: state.grossTarget, to: g.gross, action });
      if (state.grossHistory.length > HISTORY_MAX) state.grossHistory.splice(0, state.grossHistory.length - HISTORY_MAX);
    }
    state.grossTarget = g.gross;
    state.book.gross = g.gross; // applied next tick (tick-to-tick, per the paper-book spec)
    state.action = action;
    state.signals = {
      vol: {
        state: vol == null ? "warming" : (g.volCap < MAX_GROSS ? "braking" : "ok"),
        value: vol, daily20d: dailyVol, intraday: intradayVol,
        target: VOL_TARGET, cap: g.volCap,
        blend: "max(daily20d, RMS(daily20d, intraday)) — intraday can only tighten, never release",
      },
      trend: {
        state: trend == null ? "warming" : (trend.ok ? "ok" : "braking"),
        value: trend ? trend.value : null, lookbackDays: TREND_DAYS,
        symbolsUsed: trend ? trend.symbolsUsed : 0,
      },
      drawdown: {
        state: ddActive ? "braking" : "ok",
        value: drawdown, brakeAt: -DD_BRAKE, cashBy: -2 * DD_BRAKE, cap: g.ddCap,
      },
    };
    state.lastTick = new Date(now).toISOString();
    state.lastError = null;
    schedulePersist();
  } catch (e) {
    state.lastError = e.message;
  }
}

// ── lifecycle (kalshi-collector pattern) ─────────────────────────────────────

function start() {
  if (state.running) return;
  if (process.env.BRAKE_MONITOR === "0") {
    console.info("[Brake Monitor] disabled (BRAKE_MONITOR=0)");
    return;
  }
  state.running = true;
  const ms = intervalMs();
  console.info(`[Brake Monitor] starting ${ms / 1000}s loop — ADR-0028 overlay, PAPER ONLY (places nothing)`);
  loadStateFromDisk()
    .then(() => tick())
    .catch((e) => { state.lastError = e.message; });
  state.timer = setInterval(() => { tick(); }, ms);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

function stop() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.persistTimer) { clearTimeout(state.persistTimer); state.persistTimer = null; }
  state.running = false;
}

function getStatus(opts = {}) {
  const historyLimit = Number(opts.historyLimit) || 50;
  return {
    ok: true,
    mode: "paper", // the ADR-0028 gate decides when anything touches real money
    running: state.running,
    intervalMs: intervalMs(),
    universe: UNIVERSE,
    lastTick: state.lastTick,
    grossTarget: state.grossTarget,
    action: state.action,
    signals: state.signals,
    book: {
      equity: Math.round(state.book.equity * 100) / 100,
      peak: Math.round(state.book.peak * 100) / 100,
      startEquity: START_EQUITY,
      grossApplied: state.book.gross,
      tbillRate: TBILL_RATE,
      fundingSpread: FUNDING_SPREAD,
      lastMarkTs: state.lastMarkTs ? new Date(state.lastMarkTs).toISOString() : null,
    },
    history: state.grossHistory.slice(-historyLimit),
    daily: { refreshedOn: state.dailyRefreshedOn, excluded: state.dailyExcluded },
    ticksBuffered: state.ring.length,
    formula: `gross = clamp(min(${MAX_GROSS}, ${VOL_TARGET}/vol), [${MIN_GROSS}, ${MAX_GROSS}]) × trendGate(6mo down→cash) × ddTaper(${Math.round(DD_BRAKE * 100)}%→cash by ${Math.round(2 * DD_BRAKE * 100)}%)`,
    lastError: state.lastError,
    disclaimer: "paper mode — advisory measurement only; this monitor places nothing, and only a meets_ci strategy is ever eligible for live capital (ADR-0028)",
  };
}

module.exports = {
  start, stop, getStatus, tick,
  // pure compute surface (offline tests)
  computeGross, blendVol, annualizedDailyVol, intradayVolFromTicks, trendSignal,
  applyPaperMark, describeAction,
  // persistence surface (offline tests use BRAKE_MONITOR_STATE_FILE)
  serializeState, restoreState, saveStateNow, loadStateFromDisk, stateFilePath,
  // config constants (tests assert against these, not copies)
  UNIVERSE, MAX_GROSS, MIN_GROSS, VOL_TARGET, DD_BRAKE, TREND_DAYS, START_EQUITY,
  TBILL_RATE, FUNDING_SPREAD,
};
