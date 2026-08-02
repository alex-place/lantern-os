/**
 * spy_engine_backtest.js — walk-forward backtest of the intraday signal engine
 * against SPY daily bars from 2000 (operator ask, 2026-08-01).
 *
 * WHAT THIS IS: the REAL production modules (signal-engine/sr-zones, indicators,
 * candles, market-structure, scan.js's rileyGate + convergenceVerdict + regime
 * filter + ATR trade plan) walked bar-by-bar over SPY history. No look-ahead:
 * each day sees only the trailing window.
 *
 * WHAT THIS IS NOT: a 15m intraday replay — free data has no intraday bars back
 * to 2000. The engine's math is bar-scale-agnostic (RSI/SR/MACD over closes),
 * so this measures the LOGIC's edge on daily bars; intraday microstructure
 * (slippage, session opens) is out of scope. Fills are next-bar-open, exits at
 * stop/target/time like auto-trader's exit ladder.
 *
 * Usage: node experiments/spy_engine_backtest.js [--from 2000] [--csv out.csv]
 */
"use strict";

const https = require("https");
const path = require("path");
const LIB = path.join(__dirname, "..", "apps", "lantern-garage", "lib", "signal-engine");
const { rsi, adaptiveRsiThresholds, macd, priceVsSma, volumeRatio, atr } = require(path.join(LIB, "indicators"));
const { findSrZones } = require(path.join(LIB, "sr-zones"));
const { detectCandlePatterns } = require(path.join(LIB, "candles"));
const { checkMarketStructureShift } = require(path.join(LIB, "market-structure"));
const scan = require(path.join(LIB, "scan"));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on("error", reject);
    rq.setTimeout(30000, () => { rq.destroy(); reject(new Error("timeout")); });
  });
}

async function spyDailyBars(fromYear) {
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&period1=${p1}&period2=${p2}`;
  const j = await fetchJson(u);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data: " + JSON.stringify(j).slice(0, 200));
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    bars.push({
      timestamp: new Date(ts[i] * 1000).toISOString(),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
      volume: q.volume[i] || 0,
    });
  }
  return bars;
}

function sma(a, n) { if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; }

async function main() {
  const args = process.argv.slice(2);
  const fromYear = Number((args[args.indexOf("--from") + 1] || 2000)) || 2000;
  const WINDOW = 120;           // trailing bars the engine sees (matches ~scan depth)
  const bars = await spyDailyBars(fromYear - 1); // extra year for warmup
  console.log(`SPY daily bars: ${bars.length} (${bars[0].timestamp.slice(0, 10)} → ${bars[bars.length - 1].timestamp.slice(0, 10)})`);

  const trades = [];
  let open = null;              // { dir, entryIdx, entryPx, stop, target, holdDays }
  let signalsSeen = 0, enterVerdicts = 0, regimeBlocked = 0;

  const allCloses = bars.map((b) => b.close);

  for (let i = WINDOW; i < bars.length - 1; i++) {
    const today = bars[i];
    const win = bars.slice(i - WINDOW, i + 1);           // trailing window incl today
    const closes = win.map((b) => b.close);
    const price = today.close;
    const year = Number(today.timestamp.slice(0, 4));
    if (year < fromYear) continue;

    // ── manage the open position first (no pyramiding — auto-trader style) ──
    if (open) {
      const nb = bars[i];                                 // today's bar closes the day after entry fill
      const held = i - open.entryIdx;
      let exit = null;
      if (open.dir === "BULLISH") {
        if (nb.low <= open.stop) exit = { px: open.stop, why: "stop" };
        else if (nb.high >= open.target) exit = { px: open.target, why: "target" };
      } else {
        if (nb.high >= open.stop) exit = { px: open.stop, why: "stop" };
        else if (nb.low <= open.target) exit = { px: open.target, why: "target" };
      }
      if (!exit && held >= open.holdDays) exit = { px: nb.close, why: "time" };
      if (exit) {
        const sign = open.dir === "BULLISH" ? 1 : -1;
        const r = (sign * (exit.px - open.entryPx)) / open.riskAbs;
        trades.push({ ...open, exitPx: exit.px, exitWhy: exit.why, exitDate: nb.timestamp.slice(0, 10), heldDays: held, r });
        open = null;
      }
      if (open) continue;                                 // still in a trade → no new scans
    }

    // ── run the production per-ticker scan logic on the trailing window ──
    const sr = findSrZones("SPY", price, win);
    const thresholds = adaptiveRsiThresholds(closes);
    const rsiVal = rsi(closes) ?? 50;
    const direction = scan.deriveDirection(sr, rsiVal, thresholds);
    if (direction === "NEUTRAL") continue;
    const struct = checkMarketStructureShift(win, direction);
    const candle = detectCandlePatterns(win, direction);
    // market regime proxy (yahoo.getMarketStatus in prod): SPY vs its SMA-200
    const s200 = sma(allCloses.slice(0, i + 1), 200);
    const marketStatus = { market: s200 == null ? "NEUTRAL" : price > s200 ? "BULLISH" : "BEARISH" };
    const trending = marketStatus.market !== "NEUTRAL";
    const gate = scan.rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending });
    if (!gate.actionable) continue;
    signalsSeen++;

    const volume_ratio = volumeRatio(win);
    const m = macd(closes);
    const macd_hist = m ? m.histogram : 0;
    const ma_signal = priceVsSma(closes, 20);
    const convergence = scan.convergenceVerdict({
      t: "SPY", direction, sr, struct, candle, marketStatus,
      news_sentiment: 0, volume_ratio, macd_hist, ma_signal,
      earnings_surprise: null, sector_trend: null,
    });
    if (!convergence || convergence.decision !== "ENTER") continue;
    enterVerdicts++;

    // regime filter (scan.js lines ~275-279, verbatim logic)
    const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, x) => s + x, 0) / 50 : null;
    if (direction === "BULLISH") {
      const trendOk = (sma50 == null || price > sma50) && macd_hist > 0;
      if (!trendOk) { regimeBlocked++; continue; }
    }
    // --symmetric: apply the SAME regime gate to shorts (candidate fix — prod
    // only filters longs, which let the engine short a rising index for years)
    if (process.env.BT_SYMMETRIC === "1" && direction === "BEARISH") {
      const trendOk = (sma50 == null || price < sma50) && macd_hist < 0;
      if (!trendOk) { regimeBlocked++; continue; }
    }
    if (process.env.BT_LONG_ONLY === "1" && direction === "BEARISH") continue;

    // ATR trade plan (scan.js verbatim)
    const a = atr(win);
    const dirUp = direction === "BULLISH";
    const risk = Math.max((a || 0) * 2, price * 0.015);
    let stopPx = dirUp ? price - risk : price + risk;
    const near = (lvl) => Math.abs(price - lvl) / price;
    if (dirUp && sr.support > 0 && sr.support < price && near(sr.support) >= 0.005 && near(sr.support) < 0.06) stopPx = sr.support;
    if (!dirUp && sr.resistance > price && near(sr.resistance) >= 0.005 && near(sr.resistance) < 0.06) stopPx = sr.resistance;
    const riskAbs = Math.max(Math.abs(price - stopPx), price * 0.008);
    const tr = (convergence && convergence.target_r) || 2;

    // fill next bar's open (no same-bar close fills = no look-ahead)
    const fillPx = bars[i + 1].open;
    const stop = dirUp ? fillPx - riskAbs : fillPx + riskAbs;
    const target = dirUp ? fillPx + tr * riskAbs : fillPx - tr * riskAbs;
    open = {
      dir: direction, entryIdx: i + 1, entryPx: fillPx, entryDate: bars[i + 1].timestamp.slice(0, 10),
      stop, target, riskAbs,
      holdDays: Math.max(1, Math.min(15, Math.round((tr * riskAbs) / ((a || price * 0.005))))) * (Number(process.env.BT_HOLD_MULT) || 1),
      p_win: convergence.p_win, conf: gate.confidence, quality: gate.quality,
    };
  }

  // ── report ──
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0);
  const grossW = wins.reduce((s, t) => s + t.r, 0);
  const grossL = trades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  const sumR = grossW + grossL;
  const pf = grossL !== 0 ? grossW / -grossL : Infinity;
  // 1%-risk-per-trade equity curve
  let eq = 1; let peak = 1; let maxDd = 0;
  for (const t of trades) { eq *= 1 + 0.01 * t.r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak); }
  const first = bars.findIndex((b) => Number(b.timestamp.slice(0, 4)) >= fromYear);
  const bh = bars[bars.length - 1].close / bars[first].close;

  const byDir = {};
  for (const t of trades) { (byDir[t.dir] = byDir[t.dir] || []).push(t.r); }
  const stat = (rs) => rs.length ? `${rs.length} trades, win ${(100 * rs.filter((r) => r > 0).length / rs.length).toFixed(0)}%, avg ${(rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(2)}R` : "none";

  console.log(JSON.stringify({
    period: `${fromYear} → ${bars[bars.length - 1].timestamp.slice(0, 10)}`,
    gate_actionable_signals: signalsSeen,
    ev_enter_verdicts: enterVerdicts,
    regime_filter_blocked: regimeBlocked,
    trades: n,
    win_rate_pct: n ? +(100 * wins.length / n).toFixed(1) : null,
    profit_factor: n ? +pf.toFixed(2) : null,
    total_R: +sumR.toFixed(1),
    avg_R: n ? +(sumR / n).toFixed(3) : null,
    equity_1pct_risk: +eq.toFixed(3),
    max_drawdown_pct: +(100 * maxDd).toFixed(1),
    buy_hold_multiple: +bh.toFixed(2),
    long: stat(byDir.BULLISH || []),
    short: stat(byDir.BEARISH || []),
    exits: trades.reduce((m, t) => ((m[t.exitWhy] = (m[t.exitWhy] || 0) + 1), m), {}),
  }, null, 2));

  // per-era breakdown
  const eras = [[2000, 2009], [2010, 2019], [2020, 2026]];
  for (const [a1, b1] of eras) {
    const rs = trades.filter((t) => { const y = +t.entryDate.slice(0, 4); return y >= a1 && y <= b1; }).map((t) => t.r);
    console.log(`  ${a1}-${b1}: ${stat(rs)}`);
  }
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
