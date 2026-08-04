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
const { instrumentSign } = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "direction-lock"));

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

async function spyDailyBars(fromYear, sym) {
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${p2}`;
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
  const SYM = (args.indexOf("--symbol") >= 0 ? args[args.indexOf("--symbol") + 1] : "SPY").toUpperCase();
  const toYear = args.indexOf("--to") >= 0 ? Number(args[args.indexOf("--to") + 1]) : null;   // inclusive last year (out-of-sample splits)
  const SIGN = instrumentSign(SYM).sign;   // +1 long instrument, -1 inverse ETF (prod map)
  const WINDOW = 120;           // trailing bars the engine sees (matches ~scan depth)
  const bars = await spyDailyBars(fromYear - 1, SYM); // extra year for warmup
  console.log(`${SYM} daily bars: ${bars.length} (${bars[0].timestamp.slice(0, 10)} → ${bars[bars.length - 1].timestamp.slice(0, 10)})`);

  // MARKET regime must come from SPY — prod reads yahoo.getMarketStatus (the broad
  // market), NOT the traded ticker. Deriving it from the symbol's own SMA-200
  // INVERTS the gate for inverse ETFs (SQQQ above its SMA-200 = market falling),
  // which silently made every inverse-ETF result meaningless.
  const regimeByDate = new Map();
  {
    const spyBars = SYM === "SPY" ? bars : await spyDailyBars(fromYear - 1, "SPY");
    const spyCloses = spyBars.map((b) => b.close);
    for (let k = 0; k < spyBars.length; k++) {
      const s2 = sma(spyCloses.slice(0, k + 1), 200);
      regimeByDate.set(spyBars[k].timestamp.slice(0, 10),
        s2 == null ? "NEUTRAL" : spyCloses[k] > s2 ? "BULLISH" : "BEARISH");
    }
    console.log(`market-regime proxy: SPY (${regimeByDate.size} days)`);
  }

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
    if (toYear && year > toYear) break;

    // ── manage the open position first (no pyramiding — auto-trader style) ──
    if (open) {
      const nb = bars[i];                                 // today's bar closes the day after entry fill
      const held = i - open.entryIdx;
      // Max favourable excursion in R — how far price actually ran our way while held.
      // This is what decides whether a target was ever REACHABLE, vs merely unmet.
      const _fav = open.dir === "BULLISH" ? (nb.high - open.entryPx) : (open.entryPx - nb.low);
      open.mfeR = Math.max(open.mfeR || 0, _fav / open.riskAbs);
      let exit = null;
      if (open.dir === "BULLISH") {
        if (nb.low <= open.stop) exit = { px: open.stop, why: "stop" };
        else if (process.env.BT_ZONE_EXIT === "1" && open.r1 != null) {
          // Operator's ladder: momentum that CLOSES through R1 upgrades the target to
          // R2 and ratchets the floor to R1 (give-backs close there). A mere touch of
          // R1 without a close-through = momentum died at first resistance -> sell R1.
          if (!open.brokeR1) {
            if (nb.close > (open.r1top || open.r1)) { open.brokeR1 = true; }
            else if (nb.high >= open.r1) exit = { px: open.r1, why: "zone_r1" };
          } else {
            if (open.r2 != null && nb.high >= open.r2) exit = { px: open.r2, why: "zone_r2" };
            else if (nb.low <= open.r1) exit = { px: open.r1, why: "zone_r1_floor" };
          }
          // no zones above (r1 null) falls through to plan target below
        }
        else if (open.trailAtr) {
          // Trailing exit: ratchet the stop to (peak - trailAtr); never below the
          // protective stop. Exits when the bar's low tags the trail. Ordered stop-first
          // (conservative: an intrabar breach of the hard stop wins over the trail).
          open.peakPx = Math.max(open.peakPx || open.entryPx, nb.high);
          const trail = open.peakPx - open.trailAtr;
          if (trail > open.stop && nb.low <= trail) exit = { px: trail, why: "trail" };
        }
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
    const sr = findSrZones(SYM, price, win);
    const thresholds = adaptiveRsiThresholds(closes);
    const rsiVal = rsi(closes) ?? 50;
    const direction = scan.deriveDirection(sr, rsiVal, thresholds);
    if (direction === "NEUTRAL") continue;
    const struct = checkMarketStructureShift(win, direction);
    const candle = detectCandlePatterns(win, direction);
    // market regime proxy (yahoo.getMarketStatus in prod): SPY vs its SMA-200
    const marketStatus = { market: regimeByDate.get(bars[i].timestamp.slice(0, 10)) || "NEUTRAL" };
    // BT_REGIME_GATE=1 — regime ROUTING (operator ask 2026-08-04): only take an entry
    // when the BROAD MARKET agrees with the instrument's economic direction. Long
    // instruments trade bull tape; inverse ETFs trade bear tape. This is the gate the
    // production entry filter lacks — scan.js gates on the SYMBOL's own SMA-50/MACD,
    // never on the market.
    if (process.env.BT_REGIME_GATE === "1") {
      const want = SIGN === -1 ? "BEARISH" : "BULLISH";
      if (marketStatus.market !== want) { regimeBlocked++; continue; }
    }
    const trending = marketStatus.market !== "NEUTRAL";
    const gate = scan.rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending });
    if (!gate.actionable) continue;
    signalsSeen++;

    const volume_ratio = volumeRatio(win);
    const m = macd(closes);
    const macd_hist = m ? m.histogram : 0;
    const ma_signal = priceVsSma(closes, 20);
    const convergence = scan.convergenceVerdict({
      t: SYM, direction, sr, struct, candle, marketStatus,
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
    let tr = Number(process.env.BT_TARGET_R) || (convergence && convergence.target_r) || 2;
    // BT_ADAPTIVE_TGT: target = p-th percentile of the LAST 40 completed trades' MFE
    // (this symbol, walk-forward — only history that existed at entry time; falls back
    // to the plan target until 12 trades exist). BT_ADAPTIVE_PCT sets the percentile.
    if (process.env.BT_ADAPTIVE_TGT === "1" && trades.length >= 12) {
      const hist = trades.slice(-40).map((t) => t.mfeR || 0).sort((a, b) => a - b);
      const pct = Number(process.env.BT_ADAPTIVE_PCT) || 0.75;
      const cand = hist[Math.floor(pct * (hist.length - 1))];
      if (cand > 0.2) tr = Math.max(0.3, Math.min(3, cand));
    }

    // fill next bar's open (no same-bar close fills = no look-ahead)
    const fillPx = bars[i + 1].open;
    const stop = dirUp ? fillPx - riskAbs : fillPx + riskAbs;
    const target = dirUp ? fillPx + tr * riskAbs : fillPx - tr * riskAbs;
    open = {
      dir: direction, entryIdx: i + 1, entryPx: fillPx, entryDate: bars[i + 1].timestamp.slice(0, 10),
      regime: marketStatus.market,           // market tape at entry — for the by-regime P&L split
      targetR: tr, mfeR: 0,                  // plan target (R) and max favourable excursion (R)
      trailAtr: Number(process.env.BT_TRAIL_ATR) > 0 ? Number(process.env.BT_TRAIL_ATR) * (a || price * 0.005) : 0,
      peakPx: 0,
      // BT_ZONE_EXIT (operator design 2026-08-04): the two nearest RESISTANCE zones
      // above the fill form an exit ladder. r1 = first resistance (momentum usually
      // dies here), r2 = the runner target beyond it.
      ...(process.env.BT_ZONE_EXIT === "1" ? (() => {
        const res = ((sr && sr.zones) || []).filter((z) => /RESIST/i.test(z.type || "") && z.level > fillPx * 1.001)
          .sort((x, y) => x.level - y.level);
        return { r1: res[0] ? res[0].level : null, r1top: res[0] ? res[0].top : null,
                 r2: res[1] ? res[1].level : null, brokeR1: false };
      })() : {}),
      stop, target, riskAbs,
      // BT_HOLD_CAP bounds the ATR-scaled horizon to the operator's 1-7 day band
      // (a month-long hold is out of scope regardless of backtest result).
      holdDays: Math.min(
        Number(process.env.BT_HOLD_CAP) || 15,
        Math.max(1, Math.min(15, Math.round((tr * riskAbs) / ((a || price * 0.005))))) * (Number(process.env.BT_HOLD_MULT) || 1)
      ),
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
    target_diag: (() => {
      if (!trades.length) return {};
      const m = trades.map((t) => t.mfeR || 0).sort((a, b) => a - b);
      const q = (pp) => +m[Math.floor(pp * (m.length - 1))].toFixed(2);
      const tgt = trades.map((t) => t.targetR || 0);
      const reach = trades.filter((t) => (t.mfeR || 0) >= (t.targetR || 0)).length;
      return {
        mean_target_R: +(tgt.reduce((a, b) => a + b, 0) / tgt.length).toFixed(2),
        mfe_p50: q(0.5), mfe_p75: q(0.75), mfe_p90: q(0.9), mfe_max: q(1),
        pct_mfe_reached_target: +(reach / trades.length * 100).toFixed(1),
      };
    })(),
    by_regime: ["BULLISH","BEARISH","NEUTRAL"].reduce((acc,g)=>{const t=trades.filter(x=>x.regime===g);if(t.length){const w=t.filter(x=>x.r>0).length;const tot=t.reduce((a,x)=>a+x.r,0);acc[g]={n:t.length,win_pct:+(w/t.length*100).toFixed(1),total_R:+tot.toFixed(1),avg_R:+(tot/t.length).toFixed(3)};}return acc;},{}),
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
