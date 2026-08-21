/**
 * portfolio_2y_lab.js — what does the LIVE config earn per month? (#3411 follow-up,
 * operator 2026-08-22: "lets run the 2 year backtests, how much % did the trader
 * make a month? is it profitable right now?")
 *
 * The threshold/rotation labs score strategies as summed per-trade returns — the
 * right metric for CHOOSING a config, but not an answer to "% per month", which
 * is a PORTFOLIO number: sizing, concurrency, and compounding included. This lab
 * simulates the live book the way the live engine actually runs it, on the ~2
 * years of hourly data that exist (Yahoo caps 1h at ~730d):
 *
 *   - the operator's real tradelist LONG side (data/lantern-garage/trading/
 *     tradelists/local-owner.json): SPY QQQ IWM DIA GLD TLT SMH XLK SOXL.
 *     The inverse wrappers (SQQQ SOXS SPXS) are excluded: post-#3295 they never
 *     self-fire (polarity veto) and only enter via the redirect, which this
 *     analog cannot model honestly.
 *   - entries: day-anchored running IBS at hourly bar closes, first-touch, one
 *     position per symbol; effective threshold 0.08 before 11:00 ET (the live
 *     TRADER_IBS_MAX_MORNING) and the base threshold after; deepest washout
 *     wins when slots are contested.
 *   - sizing: 12% of CURRENT equity per position (TRADER_RISK_PCT 0.36% at the
 *     3% floor), max 5 concurrent (TRADER_MAX_CONCURRENT) — compounding.
 *   - exits: −3% stop from entry, first touch, checked pessimistically before
 *     the bounce; else first bar close with running dayIBS ≥ 0.6; else the
 *     close of the 5th session after entry.
 *   - equity marked to market every bar (real drawdown, not exit-to-exit).
 *
 * Run BOTH thresholds side by side: 0.15 (the config that produced the live
 * ledger to date) and 0.30 (shipped to both boxes 2026-08-21 after #3411).
 *
 * WHAT THIS IS NOT: the engine. No slippage/commissions, no SPY-tape or knife
 * gates, no zone-ladder exits (bounce proxy), flat 3% stop vs live vol-scaled,
 * unadjusted prices (dividends missed — GLD/TLT/SPY carry understated), ~2y of
 * one regime. Treat the MONTH-BY-MONTH DISPERSION as seriously as the average:
 * the honest claim is a range, not a rate.
 *
 * Usage: node experiments/portfolio_2y_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const POS_FRAC = 0.12;
const MAX_CONC = 5;
const STOP = 0.03;
const MORNING_THR = 0.08;

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

const ET_DAY = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const ET_HM = (ms) => {
  const s = new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
};

async function hourly(sym, days) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - days * 86400;
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&period1=${p1}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data for " + sym);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  // per-session running high/low + session index + last-bar flag + ET close minute
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = ET_HM(b.t + 3600 * 1000);
    b.isLast = i + 1 >= out.length || ET_DAY(out[i + 1].t) !== d;
  }
  return out;
}

const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);

/** One full portfolio walk at a base threshold. Returns the equity curve + trades. */
function simulate(barsBySym, baseThr) {
  // merged timeline of unique timestamps; per symbol, pointer into its bars
  const tsSet = new Set();
  for (const sym of SYMS) for (const b of barsBySym[sym]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(SYMS.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));

  let cash = 100;
  const open = new Map();     // sym -> {entry, qtyVal, stopPx, entrySi, entryT}
  const trades = [];
  const curve = [];           // {t, d, equity}
  for (const t of timeline) {
    // 1) exits first (frees slots for this bar's entries)
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b) continue;
      let exitPx = null, reason = null;
      if (b.t > pos.entryT && b.l <= pos.stopPx) { exitPx = pos.stopPx; reason = "stop"; }
      else if (b.t > pos.entryT && rIbs(b) >= 0.6) { exitPx = b.c; reason = "bounce"; }
      else if (b.si >= pos.entrySi + 5 && b.isLast) { exitPx = b.c; reason = "timeout"; }
      if (exitPx != null) {
        const ret = exitPx / pos.entry - 1;
        cash += pos.qtyVal * (1 + ret);
        trades.push({ sym, d: b.d, ret, reason });
        open.delete(sym);
      }
    }
    // 2) mark-to-market equity at this bar
    let equity = cash;
    for (const [sym, pos] of open) {
      const b = idx[sym].get(t);
      const px = b ? b.c : pos.entry;
      equity += pos.qtyVal * (px / pos.entry);
    }
    // 3) entries (deepest washout first when slots are contested)
    if (open.size < MAX_CONC) {
      const cands = [];
      for (const sym of SYMS) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;                    // warm-up session
        const v = rIbs(b);
        const thr = b.closeMin < 660 ? MORNING_THR : baseThr;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const cnd of cands) {
        if (open.size >= MAX_CONC) break;
        const size = equity * POS_FRAC;
        if (size > cash) continue;                         // never lever
        cash -= size;
        open.set(cnd.sym, { entry: cnd.b.c, qtyVal: size, stopPx: cnd.b.c * (1 - STOP),
          entrySi: cnd.b.si, entryT: cnd.b.t });
      }
    }
    curve.push({ t, d: ET_DAY(t), equity });
  }
  // liquidate leftovers at the final mark so both configs end comparable
  const last = curve[curve.length - 1];
  for (const [sym, pos] of open) {
    const b = barsBySym[sym][barsBySym[sym].length - 1];
    trades.push({ sym, d: b.d, ret: b.c / pos.entry - 1, reason: "eod_final" });
  }
  return { curve, trades, finalEquity: last.equity };
}

function report(label, sim) {
  const { curve, trades, finalEquity } = sim;
  const tot = finalEquity / 100 - 1;
  const days = (curve[curve.length - 1].t - curve[0].t) / 86400000;
  const months = days / 30.44;
  const geoM = Math.pow(finalEquity / 100, 1 / months) - 1;
  let peak = -Infinity, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1); }
  const wins = trades.filter((x) => x.ret > 0).length;
  // month-by-month from equity marks
  const byMonth = new Map();
  for (const p of curve) {
    const m = p.d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { first: p.equity, last: p.equity });
    byMonth.get(m).last = p.equity;
  }
  const months_ = [...byMonth.keys()];
  const monthRets = [];
  for (let i = 0; i < months_.length; i++) {
    const start = i === 0 ? 100 : byMonth.get(months_[i - 1]).last;
    monthRets.push({ m: months_[i], r: byMonth.get(months_[i]).last / start - 1 });
  }
  const neg = monthRets.filter((x) => x.r < 0).length;
  console.log(`\n=== ${label} ===`);
  console.log(`  total ${((tot) * 100).toFixed(1)}% over ${months.toFixed(1)} months  →  ${(geoM * 100).toFixed(2)}%/month geometric`);
  console.log(`  trades ${trades.length}  WR ${(wins / trades.length * 100).toFixed(0)}%  maxDD ${(dd * 100).toFixed(1)}%  negative months ${neg}/${monthRets.length}`);
  console.log(`  by month:`);
  let line = "   ";
  for (const x of monthRets) {
    line += ` ${x.m.slice(2)}:${(x.r * 100).toFixed(1).padStart(5)}%`;
    if (line.length > 100) { console.log(line); line = "   "; }
  }
  if (line.trim()) console.log(line);
  const midT = curve[Math.floor(curve.length / 2)].t;
  const midE = curve[Math.floor(curve.length / 2)].equity;
  console.log(`  halves: first ${((midE / 100 - 1) * 100).toFixed(1)}%  second ${((finalEquity / midE - 1) * 100).toFixed(1)}%  (split ${ET_DAY(midT)})`);
  return { geoM, tot, dd };
}

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const barsBySym = {};
  for (const s of SYMS) {
    barsBySym[s] = await hourly(s, DAYS);
    console.log(`${s}: ${barsBySym[s].length} hourly bars`);
  }
  report("LIVE-ANALOG @ IBS 0.15 (the config the ledger was earned on)", simulate(barsBySym, 0.15));
  report("LIVE-ANALOG @ IBS 0.30 (shipped 2026-08-21, #3411)", simulate(barsBySym, 0.30));
  console.log(`\nCaveats: no slippage/commissions/gates, bounce proxy for zone-ladder, flat 3% stop,`);
  console.log(`unadjusted prices, ~2y = one regime. The dispersion IS part of the answer.`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
