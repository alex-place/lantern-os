/**
 * signal-engine/scan.js — deterministic market scan (Node port of the "Riley"
 * technical path from src/trading_agents/agents.py).
 *
 * This replaces the Python `scan_all`/`scan_ticker` for the trader UI. It uses
 * ONLY deterministic technical analysis (SR zones, RSI, candle patterns, market
 * structure, tesseract) fed by keyless Yahoo bars — no Grok/Claude LLM calls.
 * Autonomous buy/sell *decisioning* is layered on top by the Σ₀ convergence
 * council (see lib/sigma0-trader-council.js), per ADR — this module just Observes.
 *
 * Output contract matches what cli.py's action_scan_market returned, so
 * /api/trading/zones and stock-trader.html keep working unchanged:
 *   { signals:[...], zones:{TICKER:{mid,top,bottom,type,strength,touches,triggered_entry}},
 *     logs:[{time,agent,body,symbol}], timestamp, watchlist_count, signals_count }
 */
"use strict";

const yahoo = require("../market-data-yahoo");
const { rsi, adaptiveRsiThresholds, macd, priceVsSma, volumeRatio, atr } = require("./indicators");
const sectors = require("./sectors");
const { findSrZones } = require("./sr-zones");
const { detectCandlePatterns } = require("./candles");
const { checkMarketStructureShift } = require("./market-structure");
const tesseract = require("./tesseract");
const ev = require("./convergence-ev");
const { targetR } = require("./profiles");
const tradingNews = require("../trading-news"); // directional news sentiment (external anchor)

// Derive a candidate trade direction from zone posture, falling back to RSI
// mean-reversion. (In the Python flow Grok proposed the direction; here it's
// deterministic: support → look long, resistance → look short.)
// TREND OVERRIDE (opt-in, ZONE_TREND_DIR=1 / opts.trendDir).
//
// The zone rules below are pure MEAN-REVERSION: nearest zone is resistance ->
// BEARISH. In an UPTREND price sits near its highs by definition, so the nearest
// zone is essentially always resistance and the read is permanently BEARISH —
// on exactly the instruments that are going up. Measured 2026-08-05: GLD read
// BEARISH on all 49 intraday bars while climbing +2.0%, and a 2,338-sample
// forward-return test found BULLISH reads followed by -0.003% vs BEARISH by
// +0.009%/+0.029% — i.e. the primitive was mildly INVERTED, not merely noisy.
//
// This does not delete the mean-reversion read; it declines to call a rising
// market bearish purely because there is overhead resistance. In a confirmed
// uptrend, resistance above is a TARGET, not a short signal.
function _isUptrend(closes) {
  if (!Array.isArray(closes) || closes.length < 50) return false;
  const sma = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const px = closes[closes.length - 1];
  const s20 = sma(20), s50 = sma(50);
  return px > s20 && s20 > s50;          // price above a rising short MA stack
}

/**
 * May a signal be emitted for this gate result? Normally "only if rileyGate
 * approved"; with RILEY_GATE=0 the gate is computed but no longer vetoes.
 * Split out so the decision is testable without driving a full network scan.
 */
function gateAllows(gate, opts = {}) {
  if ((opts.rileyGate ?? process.env.RILEY_GATE) === '0') return true;
  return !!(gate && gate.actionable);
}

// IBS — Internal Bar Strength: where price sits in the session's range,
// (last - low) / (high - low) over the bars of the most recent session date.
// Null when the range is degenerate or bars are missing (fail-soft: no signal).
function sessionIbs(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const last = bars[bars.length - 1];
  const day = String(last.timestamp || "").slice(0, 10);
  if (!day) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (String(b.timestamp || "").slice(0, 10) !== day) continue;
    const h = Number(b.high), l = Number(b.low);
    if (Number.isFinite(h)) hi = Math.max(hi, h);
    if (Number.isFinite(l)) lo = Math.min(lo, l);
  }
  const px = Number(last.close);
  if (!Number.isFinite(px) || !(hi > lo)) return null;
  return (px - lo) / (hi - lo);
}

function deriveDirection(sr, rsiVal, thresholds, opts = {}) {
  // IBS ENTRY (research 2026-08-08, weighed on ALL factors — per-trade, win
  // rate, volume, total income). OOS 2015-26 across SPY/QQQ/GLD/SMH at the
  // live 5% floor + 3:1 config: IBS<0.15 ALONE captures 658% total vs the RSI
  // baseline's 297% (+0.741%/trade vs +0.559, WR 61.0 vs 55.7, 888 vs 531
  // trades), and RSI∪IBS adds no total beyond IBS alone — IBS subsumes the RSI
  // edge. Matches published results (Pagonidis 2013; QQQ 0.9%/trade, 70% WR).
  //   TRADER_IBS_MODE=only  IBS is THE long entry signal (lab-validated winner)
  //   TRADER_IBS_MODE=or    IBS adds entries on top of the zone/RSI logic
  //   unset/off             no behavior change
  const _ibsMax = Number(process.env.TRADER_IBS_MAX) || 0.15;
  // MORNING DEPTH (pilot 2026-08-15, 23 sessions, DEFAULT OFF pending the
  // two-window bar): first-touch IBS fires 0.4-2.3% above the coming low in
  // morning drift, while genuine 09:45-09:55 washout bounces are DEEP by
  // nature. Requiring IBS <= TRADER_IBS_MAX_MORNING before 11:00 ET doubled
  // pilot income (+23.4% vs +11.0% total, n 260 vs 273) and still caught the
  // 8/10 SLV +3.28%/GLD +1.64% fast-path winners at 09:45. Unset = off.
  const _mMax = Number(process.env.TRADER_IBS_MAX_MORNING);
  const _etm = (opts.etMin != null) ? opts.etMin : (() => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); return d.getHours() * 60 + d.getMinutes(); })();
  const _ibsMaxEff = (_mMax > 0 && _etm < 660) ? _mMax : _ibsMax;
  const _ibsMode = String(process.env.TRADER_IBS_MODE || "off");
  if (_ibsMode === "only") {
    const v = opts.ibs;
    return (v != null && v <= _ibsMaxEff) ? "BULLISH" : "NEUTRAL";
  }
  if (_ibsMode === "or" && opts.ibs != null && opts.ibs <= _ibsMaxEff) return "BULLISH";
  const trendDir = opts.trendDir ?? (process.env.ZONE_TREND_DIR === "1");
  const up = trendDir && _isUptrend(opts.closes);
  if (sr.in_zone) {
    if (sr.zone_type === "SUPPORT") return "BULLISH";
    // In an uptrend, trading INSIDE a resistance zone is the breakout, not the
    // rejection — the zone is being consumed. Overbought still vetoes the chase.
    if (sr.zone_type === "RESISTANCE") return up && rsiVal < thresholds.overbought ? "BULLISH" : "BEARISH";
  }
  const nz = sr.nearest_zone || {};
  if (nz.type === "SUPPORT") return "BULLISH";
  if (nz.type === "RESISTANCE") return up && rsiVal < thresholds.overbought ? "BULLISH" : "BEARISH";
  if (rsiVal <= thresholds.oversold) return "BULLISH";
  if (rsiVal >= thresholds.overbought) return "BEARISH";
  return "NEUTRAL";
}

/**
 * POLARITY (#3295 root cause). Every market-semantic signal above is computed on
 * the symbol's OWN bars — correct for a 1x instrument, inverted for a -3x
 * wrapper, whose intraday bars mirror its underlying. Measured at the fire
 * moments (47 fires, 22 sessions): when an inverse wrapper's session IBS read
 * "washed out", the UNDERLYING sat at median IBS 0.90 — its session HIGH — 94%
 * in the top third, 0% actually washed out. And the stronger the underlying's
 * session, the more certain the wrapper "washout" existed (93% of up>0.3%
 * sessions vs 36% otherwise). So the polarity-blind signal silently converted
 * "buy the market's dip" into "short the market at its session high", firing
 * hardest on the strongest up-days: an anti-trend accumulation machine nobody
 * designed. Outcome over 2010-2026: −268R across 2,493 wrapper entries, negative
 * under every causal condition (gap, 5d, SMA-200 regime), while the same signal
 * on 1x instruments is +825R and positive under all of them.
 *
 * The rule: a BULLISH verdict on a negative-sign instrument is an ECONOMIC
 * SHORT, so it must state its thesis on the true instrument — the underlying at
 * its session TOP (IBS ≥ 1−max), not the wrapper at its bottom — and short
 * entries are only tradable at all behind TRADER_SHORT_EDGE=1, because no
 * measured short edge exists. BEARISH verdicts pass through untouched: they
 * feed the EXIT path, and a held wrapper must remain exitable.
 *
 * This is the entry-side twin of the lab lesson already in
 * spy_engine_backtest.js ("regime from SQQQ's own SMA-200 inverts the gate"),
 * and it is written against direction-lock's sign map so any future instrument
 * with a sign — new inverse products, short futures (#3218) — inherits it.
 */
// Same ledger the engine writes (TRADER_TRADES_LOG override honored, so tests
// never touch production). Own writer rather than requiring auto-trader, which
// would create a scan<->auto-trader require cycle.
const _VETO_LOG = process.env.TRADER_TRADES_LOG
  ? require("path").resolve(process.env.TRADER_TRADES_LOG)
  : require("path").join(__dirname, "..", "..", "..", "..", "data", "lantern-garage", "trading", "autopilot-trades.jsonl");
function _logVeto(rec) {
  try {
    const fs = require("fs"), path = require("path");
    fs.mkdirSync(path.dirname(_VETO_LOG), { recursive: true });
    fs.appendFileSync(_VETO_LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch (_e) { /* never break the scan */ }
}

/**
 * SPY TAPE CONTEXT at this instant, from SPY's own 15m session bars — the
 * causal inputs (#3343). Everything here is knowable at the fire; nothing
 * peeks at the close. Returned nulls mean "unreadable", never "zero".
 *   tape    SPY % from today's session open
 *   mom30   SPY % over the last two 15m bars (~30 min)
 *   ll      SPY made a lower low: last 2 bars' low < prior 2 bars' low
 */
// The wrapper's OWN drawdown from its session open, in % (negative = it fell).
// A selection feature (#3349): wrapper washouts that arrive after a SHALLOW
// fall (> -1.5%) won 67%; after a hard fall (<= -2%) they won 33%. Same
// session-window discipline as sessionIbs — today's bars only.
function sessionDrawdownPct(bars15) {
  const bars = Array.isArray(bars15) ? bars15 : [];
  if (!bars.length) return null;
  const day = String(bars[bars.length - 1].timestamp || "").slice(0, 10);
  const s = bars.filter((b) => String(b.timestamp || "").slice(0, 10) === day && Number(b.close) > 0);
  if (s.length < 2) return null;
  const open = Number(s[0].open) || Number(s[0].close);
  const last = Number(s[s.length - 1].close);
  return open > 0 ? ((last - open) / open) * 100 : null;
}

// ET minute-of-day for the LAST bar (the fire instant), not the wall clock —
// so a replay/test drives it and a live scan reads it identically.
function barEtMinute(bars15) {
  const bars = Array.isArray(bars15) ? bars15 : [];
  if (!bars.length) return null;
  const ts = bars[bars.length - 1].timestamp;
  if (!ts) return null;
  const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return d.getHours() * 60 + d.getMinutes();
}

function spyTapeContext(spyBars15) {
  const bars = Array.isArray(spyBars15) ? spyBars15 : [];
  if (!bars.length) return { tape: null, mom30: null, ll: null };
  const day = String(bars[bars.length - 1].timestamp || "").slice(0, 10);
  const s = bars.filter((b) => String(b.timestamp || "").slice(0, 10) === day && Number(b.close) > 0);
  if (s.length < 2) return { tape: null, mom30: null, ll: null };
  const open = Number(s[0].open) || Number(s[0].close);
  const last = Number(s[s.length - 1].close);
  const tape = open > 0 ? ((last - open) / open) * 100 : null;
  const back = s[Math.max(0, s.length - 3)];
  const mom30 = Number(back.close) > 0 ? ((last - Number(back.close)) / Number(back.close)) * 100 : null;
  const n = s.length;
  const ll = n >= 4
    ? Math.min(Number(s[n - 1].low), Number(s[n - 2].low)) < Math.min(Number(s[n - 3].low), Number(s[n - 4].low))
    : null;
  return { tape, mom30, ll };
}

/**
 * POLARITY (#3296) — a BULLISH verdict on a negative-sign instrument is an
 * ECONOMIC SHORT and is judged as one. #3343 makes the veto CONDITIONAL:
 *
 *   TRADER_SHORT_EDGE=0        never (the #3296 default — measured -268R
 *                              unconditional over 16y, #3295)
 *   TRADER_SHORT_EDGE=falling  allow while SPY is FALLING at the fire —
 *                              tape <= -TRADER_SHORT_TAPE_PCT (default 0.3)
 *                              OR mom30 <= -TRADER_SHORT_MOM_PCT (default 0.15).
 *                              Pilot (18 sessions, causal only): SPY-falling
 *                              fires +3.92%/100% (n=3) vs SPY-rising -0.20%
 *                              (n=26) and SPY-up>0.3% -1.17% (n=19).
 *   TRADER_SHORT_EDGE=1        allow whenever the underlying is at its top
 *                              (the original explicit-short thesis)
 *
 * The operator's objection that forced this: a veto blocking 100% of inverse
 * entries "pretty much removed inverses from the watchlist with extra steps".
 * On 2026-08-17 (SPY grind -0.45%, low at 15:55) the only two winners the tape
 * offered were SOXS +2.90% and SQQQ +1.80% — both vetoed. A blanket ban was
 * over-applying evidence that said "unconditional wrappers lose", not "every
 * wrapper entry loses".
 *
 * Every vetoed fire is logged as `polarity_veto` with the full causal context
 * (tape, mom30, ll, uIbs), so live data accumulates the counterfactual on
 * exactly the conditions the lab is judging.
 */
function applyPolarity(sym, direction, opts = {}) {
  if (direction !== "BULLISH") return { direction, veto: null };
  const { family, sign } = require("../direction-lock").instrumentSign(sym);
  if (sign >= 0) return { direction, veto: null };
  const ibsMax = Number(opts.ibsMax ?? (Number(process.env.TRADER_IBS_MAX) || 0.15));
  const mode = String(opts.shortEdge ?? process.env.TRADER_SHORT_EDGE ?? "0").toLowerCase();
  const ctx = opts.spy || { tape: null, mom30: null, ll: null };
  const ctxStr = `spy tape ${ctx.tape == null ? "?" : ctx.tape.toFixed(2) + "%"}, mom30 ${ctx.mom30 == null ? "?" : ctx.mom30.toFixed(2) + "%"}, ll ${ctx.ll == null ? "?" : ctx.ll}`;
  if (mode === "0" || mode === "" || mode === "false") {
    return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — short entries disabled (TRADER_SHORT_EDGE=0; ${ctxStr})` };
  }
  if (mode === "selective") {
    // #3349 — SELECTION, not a tape veto. Decomposing 49 wrapper IBS fires (24
    // sessions, causal) by pre-fire features, three separated winners from
    // losers, and none of them is "SPY falling":
    //   fire minute        r=+0.44   10-11am 47%/-0.36%  ->  after 1pm 67%/+2.46%
    //   wrapper drawdown   r=+0.14   fell <=-2%: 33%/-0.81%  ->  fell >-1%: 67%/+1.23%
    //   underlying tape    r=-0.21   up >=+0.5%: 48%/-0.50%  ->  up 0-0.5%: 56%/+0.77%
    // Composite (after 11:00 AND wrapper DD > -1.5% AND underlying < +0.5%):
    // n=13, 62% WR, +1.70% avg (+0.60% leave-one-day-out) vs the 36 that fail it
    // at 47%/-0.36%. The bet the wrapper washout makes is "the underlying
    // reverses within the hour" — these are the conditions under which it does.
    // 16y daily replication agrees on DIRECTION (mild tape is the best bucket)
    // but cannot see time-of-day; the sample is 13. Every fire — allowed or
    // vetoed — is logged with all three values so live data settles it.
    const minMin = Number(process.env.TRADER_SHORT_MIN_ET_MIN) || 660;      // 11:00 ET
    const maxDD = -(Number(process.env.TRADER_SHORT_MAX_DD_PCT) || 1.5);   // wrapper fell no more than this
    const maxUTape = Number(process.env.TRADER_SHORT_MAX_UTAPE_PCT) || 0.5; // underlying not ripping
    const w = opts.wrapperDD, ut = opts.underlyingTape, m = opts.etMin;
    const selStr = `et ${m == null ? "?" : Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0")}, wrapperDD ${w == null ? "?" : w.toFixed(2) + "%"}, underlying tape ${ut == null ? "?" : ut.toFixed(2) + "%"}`;
    if (m == null || w == null || ut == null) {
      return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — selection inputs unreadable (${selStr}); cannot certify` };
    }
    // TIME IS A WEIGHT, NOT A FLOOR (#3356). As a hard floor this was a ban
    // wearing a filter's clothes: measured over 25 sessions and 8 wrappers,
    // 72.2% of FIRST fires per symbol/session land in 09:30-10:00 and only 14.6%
    // at or after 11:00 — so the floor refused ~85% of every actionable wrapper
    // setup, on an n=13 composite. A gate that strict cannot even accumulate the
    // evidence needed to judge it: at roughly one reachable fire every two
    // sessions it would take months to reach a decidable sample. Two live
    // sessions produced 23 wrapper fires and ZERO decisions.
    //
    // The measured effect is on WIN RATE, so express it there. First-fire
    // outcomes by hour: 10:00-11:00 47%/-0.36% (n=30), 11:00-13:00 54%/+0.42%
    // (n=13), 13:00+ 67%/+2.46% (n=6). A p_win penalty of that size IS the
    // calibration, not a fudge — and unlike the floor it lets a strong early
    // setup clear on its other merits while still pricing the hour.
    //
    // The two SETUP checks stay hard: they describe the trade (a wrapper that
    // already collapsed, an underlying still ripping) rather than the clock.
    const fails = [];
    if (w <= maxDD) fails.push(`wrapper already fell ${w.toFixed(2)}% (hard-fall fires 33%/-0.81%)`);
    if (ut >= maxUTape) fails.push(`underlying ripping ${ut.toFixed(2)}% (rally fires 48%/-0.50%)`);
    if (fails.length) {
      return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — selection failed: ${fails.join("; ")} [${selStr}] (#3349)` };
    }
    // Graded by how far before the old floor the fire lands. Defaults sit at the
    // conservative end of the measured gap (47% early vs 54-67% late = 7-20pp).
    const _earlyPp = Number(process.env.TRADER_SHORT_EARLY_PENALTY_PP);
    const _midPp = Number(process.env.TRADER_SHORT_MID_PENALTY_PP);
    const earlyPp = Number.isFinite(_earlyPp) ? _earlyPp : 7;   // before 10:00
    const midPp = Number.isFinite(_midPp) ? _midPp : 4;         // 10:00 -> the old floor
    let timePenaltyPp = 0;
    if (m < 600) timePenaltyPp = earlyPp;
    else if (m < minMin) timePenaltyPp = midPp;
    const when = timePenaltyPp > 0
      ? `early (-${timePenaltyPp}pp p_win, was a hard block before #3356)`
      : 'late';
    return { direction, ctx, veto: null, timePenaltyPp, allowed: `selective: ${when} + shallow + mild (${selStr})` };
  }
  if (mode === "falling") {
    const tapePct = Number(process.env.TRADER_SHORT_TAPE_PCT) || 0.3;
    const momPct = Number(process.env.TRADER_SHORT_MOM_PCT) || 0.15;
    if (ctx.tape == null && ctx.mom30 == null) {
      return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — SPY tape unreadable, cannot certify a falling market` };
    }
    const falling = (ctx.tape != null && ctx.tape <= -tapePct) || (ctx.mom30 != null && ctx.mom30 <= -momPct);
    if (!falling) {
      return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — SPY not falling at the fire (${ctxStr}); shorts into a flat/rising tape measured -1.17% (#3343)` };
    }
    return { direction, ctx, veto: null, allowed: `falling tape (${ctxStr})` };
  }
  // mode "1": the explicit-short thesis — underlying at its session top
  const u = opts.underlyingIbs;
  if (u == null) {
    return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — underlying unreadable, no thesis to state` };
  }
  if (u < 1 - ibsMax) {
    return { direction: "NEUTRAL", ctx, veto: `economic short on ${family} via ${sym} — underlying mid-range (IBS ${u.toFixed(2)}); a wrapper washout is not a market washout` };
  }
  return { direction, ctx, veto: null, allowed: `underlying at session top (IBS ${u.toFixed(2)})` };
}

// Deterministic composite gate — ported from agents.py `riley_strategy_gate`
// (proximity gate → context-aware RSI adjustment → structure/candle/touch
// boosts → total_score → PERFECT/GOOD/WAIT/NO). Returns a 0..100 confidence.
function rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending }) {
  const reasons = [];
  let boost = 0;

  const nearest = sr.nearest_zone || {};
  const tier = nearest.recency || "older";
  let proximityLimit =
    { today: 3.0, weekly: 3.0, recent: 2.0, older: 1.5, structural: 2.5 }[tier] || 2.0;
  if ((sr.zone_strength || 0) >= 70) proximityLimit += 0.5;

  if (!sr.in_zone && (sr.dist_to_nearest ?? 99) > proximityLimit) {
    return {
      approved: false,
      quality: "NO",
      confidence: 0,
      boost: 0,
      reason: `not near a zone (nearest ${Number(sr.dist_to_nearest || 0).toFixed(1)}% > ${proximityLimit.toFixed(1)}%)`,
      actionable: false,
    };
  }

  // Context-aware RSI adjustment (weights differ trending vs ranging).
  const wConfirm = trending ? 5 : 15;
  const wNeutral = trending ? 0 : -5;
  const wOppose = trending ? -5 : -20;
  let rsiAdj = 0;
  const r = Math.round(rsiVal);
  if (sr.in_zone && direction === "BEARISH" && sr.zone_type === "SUPPORT") {
    if (rsiVal >= thresholds.overbought) { rsiAdj = wConfirm; reasons.push(`RSI ${r} overbought@support — short confirm`); }
    else if (rsiVal < 40) { rsiAdj = -20; reasons.push(`RSI ${r} oversold@support — risky short`); }
    else { rsiAdj = wNeutral; reasons.push(`RSI ${r}@support`); }
    if (rsiVal > 80) rsiAdj += 10;
  } else if (sr.in_zone && direction === "BULLISH" && sr.zone_type === "RESISTANCE") {
    if (rsiVal <= thresholds.oversold) { rsiAdj = wConfirm; reasons.push(`RSI ${r} oversold@resistance — long confirm`); }
    else if (rsiVal >= thresholds.overbought) { rsiAdj = wOppose; reasons.push(`RSI ${r} overbought@resistance — risky long`); }
    else { rsiAdj = wNeutral; reasons.push(`RSI ${r}@resistance`); }
    if (rsiVal < 20) rsiAdj += 10;
  }
  boost += rsiAdj;

  // Structure confidence base, boosted by a confirming candle (str≥65 → +30%).
  let structConf = struct.strength || 0;
  if (candle.pattern && candle.confirms && candle.strength >= 65) {
    structConf = Math.min(100, structConf + Math.trunc(candle.strength * 0.3));
  }

  if (sr.in_zone) { boost += 8; reasons.push(`in ${sr.zone_type} zone (str ${sr.zone_strength})`); }
  const touches = nearest.touches || sr.touches || 0;
  if (touches >= 3) { boost += 5; reasons.push(`${touches} touches`); }
  else if (touches >= 2) { boost += 3; reasons.push("2 touches"); }
  if (struct.structureShifted) { boost += 15; reasons.push(`structure shift (${struct.shiftType})`); }
  if (struct.exhaustive) { boost += 5; reasons.push("exhaustive move"); }
  if (candle.pattern && candle.confirms) { boost += 4; reasons.push(`entry candle (${candle.pattern})`); }

  const totalScore = structConf + (sr.zone_strength || 0) / 2;
  let quality = "NO";
  let approved = false;
  if (totalScore >= 80 && sr.in_zone) { quality = "PERFECT"; approved = true; }
  else if (totalScore >= 55 && (sr.in_zone || (sr.dist_to_nearest ?? 99) < 1.0)) { quality = "GOOD"; approved = true; }
  else if (totalScore >= 35) { quality = "WAIT"; }

  const confidence = Math.max(0, Math.min(100, Math.round(totalScore + boost)));
  return {
    approved,
    quality,
    confidence,
    boost,
    reason: reasons.join(" | ") || "no valid setup",
    actionable: quality !== "NO" && direction !== "NEUTRAL",
  };
}

// Map a confirming candle's strength to an A/B/C grade for the EV layer.
function candleGrade(candle) {
  if (!candle || !candle.pattern || !candle.confirms) return "C";
  if (candle.strength >= 85) return "A";
  if (candle.strength >= 70) return "B";
  return "C";
}

// Σ₀ EV verdict for a signal — the deterministic ENTER/SKIP + Kelly-style sizing
// that replaced the Python Grok/Claude entry loop. Pure over the computed TA plus
// (optionally) real news sentiment; the grok/claude council inputs stay neutral.
// `news_sentiment` ∈ [-1,1] is an EXTERNAL anchor (Σ₀): the EV layer signs it to
// the direction and weights it lightly (WEIGHTS.news), so one headline can nudge
// but never dominate the TA evidence.
function convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment = 0, volume_ratio, macd_hist, ma_signal, earnings_surprise, sector_trend }) {
  // ECONOMIC direction for MARKET-semantic evidence (#3298 findings 1-2).
  // "SOXS BULLISH" is an economic SHORT. Two inputs compare against the MARKET
  // and were scored in wrapper space — inverted for every signed instrument:
  //   - regime alignment: a wrapper long in a BULLISH market scored as ALIGNED
  //     (it is opposed) — on 2026-08-13 this upweighted p_win for shorts taken
  //     INTO the rally, one sized tier A+;
  //   - news: bullish-underlying news supported a wrapper long (it argues
  //     against it). Flipping the SIGN of news for sign<0 instruments makes the
  //     EV layer's "signed to the direction" arithmetic come out economic.
  // Price-space evidence (zones, candles, structure, MACD on own bars) is
  // CORRECT in wrapper space and stays untouched. Unreachable for entries while
  // #3296 vetoes wrapper longs — this is the layer that would mis-score them
  // the day TRADER_SHORT_EDGE ever opens.
  const _sign = require("../direction-lock").instrumentSign(t).sign;
  const _ecoDir = _sign < 0
    ? (direction === "BULLISH" ? "BEARISH" : direction === "BEARISH" ? "BULLISH" : direction)
    : direction;
  const evInput = {
    direction,
    news_sentiment: _sign < 0 ? -news_sentiment : news_sentiment,
    volume_ratio,          // Tier-1: volume-spike confirmation
    macd_hist,             // Tier-1: MACD histogram (momentum)
    ma_signal,             // Tier-1: price vs MA (momentum)
    earnings_surprise,     // Tier-2: last EPS surprise vs consensus (signed %)
    sector_trend,          // Tier-2: sector ETF trend (signed fraction)
    in_zone: sr.in_zone,
    zone_strength: sr.zone_strength,
    zone_touches: (sr.nearest_zone && sr.nearest_zone.touches) || sr.touches || 0,
    structure_shifted: struct.structureShifted,
    structure_conf: struct.strength,
    pattern_grade: candleGrade(candle),
    trend_aligned:
      (_ecoDir === "BULLISH" && marketStatus.market === "BULLISH") ||
      (_ecoDir === "BEARISH" && marketStatus.market === "BEARISH"),
    trend_conflicts:
      (_ecoDir === "BULLISH" && marketStatus.market === "BEARISH") ||
      (_ecoDir === "BEARISH" && marketStatus.market === "BULLISH"),
    target_r: targetR(t),
  };
  try {
    const c = ev.scoreConvergence(evInput);
    return {
      decision: c.decision,
      p_win: c.p_win,
      ev_r: c.ev_r,
      target_r: c.target_r,
      size_mult: ev.edgeRiskMultiplier(c.p_win, c.target_r),
        // Retained so the analyst pass (#3355) can RE-SCORE this exact input with
        // claude_conf set, rather than re-deriving it. Stripped before the signal
        // leaves scanAll, so the API payload is unchanged.
        _ev: evInput,
        _sign,
    };
  } catch (_e) {
    return null;
  }
}

// Per-ticker zones (for /api/trading/zones single-ticker style reads).
async function getZones(ticker) {
  const q = (await yahoo.getQuotes([ticker]))[0] || { price: 0 };
  const b = (await yahoo.getBars(ticker, "15m")).bars || [];
  const sr = findSrZones(ticker, q.price, b);
  return {
    ticker,
    support: sr.support,
    resistance: sr.resistance,
    mid: sr.mid,
    type: sr.type,
    strength: sr.strength,
    touches: sr.touches,
    trend: sr.trend,
    volatility: sr.volatility,
    zones: sr.zones,
    available: b.length >= 10,
  };
}

// Full watchlist scan → { signals, zones, logs, ... } (the scanMarket contract).
async function scanAll(watchlist) {
  const list = Array.isArray(watchlist) ? watchlist : [];
  const nowIso = new Date().toISOString();

  const marketStatus = await yahoo.getMarketStatus().catch(() => ({}));
  const trending = marketStatus.market === "BULLISH" || marketStatus.market === "BEARISH";
  const quotes = await yahoo.getQuotes(list).catch(() => []);
  const priceOf = {};
  for (const q of quotes) priceOf[q.ticker] = q.price;
  const bars15 = ((await yahoo.getBarsMulti(list, "15m").catch(() => ({ bars: {} }))).bars) || {};
  const bars1h = ((await yahoo.getBarsMulti(list, "1h").catch(() => ({ bars: {} }))).bars) || {};

  // Tier-2 sector strength: fetch each needed sector ETF's daily bars ONCE and
  // compute its trend, then look up per ticker (many tickers share a sector).
  const sectorMom = {}; // etf -> signed momentum fraction
  try {
    const etfs = sectors.etfsFor(list);
    if (etfs.length) {
      const etfBars = ((await yahoo.getBarsMulti(etfs, "1d").catch(() => ({ bars: {} }))).bars) || {};
      for (const e of etfs) sectorMom[e] = sectors.sectorMomentum((etfBars[e] && etfBars[e].bars) || []);
    }
  } catch (_e) { /* fail-soft: sector signal stays neutral */ }

  const signals = [];
  const zones = {};
  const logs = [];

  for (const t of list) {
    const price = priceOf[t] || 0;
    const b15 = (bars15[t] && bars15[t].bars) || [];
    const b1h = (bars1h[t] && bars1h[t].bars) || [];
    if (!price || b15.length < 10) {
      logs.push({ time: nowIso, agent: "RILEY", symbol: t, body: `${t} — insufficient data (price ${price}, ${b15.length} bars)` });
      continue;
    }

    const sr = findSrZones(t, price, b15);
    const thresholds = adaptiveRsiThresholds(b1h.map((b) => b.close));
    const _closes15 = b15.map((b) => b.close);
    const rsiVal = rsi(_closes15) ?? 50;
    // closes feed the ZONE_TREND_DIR override — without them the trend can't be
    // judged and deriveDirection silently falls back to pure mean-reversion.
    let direction = deriveDirection(sr, rsiVal, thresholds, { closes: _closes15, ibs: sessionIbs(b15) });
    // Polarity: a BULLISH verdict on a negative-sign wrapper is an economic
    // short and must be judged on the UNDERLYING's bars (see applyPolarity).
      // Declared OUTSIDE the polarity block: the scoring site below consumes it.
      let _timePenaltyPp = 0;
    {
      const _proxy = require("../direction-lock").underlyingProxy(t);
      const _uBars = _proxy && _proxy !== t && bars15[_proxy] ? (bars15[_proxy].bars || []) : null;
      const _uIbs = _uBars ? sessionIbs(_uBars) : null;
      const _spyCtx = spyTapeContext(bars15.SPY && bars15.SPY.bars);
      // #3349 selection features — computed for EVERY wrapper fire so the
      // ledger grows the table whether the mode allows or vetoes.
      const _wDD = sessionDrawdownPct(b15);
      const _uTape = _uBars ? sessionDrawdownPct(_uBars) : null;
      const _etMin = barEtMinute(b15);
      const _pol = applyPolarity(t, direction, { underlyingIbs: _uIbs, spy: _spyCtx, wrapperDD: _wDD, underlyingTape: _uTape, etMin: _etMin });
      if (_pol.veto) {
        logs.push({ time: nowIso, agent: "sigma0", symbol: t, body: `${t} — ${_pol.veto}` });
        // INSTRUMENT THE COUNTERFACTUAL (#3343). A vetoed fire is a trade the
        // engine chose not to take; the ledger must know it existed, with the
        // exact causal context the conditional is judged on, so the live table
        // ("shorts into a falling tape: +3.92%, into a rising tape: -0.20%") keeps
        // growing on real data. Fire-and-forget through the trade ledger's own
        // writer so it lives beside entries and exits, not in a side file.
        try {
          _logVeto({
            event: "polarity_veto", symbol: t, price: Number(price) || null,
            wrapper_ibs: (() => { const v = sessionIbs(b15); return v == null ? null : +v.toFixed(3); })(),
            underlying: _proxy || null, underlying_ibs: _uIbs == null ? null : +_uIbs.toFixed(3),
            spy_tape: _spyCtx.tape == null ? null : +_spyCtx.tape.toFixed(3),
            spy_mom30: _spyCtx.mom30 == null ? null : +_spyCtx.mom30.toFixed(3),
            spy_lower_low: _spyCtx.ll,
            // #3349 selection features
            wrapper_dd: _wDD == null ? null : +_wDD.toFixed(3),
            underlying_tape: _uTape == null ? null : +_uTape.toFixed(3),
            et_min: _etMin,
            mode: String(process.env.TRADER_SHORT_EDGE || "0"),
          });
        } catch (_e) { /* instrumentation must never break the scan */ }
      } else if (_pol.allowed) {
        logs.push({ time: nowIso, agent: "sigma0", symbol: t, body: `${t} — economic short ALLOWED: ${_pol.allowed}` });
        // The ALLOWED side must be recorded too, or the live table only ever
        // sees the fires the mode refused — half a counterfactual is none.
        try {
          _logVeto({
            event: "polarity_allow", symbol: t, price: Number(price) || null,
            wrapper_ibs: (() => { const v = sessionIbs(b15); return v == null ? null : +v.toFixed(3); })(),
            underlying: _proxy || null, underlying_ibs: _uIbs == null ? null : +_uIbs.toFixed(3),
            spy_tape: _spyCtx.tape == null ? null : +_spyCtx.tape.toFixed(3),
            spy_mom30: _spyCtx.mom30 == null ? null : +_spyCtx.mom30.toFixed(3),
            spy_lower_low: _spyCtx.ll,
            wrapper_dd: _wDD == null ? null : +_wDD.toFixed(3),
            underlying_tape: _uTape == null ? null : +_uTape.toFixed(3),
            et_min: _etMin,
            mode: String(process.env.TRADER_SHORT_EDGE || "0"),
          });
        } catch (_e) { /* instrumentation must never break the scan */ }
      }
      direction = _pol.direction;
      // #3356: carry the time penalty out of the polarity check so the scoring
      // below can price it. Zero for 1x instruments and for late wrapper fires.
      _timePenaltyPp = Number(_pol.timePenaltyPp) || 0;
    }
    const struct = checkMarketStructureShift(b15, direction);
    const candle = detectCandlePatterns(b15, direction);
    const gate = rileyGate({ sr, rsiVal, thresholds, struct, candle, direction, trending });
    // RILEY_GATE=0 (opt-in, 2026-08-06): stop using rileyGate as a VETO. It is
    // still computed — confidence/quality/reason stay on the signal — it just no
    // longer decides what may be traded.
    //
    // Measured over 31,293 daily bars (experiments/entry_edge_test.js): the gate
    // discards ~46% of candidates and the survivors have LOWER forward returns
    // than the pool it selected from, at every horizon (1/5/10/20 bars) and with
    // the trend flag both on and off — 6 of 6. It is not a weak filter, it is an
    // anti-predictive one.
    const _gateOk = gateAllows(gate);

    // Tesseract cross-check (5-dimension eval) — advisory action alongside the gate.
    const zData = {
      [t]: { mid: sr.mid, top: sr.resistance, bottom: sr.support, type: sr.type, strength: sr.strength, touches: sr.touches, triggered_entry: gate.approved },
    };
    let tess = {};
    try { tess = tesseract.evaluate(t, zData, marketStatus, logs, nowIso) || {}; } catch (_e) { tess = {}; }

    zones[t] = { mid: sr.mid, top: sr.resistance, bottom: sr.support, type: sr.type, strength: sr.strength, touches: sr.touches, triggered_entry: gate.approved };

    if (_gateOk) {
      // External anchor (Σ₀): directional news sentiment for this ticker, signed
      // into the EV verdict. Impact-weighted score in [-100,100] → [-1,1]. Only
      // computed for gate-passing tickers (cheap; a few per scan).
      let newsSent = { label: "neutral", impact_weighted_score: 0, n: 0 };
      try { newsSent = tradingNews.symbolSentiment(t, { windowHours: 48 }); } catch (_e) { /* fail-soft */ }
      const news_sentiment = (Number(newsSent.impact_weighted_score) || 0) / 100;

      // Tier-1 confirmation inputs from the 15m bars: volume spike, MACD histogram,
      // price-vs-MA. Each feeds the EV model as a weighted signal.
      const closes15 = b15.map((b) => b.close);
      const volume_ratio = volumeRatio(b15);
      const m = macd(closes15);
      const macd_hist = m ? m.histogram : 0;
      const ma_signal = priceVsSma(closes15, 20);
      // Tier-2: last reported EPS surprise vs consensus (keyless Yahoo; cached 6h).
      let earn = null;
      try { earn = await yahoo.getEarningsSurprise(t); } catch (_e) { /* fail-soft */ }
      const earnings_surprise = earn ? earn.surprisePct : null;
      const secEtf = sectors.sectorFor(t);
      const sector_trend = secEtf && sectorMom[secEtf] != null ? sectorMom[secEtf] : null;
      const convergence = convergenceVerdict({ t, direction, sr, struct, candle, marketStatus, news_sentiment, volume_ratio, macd_hist, ma_signal, earnings_surprise, sector_trend });
      // APPLY THE TIME WEIGHT (#3356). Subtracted from p_win after scoring rather
      // than added as a convergence-ev feature, because it applies to exactly one
      // instrument class (economic shorts) and would otherwise dilute the shared
      // weight table for every 1x symbol. EV and the decision are re-derived from
      // the adjusted p_win so the whole verdict stays self-consistent.
      if (convergence && _timePenaltyPp > 0 && Number.isFinite(convergence.p_win)) {
        const _before = convergence.p_win;
        const _after = Math.max(0.05, _before - _timePenaltyPp / 100);
        const _tr = convergence.target_r || 2;
        convergence.p_win = Math.round(_after * 10000) / 10000;
        convergence.p_win_pre_time = _before;
        convergence.time_penalty_pp = _timePenaltyPp;
        convergence.ev_r = Math.round((_after * _tr - (1 - _after)) * 1000) / 1000;
        if (convergence.decision === "ENTER" && (convergence.ev_r < 0.15 || _after < 0.45)) {
          convergence.decision = "SKIP";
        }
        convergence.size_mult = ev.edgeRiskMultiplier(_after, _tr);
        logs.push({ time: nowIso, agent: "sigma0", symbol: t,
          body: `${t} — early wrapper fire priced, not blocked: p_win ${_before} -> ${convergence.p_win} (-${_timePenaltyPp}pp), ${convergence.decision} (#3356)` });
      }

      // ── Trend/regime filter (TRADER_REGIME_FILTER, on by default) ──────────────
      // The engine buys oversold DIPS; in a downtrend that's catching a falling knife —
      // walk-forward backtests showed this is where the edge is destroyed (single-stock
      // longs 26% win / PF 0.65). Only take a BULLISH entry when the name is trend-aligned:
      // price above its SMA-50 (on the 15m scan bars) AND MACD histogram positive. Same
      // gate the backtest used to flip the book from negative to positive expectancy.
      // Fail-open on insufficient history (SMA-50 unknown → don't block on price alone).
      if (process.env.TRADER_REGIME_FILTER !== '0' && direction === 'BULLISH' && convergence && convergence.decision === 'ENTER') {
        const sma50 = closes15.length >= 50 ? closes15.slice(-50).reduce((s, x) => s + x, 0) / 50 : null;
        const trendOk = (sma50 == null || price > sma50) && macd_hist > 0;
        if (!trendOk) { convergence.decision = 'SKIP'; convergence.skip_reason = 'regime_filter: not trend-aligned (need price>SMA50 & MACD hist>0)'; }
      }

      // Trade plan (framework Step 6): ATR-based risk unit, R-multiple targets, and
      // an ATR-scaled holding-horizon estimate. Levels prefer real S/R when close.
      const a = atr(b15);
      const r2 = (x) => Math.round(x * 100) / 100;
      const dirUp = direction === "BULLISH";
      const risk = Math.max((a || 0) * 2, price * 0.015);
      let stopPx = dirUp ? price - risk : price + risk;
      // Prefer a real S/R level for the stop ONLY when it's a sensible distance
      // (≥0.5% so the risk isn't near-zero, <6% so it isn't absurdly wide).
      const near = (lvl) => Math.abs(price - lvl) / price;
      if (dirUp && sr.support > 0 && sr.support < price && near(sr.support) >= 0.005 && near(sr.support) < 0.06) stopPx = sr.support;
      if (!dirUp && sr.resistance > price && near(sr.resistance) >= 0.005 && near(sr.resistance) < 0.06) stopPx = sr.resistance;
      const riskAbs = Math.max(Math.abs(price - stopPx), price * 0.008); // floor risk at 0.8%
      const tr = (convergence && convergence.target_r) || 2;
      const dailyMove = (a || price * 0.005) * 5.1; // 15m ATR → ~daily (√26)
      const holdDays = Math.max(1, Math.min(15, Math.round((tr * riskAbs) / dailyMove)));

      signals.push({
        symbol: t,
        direction,
        confidence: gate.confidence,
        entry_price: price,
        support: sr.support,
        resistance: sr.resistance,
        zone_mid: sr.mid,
        quality: gate.quality,
        rsi: Math.round(rsiVal),
        structure: struct.shift,
        candle: candle.pattern || null,
        tesseract: tess.action || null,
        convergence, // Σ₀ EV verdict: { decision:'ENTER'|'SKIP', p_win, ev_r, size_mult }
        news: { label: newsSent.label, score: newsSent.impact_weighted_score, n: newsSent.n }, // external anchor
        earnings: earn ? { surprise_pct: earn.surprisePct, quarter: earn.quarter } : null, // Tier-2
        sector: secEtf ? { etf: secEtf, trend_pct: sector_trend != null ? r2(sector_trend * 100) : null } : null, // Tier-2
        volume_ratio: r2(volume_ratio),
        atr: r2(a || price * 0.005),   // 15m ATR — the support-entry gate measures zone distance in this unit
        // ZONES ARRAY (2026-08-06). findSrZones returns a full zone LIST, but the
        // signal only ever carried the `support`/`resistance` SCALARS, so
        // auto-trader's `Array.isArray(s.zones) ? s.zones : []` always resolved
        // to []. Three consumers were silently dead in production:
        //   1. the support-entry gate skipped EVERY symbol it governs with
        //      "sup_entry: no support zone below price" — 8 of the 12 tradelist
        //      names (SPY QQQ GLD SMH TLT SQQQ SOXS SPXS) could never enter;
        //   2. the zone-ladder exit (#3165) never armed — the live ledger has
        //      ZERO zone_r1/zone_r2/peak_giveback exits across its whole history,
        //      every exit falling through to momentum_died/signal_exit;
        //   3. room tiering and tgtMinR were no-ops (no resistances to measure),
        //      so every entry was A-tier by default.
        // Passing the list through is what those features were always written
        // against.
        zones: Array.isArray(sr.zones) ? sr.zones : [],
        plan: { stop: r2(stopPx), target1: r2(dirUp ? price + tr * riskAbs : price - tr * riskAbs), target2: r2(dirUp ? price + tr * 1.7 * riskAbs : price - tr * 1.7 * riskAbs), hold_days: holdDays },
        reasons: gate.reason,
      });
    }
    logs.push({ time: nowIso, agent: "RILEY", symbol: t, body: `${t} ${direction} ${gate.quality} conf=${gate.confidence} — ${gate.reason}` });
  }

  signals.sort((a, b) => b.confidence - a.confidence);
    // ── ANALYST PASS (#3355) ────────────────────────────────────────────────
    // The 9% `claude_conf` weight has been fed a neutral 50 since PR #1959
    // deleted the agent layer on 2026-07-03. This is the only place that sets
    // it. Bounded by construction: ENTER candidates only (never the whole
    // watchlist), one call each, hard timeout, and any failure returns 50 —
    // which reproduces exactly the behaviour of the last six weeks. It moves
    // p_win by at most +/-4.5pp and cannot veto: every auto-trader gate still
    // runs afterwards.
    const _haiku = require("./haiku-analyst");
    if (_haiku.enabled()) {
      const _cands = signals.filter((s2) => s2.convergence && s2.convergence.decision === "ENTER" && s2.convergence._ev);
      const _spy = spyTapeContext(bars15.SPY && bars15.SPY.bars);
      const _dl = require("../direction-lock");
      await Promise.all(_cands.map(async (s2) => {
        try {
          const _b15 = (bars15[s2.symbol] && bars15[s2.symbol].bars) || [];
          const _proxy = _dl.underlyingProxy(s2.symbol);
          const _uBars = _proxy && _proxy !== s2.symbol && bars15[_proxy] ? (bars15[_proxy].bars || []) : null;
          const _m = barEtMinute(_b15);
          const r = await _haiku.analyze({
            symbol: s2.symbol,
            direction: s2.direction,
            price: s2.entry_price,
            stop: s2.plan && s2.plan.stop,
            target: s2.plan && s2.plan.target1,
            p_win: s2.convergence.p_win,
            ev_r: s2.convergence.ev_r,
            ibs: sessionIbs(_b15),
            underlying: _proxy,
            underlying_tape: _uBars ? sessionDrawdownPct(_uBars) : null,
            spy_tape: _spy.tape,
            spy_mom30: _spy.mom30,
            regime: marketStatus && marketStatus.market,
            volume_ratio: s2.volume_ratio,
            macd_hist: s2.convergence._ev.macd_hist,
            news_sentiment: s2.convergence._ev.news_sentiment,
            sector_trend: s2.convergence._ev.sector_trend,
            in_zone: s2.convergence._ev.in_zone,
            et_time: _m == null ? null : Math.floor(_m / 60) + ":" + String(_m % 60).padStart(2, "0"),
            sign: s2.convergence._sign,
            leverage: _dl.leverageOf(s2.symbol),
            family: _dl.instrumentSign(s2.symbol).family,
          });
          s2.analyst = { conviction: r.conviction, reason: r.reason, degraded: !!r.degraded, latency_ms: r.latency_ms };
          if (r.degraded || r.conviction === _haiku.NEUTRAL) return;   // no view -> leave the verdict untouched
          // BOUND THE INFLUENCE HERE, not by trusting convergence-ev's internal
          // weight. Measured: claude_conf 50->0 moves p_win a full 9.00pp, which
          // near P_MIN (0.45) is enough to flip a verdict on its own — a weight
          // that large is a gate wearing a weight's clothes, and the whole reason
          // this slot was demoted from gate to weight is that a model must not
          // decide alone. The swing is capped at TRADER_HAIKU_MAX_SWING_PP (4.5
          // by default = half the available pull). The relationship is linear in
          // conviction, so one interpolation toward neutral lands exactly on the
          // cap, and the cap holds even if the underlying weight is retuned.
          const _capPp = Number(process.env.TRADER_HAIKU_MAX_SWING_PP);
          const _cap = (Number.isFinite(_capPp) ? _capPp : 4.5) / 100;
          let c2 = ev.scoreConvergence({ ...s2.convergence._ev, claude_conf: r.conviction });
          const _swing = c2.p_win - s2.convergence.p_win;
          if (_cap > 0 && Math.abs(_swing) > _cap) {
            const _scaled = 50 + (r.conviction - 50) * (_cap / Math.abs(_swing));
            c2 = ev.scoreConvergence({ ...s2.convergence._ev, claude_conf: _scaled });
            s2.analyst.conviction_applied = Math.round(_scaled * 10) / 10;
            s2.analyst.capped = true;
          }
          s2.convergence.p_win_before = s2.convergence.p_win;
          s2.convergence.p_win = c2.p_win;
          s2.convergence.ev_r = c2.ev_r;
          s2.convergence.decision = c2.decision;
          s2.convergence.size_mult = ev.edgeRiskMultiplier(c2.p_win, c2.target_r);
          logs.push({ time: nowIso, agent: "haiku", symbol: s2.symbol,
            body: `analyst ${r.conviction}/100 — ${r.reason} (p_win ${s2.convergence.p_win_before} -> ${c2.p_win}, ${c2.decision})` });
        } catch (_e) { /* the analyst must never break a scan */ }
      }));
    }
    // strip the retained scoring input — not part of the signal contract
    for (const s2 of signals) {
      if (s2.convergence) { delete s2.convergence._ev; delete s2.convergence._sign; }
    }

  return {
    signals,
    zones,
    logs,
    timestamp: nowIso,
    watchlist_count: list.length,
    signals_count: signals.length,
    // Tape context for entry attribution (2026-08-11): the drift-day question
    // ("do washout entries underperform when the broad tape is sinking?") needs
    // SPY's same-day move stamped on every entry row. Attribution first,
    // behavior later — any drift governor must earn its gate from this data.
    spy_1d: Number(marketStatus.spy_1d) ?? null,
    market: marketStatus.market || null,
  };
}

module.exports = { scanAll, getZones, deriveDirection, sessionIbs, sessionDrawdownPct, barEtMinute, applyPolarity, spyTapeContext, gateAllows, rileyGate, candleGrade, convergenceVerdict };
