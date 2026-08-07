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
  // BT_DAY_DUMP=1 — emit one line per closed trade so daily P&L can be
  // aggregated ACROSS symbols. "No fully negative days" is a portfolio-level
  // property; per-symbol win rate cannot answer it.
  const _dayDump = process.env.BT_DAY_DUMP === "1";
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
      const _adv = open.dir === "BULLISH" ? (open.entryPx - nb.low) : (nb.high - open.entryPx);
      open.maeR = Math.max(open.maeR || 0, _adv / open.riskAbs);
      let exit = null;
      if (open.dir === "BULLISH") {
        if (nb.low <= open.stop) exit = { px: open.stop, why: "stop" };
        // BT_EXIT_MA5 (weekend research 2026-08-08): Connors-style mean-reversion
        // exit — close the long when price CLOSES above its 5-day SMA. Published
        // RSI-2 results (75% WR, +0.57%/trade on SPY since 1993) use exactly this
        // exit and NO ordinary stop: Connors' own testing over hundreds of
        // thousands of trades found stops HURT mean reversion because they fire
        // at maximum stretch, right before the snapback — which is literally what
        // our live stops did all week (every loss was a stop; every ladder exit
        // won). The floor stop is kept as the disaster brake only.
        else if (process.env.BT_EXIT_MA5 === "1" && held >= 1) {
          const _c5 = bars.slice(Math.max(0, i - 4), i + 1).map((b) => b.close);
          const _sma5 = _c5.reduce((a, b) => a + b, 0) / _c5.length;
          if (nb.close > _sma5) exit = { px: nb.close, why: "ma5_exit" };
        }
        else if (process.env.BT_ZONE_EXIT === "1" && open.r1 != null) {
          // Operator's ladder: momentum that CLOSES through R1 upgrades the target to
          // R2 and ratchets the floor to R1 (give-backs close there). A mere touch of
          // R1 without a close-through = momentum died at first resistance -> sell R1.
          if (!open.brokeR1) {
            if (nb.close > (open.r1top || open.r1)) { open.brokeR1 = true; }
            else if (nb.high >= open.r1) exit = { px: open.r1, why: "zone_r1" };
          } else {
            if (open.r2 != null && nb.high >= open.r2) exit = { px: open.r2, why: "zone_r2" };
            else if (process.env.BT_TRAIL_FLOOR === "1") {
              // STRUCTURE-TRAILING FLOOR (operator 2026-08-05): after the R1 break the
              // floor ratchets UP to each newly-formed support zone — a late retrace
              // no longer gives back the whole run.
              if (open.floorPx == null) open.floorPx = open.r1;
              const _aN = atr(bars.slice(Math.max(0, i - 30), i + 1)) || nb.close * 0.005;
              const _srN = findSrZones(SYM, nb.close, bars.slice(Math.max(0, i - 120), i + 1));
              const _supN = ((_srN && _srN.zones) || [])
                .filter((z) => /SUPPORT/i.test(z.type || "") && (z.bottom || z.level) - 0.25 * _aN > open.floorPx && (z.top || z.level) < nb.close)
                .sort((x, y) => (y.bottom || y.level) - (x.bottom || x.level))[0];
              if (_supN) open.floorPx = (_supN.bottom || _supN.level) - 0.25 * _aN;
              if (nb.low <= open.floorPx) exit = { px: Math.min(open.floorPx, nb.high), why: "struct_floor" };
            }
            else if (nb.low <= open.r1) exit = { px: open.r1, why: "zone_r1_floor" };
          }
          // give-back tier (validated 2026-08-04): >=90% of the way to R1 then a 40%
          // give-back of the peak gain exits near the peak instead of round-tripping.
          if (!exit && !open.brokeR1 && process.env.BT_ZONE_GB === "1") {
            const _span = open.r1 - open.entryPx;
            if (_span > 0) {
              open.zPeak = Math.max(open.zPeak || 0, nb.high);
              if ((open.zPeak - open.entryPx) / _span >= 0.9) {
                const _gb = open.entryPx + 0.6 * (open.zPeak - open.entryPx);
                if (nb.low <= _gb) exit = { px: _gb, why: "peak_giveback" };
              }
            }
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
        // BT_COST: round-trip transaction cost as a FRACTION of notional (spread +
        // slippage + commission), charged per trade. Default 0 preserves every
        // earlier headline number. This matters because the lab otherwise gives
        // trade COUNT away for free: a change that trades 60% more looks strictly
        // better even if the extra trades barely clear the spread. 0.0005 (5bp
        // round trip) is a fair liquid-ETF assumption.
        const _cost = Number(process.env.BT_COST) || 0;
        const r = (sign * (exit.px - open.entryPx) - _cost * open.entryPx) / open.riskAbs;
        trades.push({ ...open, exitPx: exit.px, exitWhy: exit.why, exitDate: nb.timestamp.slice(0, 10), heldDays: held, r });
        if (_dayDump) {
          const _sign = open.dir === "BULLISH" ? 1 : -1;
          const _ret = (_sign * (exit.px - open.entryPx)) / open.entryPx * 100;
          console.log("DAYTRADE	" + nb.timestamp.slice(0, 10) + "	" + SYM + "	" + _ret.toFixed(4) + "	" + r.toFixed(3) + "	" + open.entryDate);
        }
        open = null;
      }
      if (open) continue;                                 // still in a trade → no new scans
    }

    // ── run the production per-ticker scan logic on the trailing window ──
    const sr = findSrZones(SYM, price, win);
    const thresholds = adaptiveRsiThresholds(closes);
    const rsiVal = rsi(closes) ?? 50;
    // BT_MEANREV (2026-08-06) — MEAN-REVERSION-FIRST entry.
    //
    // signal_audit.js split 26y of daily bars on every component the engine
    // boosts or filters on. Result: EVERY momentum/confirmation component is
    // inverted (candle confirms t=-5.3, structureShifted -4.6, rileyGate
    // -4.1, macd_hist>0 -3.9, price>SMA20 -3.8, zone_strength -3.3), and the
    // ONLY strongly informative one is RSI OVERSOLD (t=+5.4/+4.6/+4.8 across
    // horizons and both trend-flag settings).
    //
    // These are mean-reverting index ETFs; the Riley stack buys CONFIRMED
    // STRENGTH, which is the wrong side. So this mode takes the one signal that
    // measured positive and drops the stack that measured negative: enter long
    // when RSI is oversold, and skip rileyGate, the convergence verdict and the
    // trend regime filter (all three of which are built on inverted inputs).
    // Exits, stops, sizing and the zone ladder are UNCHANGED — the audit says
    // the edge lives there, so this only replaces entry selection.
    // MEANREV SET (operator decision 2026-08-06): SPY, QQQ, GLD, SMH — TLT is
    // EXCLUDED. Both timeframes independently rank it worst: daily 26y avg
    // 0.207R / PF 1.48 (half the others), 15m 29% WR with 15/21 stopped buying
    // dips inside a multi-week decline. The gate alternatives were measured and
    // rejected (knife gate halves TLT's bleed but kills QQQ's win; SMA20
    // over-filters) — removing the instrument beats handicapping the method.
    const MEANREV_SET = new Set(String(process.env.BT_MEANREV_SET || "SPY,QQQ,GLD,SMH").split(",").map((x) => x.trim().toUpperCase()));
    const _meanRev = process.env.BT_MEANREV === "1" && MEANREV_SET.has(SYM);
    let direction = scan.deriveDirection(sr, rsiVal, thresholds, { closes });
    // BT_MEANREV_SHORT (operator ask 2026-08-06): the short mirror — enter SHORT
    // on RSI overbought. Audit prior: overbought was NOISE in the BULLISH-read
    // universe (t=+0.18/-0.30); untested conditioned on a BEAR tape, which is
    // what this resolves. BT_SHORT_REGIME=1 additionally requires SPY<SMA200
    // (only short a falling market).
    if (_meanRev) {
      // BT_RSI_DEPTH (weekend research 2026-08-08): entry SELECTIVITY, in RSI
      // points below the adaptive oversold line. Connors' published ladder is
      // exactly this — RSI(2)<10 trades often, RSI(2)<5 trades less but earns
      // more per trade. This is the "raise R without raising size" knob.
      const _depth = Number(process.env.BT_RSI_DEPTH) || 0;
      // BT_IBS_MAX (research 2026-08-08): Internal Bar Strength = (close-low)/
      // (high-low) of TODAY's bar — where in its range the day closed. Published
      // results (Pagonidis 2013; QuantifiedStrategies): IBS<0.2 -> next-day
      // +0.35% avg; IBS<0.1 buy / >0.9 sell on QQQ = 0.9%/trade, 70% WR. As a
      // FILTER it requires the day to close near its low (true washout), as
      // BT_IBS_ONLY=1 it replaces the RSI signal entirely.
      const _bar = bars[i];
      const _ibs = (_bar.high - _bar.low) > 0 ? (_bar.close - _bar.low) / (_bar.high - _bar.low) : 0.5;
      const _ibsMax = Number(process.env.BT_IBS_MAX);
      const _rsiLong = rsiVal <= thresholds.oversold - _depth;
      const _ibsLong = _ibsMax > 0 ? _ibs <= _ibsMax : true;
      if (process.env.BT_IBS_ONLY === "1") direction = _ibsLong && _ibsMax > 0 ? "BULLISH" : "NEUTRAL";
      else if (process.env.BT_IBS_OR === "1") direction = (_rsiLong || (_ibsMax > 0 && _ibs <= _ibsMax)) ? "BULLISH" : "NEUTRAL";
      else direction = _rsiLong && _ibsLong ? "BULLISH"
        : (process.env.BT_MEANREV_SHORT === "1" && rsiVal >= thresholds.overbought ? "BEARISH" : "NEUTRAL");
      if (direction === "BEARISH" && process.env.BT_SHORT_REGIME === "1"
          && (regimeByDate.get(bars[i].timestamp.slice(0, 10)) || "NEUTRAL") !== "BEARISH") direction = "NEUTRAL";
    }
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
    // BT_NO_GATE (2026-08-06): rileyGate measured ANTI-PREDICTIVE. Over 31,293
    // daily bars it discards ~46% of candidates and the survivors have LOWER
    // forward returns than the pool it started from — at every horizon tested
    // (1/5/10/20 bars) and with the trend flag both on and off. See
    // experiments/entry_edge_test.js. This knob removes it so the strategy can
    // be measured with and without, rather than assuming the filter helps.
    if (!gate.actionable && process.env.BT_NO_GATE !== "1" && !_meanRev) continue;
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
    if ((!convergence || convergence.decision !== "ENTER") && !_meanRev) continue;
    enterVerdicts++;

    // regime filter (scan.js lines ~275-279, verbatim logic)
    const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, x) => s + x, 0) / 50 : null;
    if (direction === "BULLISH") {
      // price>SMA50 and macd_hist>0 both measured INVERTED (t=-3.8/-3.9), so
      // mean-reversion mode does not apply this filter.
      const trendOk = (sma50 == null || price > sma50) && macd_hist > 0;
      if (!trendOk && !_meanRev) { regimeBlocked++; continue; }
    }
    // --symmetric: apply the SAME regime gate to shorts (candidate fix — prod
    // only filters longs, which let the engine short a rising index for years)
    if (process.env.BT_SYMMETRIC === "1" && direction === "BEARISH") {
      const trendOk = (sma50 == null || price < sma50) && macd_hist < 0;
      if (!trendOk) { regimeBlocked++; continue; }
    }
    if (process.env.BT_LONG_ONLY === "1" && direction === "BEARISH") continue;

    // SUPPORT-ENTRY GATE (BT_SUP_ENTRY, validated 2026-08-05): only enter within
    // BT_SUP_ATR (0.5) ATRs of the nearest support zone's top; stop goes UNDER the
    // zone. BT_MOMO (operator 2026-08-05): when there is NO zone to lean on (or
    // price already left it), enter on IGNITION — 3 rising closes clearing the
    // prior 8-bar high with MACD positive — and exit by the validated 3xATR trail:
    // hold until the trend actually dies, no zone required.
    let _supStop = null, _momoEntry = false;
    if (process.env.BT_SUP_ENTRY === "1" && direction === "BULLISH") {
      const aNow = atr(win) || price * 0.005;
      const sup = ((sr && sr.zones) || []).filter((z) => /SUPPORT/i.test(z.type || "") && (z.top || z.level) <= price * 1.001)
        .sort((x, y) => (y.top || y.level) - (x.top || x.level))[0];
      const _cramped = !sup || (price - (sup.top || sup.level)) / aNow > (Number(process.env.BT_SUP_ATR) || 0.5);
      if (_cramped) {
        if (process.env.BT_MOMO === "1") {
          const _n = closes.length;
          const _rising = _n >= 3 && closes[_n - 1] > closes[_n - 2] && closes[_n - 2] > closes[_n - 3];
          const _prevHigh = _n >= 12 ? Math.max(...closes.slice(_n - 12, _n - 3)) : Infinity;
          if (_rising && closes[_n - 1] > _prevHigh && macd_hist > 0) _momoEntry = true;
        }
        if (!_momoEntry) continue;
        _supStop = price - 2.2 * aNow;
      } else {
        _supStop = (sup.bottom || sup.level) - 0.25 * aNow;
        if (!(_supStop > 0) || _supStop >= price * 0.999) continue;
      }
    }

    // ATR trade plan (scan.js verbatim)
    const a = atr(win);
    const dirUp = direction === "BULLISH";
    const risk = Math.max((a || 0) * 2, price * 0.015);
    let stopPx = dirUp ? price - risk : price + risk;
    const near = (lvl) => Math.abs(price - lvl) / price;
    if (dirUp && sr.support > 0 && sr.support < price && near(sr.support) >= 0.005 && near(sr.support) < 0.06) stopPx = sr.support;
    if (!dirUp && sr.resistance > price && near(sr.resistance) >= 0.005 && near(sr.resistance) < 0.06) stopPx = sr.resistance;
    let riskAbs = Math.max(Math.abs(price - stopPx), price * 0.008);
    const _provRisk = _supStop != null ? Math.max(price - _supStop, price * (Number(process.env.BT_STOP_MIN_PCT) || 0.002)) : riskAbs;
    // ROOM FILTER (BT_MIN_R1R, magnitude study): skip entries whose first
    // resistance is closer than this many R. Momo entries are exempt (no ladder).
    if (!_momoEntry && Number(process.env.BT_MIN_R1R) > 0) {
      const _res1 = ((sr && sr.zones) || []).filter((z) => /RESIST/i.test(z.type || "") && z.level > price * 1.001).sort((x, y) => x.level - y.level)[0];
      if (_res1 && (_res1.level - price) / Math.max(_provRisk, 1e-9) < Number(process.env.BT_MIN_R1R)) { regimeBlocked++; continue; }
    }
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
    let stop = dirUp ? fillPx - riskAbs : fillPx + riskAbs;
    // BT_STOP_MIN_PCT (2026-08-06) — MINIMUM STOP DISTANCE.
    //
    // The support-entry stop sits just under the zone, so on a tight zone it
    // lands INSIDE the instrument's noise band. Live 2026-08-06: SPY entered
    // with a 0.20% stop and was tagged in 29 minutes; QQQ 0.32%; four of the
    // day's stop-outs fired within ~20 minutes of entry and produced -$1,235
    // against +$475 from the two positions that survived to a zone.
    //
    // It also breaks SIZING. Risk-based sizing solves qty = risk / stopDist, so
    // a 0.20% stop asks for a $289k position to risk $576; the notional cap then
    // truncates it to $33k and the trade ends up risking $66 — 11% of intended.
    // That is why a 13-entry day moved the account 0.09%.
    //
    // Flooring riskAbs alone would only fix the arithmetic: the stop would still
    // sit where it was and still get tagged. The STOP PRICE itself has to move.
    if (_supStop != null && dirUp) {
      const _minPct = Number(process.env.BT_STOP_MIN_PCT) || 0.002;   // 0.002 = the shipped 0.2% floor
      stop = Math.min(_supStop, fillPx * (1 - _minPct));
      riskAbs = fillPx - stop;
    }
    // BT_STOP_FROM_TGT=<n> (operator design 2026-08-07) — DERIVE THE STOP FROM
    // THE TARGET. "Traders don't have a flat RR; they judge how far price can go
    // and set the stop at 1/3 of that."
    //
    // Today the stop and the target are chosen INDEPENDENTLY: the stop sits under
    // the support zone, the target is wherever R1 happens to be. So RR is an
    // accident of geometry — live 2026-08-06 produced targets of 0.53R-1.62R,
    // i.e. winners that paid LESS than the 1R they risked. Deriving the stop as
    // (distance to first resistance) / n makes RR exactly n:1 BY CONSTRUCTION and
    // makes the stop adapt to the size of the opportunity: a big expected move
    // earns a wide stop, a small one gets a tight stop or is skipped.
    //
    // The MIN floor still applies afterwards — a derived stop must not land back
    // inside the noise band.
    if (Number(process.env.BT_STOP_FROM_TGT) > 0 && dirUp && !_momoEntry) {
      const _n = Number(process.env.BT_STOP_FROM_TGT);
      const _res = ((sr && sr.zones) || []).filter((z) => /RESIST/i.test(z.type || "") && z.level > fillPx * 1.001)
        .sort((x, y) => x.level - y.level)[0];
      if (_res) {
        const _tgtDist = _res.level - fillPx;
        const _minPct = Number(process.env.BT_STOP_MIN_PCT) || 0.002;
        const _derived = fillPx - Math.max(_tgtDist / _n, fillPx * _minPct);
        if (_derived > 0 && _derived < fillPx) { stop = _derived; riskAbs = fillPx - stop; }
      }
    }
    const target = _momoEntry ? Infinity : (dirUp ? fillPx + tr * riskAbs : fillPx - tr * riskAbs);
    open = {
      dir: direction, entryIdx: i + 1, entryPx: fillPx, entryDate: bars[i + 1].timestamp.slice(0, 10),
      regime: marketStatus.market,           // market tape at entry — for the by-regime P&L split
      targetR: tr, mfeR: 0,                  // plan target (R) and max favourable excursion (R)
      momo: _momoEntry,
      trailAtr: (_momoEntry ? 3 : (Number(process.env.BT_TRAIL_ATR) > 0 ? Number(process.env.BT_TRAIL_ATR) : 0)) * (a || price * 0.005),
      peakPx: 0,
      // BT_ZONE_EXIT (operator design 2026-08-04): the two nearest RESISTANCE zones
      // above the fill form an exit ladder. r1 = first resistance (momentum usually
      // dies here), r2 = the runner target beyond it.
      ...(process.env.BT_ZONE_EXIT === "1" && !_momoEntry ? (() => {
        let res = ((sr && sr.zones) || []).filter((z) => /RESIST/i.test(z.type || "") && z.level > fillPx * 1.001)
          .sort((x, y) => x.level - y.level);
        // BT_TGT_MIN_R (operator design 2026-08-05): "what actually makes the
        // trades bigger". Measured live, the FIRST resistance above price is
        // routinely inside the noise: SMH +0.00%, QQQ +0.19%, IWM +0.20% — i.e.
        // 0.0-0.25R. Aiming the ladder there caps the trade at a scratch before
        // it is even placed, no matter how good the entry. A zone that close is
        // not a target, it IS the entry. So skip resistances nearer than
        // BT_TGT_MIN_R and aim at the first one with real separation. Nothing
        // qualifying => blue sky (no zone overhead): leave r1/r2 null so the
        // trade runs on the trail/target instead of banking a scratch.
        const _tgtMinR = Number(process.env.BT_TGT_MIN_R) || 0;
        if (_tgtMinR > 0) res = res.filter((z) => (z.level - fillPx) / Math.max(riskAbs, 1e-9) >= _tgtMinR);
        return { r1: res[0] ? res[0].level : null, r1top: res[0] ? res[0].top : null,
                 r2: res[1] ? res[1].level : null, brokeR1: false };
      })() : {}),
      stop, target, riskAbs,
      // BT_HOLD_CAP bounds the ATR-scaled horizon to the operator's 1-7 day band
      // (a month-long hold is out of scope regardless of backtest result).
      // BT_MOMO_HOLD: a momo trade used a hardcoded 60-day horizon, which
      // contradicts the cap directly above and lets ONE momo entry monopolise a
      // symbol for a quarter — measurably displacing dozens of zone trades
      // (portfolio trade count FELL 733->702 when momo was enabled, which is
      // backwards for a feature whose whole purpose is to add entries).
      holdDays: _momoEntry ? (Number(process.env.BT_MOMO_HOLD) || 60) : Math.min(
        Number(process.env.BT_HOLD_CAP) || 15,
        Math.max(1, Math.min(15, Math.round((tr * riskAbs) / ((a || price * 0.005))))) * (Number(process.env.BT_HOLD_MULT) || 1)
      ),
      p_win: convergence ? convergence.p_win : null, conf: gate.confidence, quality: gate.quality,
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
        mae_winners_p50: (() => { const w = trades.filter((t) => t.r > 0).map((t) => t.maeR || 0).sort((x, y) => x - y); return w.length ? +w[Math.floor(0.5 * (w.length - 1))].toFixed(2) : null; })(),
        avg_win_R: (() => { const w = trades.filter((t) => t.r > 0); return w.length ? +(w.reduce((x, t) => x + t.r, 0) / w.length).toFixed(2) : null; })(),
        avg_loss_R: (() => { const l = trades.filter((t) => t.r <= 0); return l.length ? +(l.reduce((x, t) => x + t.r, 0) / l.length).toFixed(2) : null; })(),
      };
    })(),
    by_regime: ["BULLISH","BEARISH","NEUTRAL"].reduce((acc,g)=>{const t=trades.filter(x=>x.regime===g);if(t.length){const w=t.filter(x=>x.r>0).length;const tot=t.reduce((a,x)=>a+x.r,0);acc[g]={n:t.length,win_pct:+(w/t.length*100).toFixed(1),total_R:+tot.toFixed(1),avg_R:+(tot/t.length).toFixed(3)};}return acc;},{}),
    trades: n,
    win_rate_pct: n ? +(100 * wins.length / n).toFixed(1) : null,
    profit_factor: n ? +pf.toFixed(2) : null,
    total_R: +sumR.toFixed(1),
    // PERCENT CAPTURED PER TRADE — the metric that maps to P&L. avg_R is
    // NORMALISED BY STOP WIDTH, so a tight-stop config can post a higher avg_R
    // while capturing far fewer dollars at the same position size. Ranking
    // configs by avg_R nearly led us to reject a wider stop floor that is 2.5x
    // better in dollars. Dollars/trade = position x avg_ret_pct.
    avg_ret_pct: +(trades.reduce((a, t) => a + ((t.exitPx - t.entryPx) / t.entryPx) * (t.dir === "BULLISH" ? 1 : -1) * 100, 0) / Math.max(1, trades.length)).toFixed(4),
    total_ret_pct: +trades.reduce((a, t) => a + ((t.exitPx - t.entryPx) / t.entryPx) * (t.dir === "BULLISH" ? 1 : -1) * 100, 0).toFixed(2),
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
