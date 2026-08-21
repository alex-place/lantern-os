/**
 * loss_reduction_lab.js — reduce the red months without gutting the engine
 * (#3412 follow-up; operator 2026-08-22: "we should be reducing the losses by
 * either increasing the wr … or the RR by finetuning the stop losses and take
 * profits … losing 3.8% a month is a lot.")
 *
 * GROUNDING — where losses actually live (measured before designing anything):
 *   Live ledger, current-config era (8/10→8/21): gross losses −$10,541, of
 *   which the engine's OWN exits lost only −$1,278 (signal_exit net +$4.9k,
 *   zone/trail/peak ladder nearly loss-free). Two-thirds of losses sit in the
 *   broker-seam buckets (closed_externally −$5.4k net, broker −$2.4k) — i.e.
 *   protective stops firing (pre-#3379 these were misclassified) — and cluster
 *   in correlated names (SMH/SOXL/QQQ = −$7.9k of −$10.5k). Backtest (#3412):
 *   7/24 months red, worst −3.8% (0.15) / −3.3% (0.30), red months = stop
 *   clusters in sustained downtrends.
 *
 * So the levers are: stop POLICY (when a stop should stand down the book, when
 * to ratchet), correlation PILE-INS (five slots filling on the same red day),
 * regime-scaled SIZE (keep the entries — the uptrend FILTER is measured-worst —
 * but carry less into hostile tape), and banking partials. Six variants, each
 * ONE mechanism, on the #3412 portfolio simulator:
 *
 *   A  breakeven ratchet   — once up +be, stop rises to entry (intraday only)
 *   B  regime-half sizing  — position 12% → 6% while SPY < its 200d SMA
 *                            (yesterday's close vs yesterday's SMA — no peek)
 *   C  stop-cascade breaker— after N portfolio stop-outs in one session, no new
 *                            entries for the rest of that session
 *   D  day entry cap       — at most N NEW positions per session (correlation
 *                            limiter: slot 4-5 on one day = one bet, not five)
 *   E  shorter timeout     — T sessions instead of 5 (cut the slow bleeders)
 *   F  scale-out           — bank half at +tp, remainder rides the bounce exit
 *
 * DISCIPLINE (the whole point): six variants on one 2y window is a fishing
 * trip. Two independent bars must BOTH pass:
 *   - hourly 2y (9-symbol live book): parameter chosen on the FIRST half,
 *     confirmed on the SECOND half.
 *   - daily 26y two-window (2000–2014 fit / 2015– holdout), same 9 symbols
 *     joining as they list — for the daily-expressible variants (B, C, D, E).
 *     A and F trigger on bar highs and enforce from the next bar, so they are
 *     expressible on daily bars too and face the full two-window bar.
 *   A variant ships only if it improves the LOSS metrics (worst month, maxDD,
 *   negative-month count) in BOTH halves/windows while keeping ≥90% of the
 *   baseline's total return. Improving average return is NOT the goal here.
 *
 * Usage: node experiments/loss_reduction_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const POS_FRAC = 0.12;
const MAX_CONC = 5;
const STOP = 0.03;
const MORNING_THR = 0.08;
const BASE_THR = 0.30;
// Stop-type fills (stop, be_stop) fill THROUGH the trigger in reality. 5bp on
// liquid ETFs; the be-ratchet lives or dies on this because it mints thousands
// of at-entry exits the frictionless model books at exactly 0.
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;

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

async function chart(sym, interval, fromSec) {
  const p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&period1=${fromSec}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data for " + sym);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}

function annotateHourly(bars) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = ET_HM(b.t + 3600 * 1000);
    b.isLast = i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);

/** SPY regime map: date -> was YESTERDAY's close above YESTERDAY's 200d SMA. */
function regimeMap(spyDaily) {
  const m = new Map();
  let acc = 0;
  for (let i = 0; i < spyDaily.length; i++) {
    acc += spyDaily[i].c;
    if (i >= 200) acc -= spyDaily[i - 200].c;
    const above = i >= 199 ? spyDaily[i].c > acc / 200 : true;
    if (i + 1 < spyDaily.length) m.set(spyDaily[i + 1].d, above);
  }
  return m;
}

/**
 * Portfolio walk with mechanism flags. Works on hourly (intraday=true) or daily
 * bars (intraday=false: entry at close, stop checked pessimistically from the
 * next bar's low, bounce on next closes).
 * opts: {be, regimeHalfBelow, breakerN, dayCapN, timeoutS, scaleTp}
 */
function simulate(barsBySym, syms, opts, intraday, regime) {
  const o = { be: null, regimeHalfBelow: null, breakerN: null, dayCapN: null,
    timeoutS: 5, scaleTp: null, ...opts };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));

  let cash = 100;
  const open = new Map();
  const trades = [];
  const curve = [];
  let curDay = null, stopsToday = 0, entriesToday = 0;
  const beBlock = new Map();   // sym -> earliest session index allowed back in
  for (const t of timeline) {
    const d = ET_DAY(t);
    if (d !== curDay) { curDay = d; stopsToday = 0; entriesToday = 0; }
    // exits first
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b || b.t <= pos.entryT) continue;
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      let exitPx = null, reason = null;
      if (b.l <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = pos.stopPx * (1 - SLIP); }
      else if (ibsV >= 0.6) { exitPx = b.c; reason = "bounce"; }
      else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d: b.d || d, ret: exitPx / pos.entry - 1, reason });
        if (reason === "stop") stopsToday++;
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);   // no same-session re-entry churn
        open.delete(sym);
        continue;
      }
      // scale-out: bank a fraction at +tp (pessimistic: fill AT the trigger)
      if (o.scaleTp && !pos.scaled && b.h >= pos.entry * (1 + o.scaleTp)) {
        const part = pos.qtyVal * 0.5;
        cash += part * (1 + o.scaleTp);
        trades.push({ sym, d: b.d || d, ret: o.scaleTp, reason: "scale_out" });
        pos.qtyVal -= part; pos.scaled = true;
      }
      // breakeven ratchet: raise the stop to entry once the bar HIGH clears +be.
      // Applied at bar close (the raised stop guards from the NEXT bar on).
      if (o.be != null && b.h >= pos.entry * (1 + o.be) && pos.stopPx < pos.entry) pos.stopPx = pos.entry;
    }
    let equity = cash;
    for (const [sym, pos] of open) {
      const b = idx[sym].get(t);
      equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry);
    }
    // entries
    const blocked = (o.breakerN != null && stopsToday >= o.breakerN)
      || (o.dayCapN != null && entriesToday >= o.dayCapN);
    if (open.size < MAX_CONC && !blocked) {
      const cands = [];
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? MORNING_THR : BASE_THR;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const cnd of cands) {
        if (open.size >= MAX_CONC) break;
        if (o.dayCapN != null && entriesToday >= o.dayCapN) break;
        let frac = POS_FRAC;
        if (o.regimeHalfBelow != null && regime && regime.get(d) === false) frac *= o.regimeHalfBelow;
        const size = equity * frac;
        if (size > cash) continue;
        cash -= size;
        open.set(cnd.sym, { entry: cnd.b.c, qtyVal: size, stopPx: cnd.b.c * (1 - STOP),
          entrySi: cnd.b.si, entryT: cnd.b.t, scaled: false });
        entriesToday++;
      }
    }
    curve.push({ t, d, equity });
  }
  return { curve, trades, finalEquity: curve[curve.length - 1].equity };
}

/** Loss-focused scorecard for a slice of the equity curve. */
function score(curve, from, to) {
  const seg = curve.filter((p) => p.d >= from && p.d < to);
  if (seg.length < 10) return null;
  const tot = seg[seg.length - 1].equity / seg[0].equity - 1;
  let peak = -Infinity, dd = 0;
  const byMonth = new Map();
  for (const p of seg) {
    peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1);
    const m = p.d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { first: p.equity });
    byMonth.get(m).last = p.equity;
  }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) {
    const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last;
    const r = byMonth.get(ms[i]).last / start - 1;
    if (r < worst) worst = r;
    if (r < 0) neg++;
  }
  return { tot, dd, worst, neg, months: ms.length };
}
const fmt = (s) => s ? `tot ${(s.tot * 100).toFixed(1).padStart(6)}%  DD ${(s.dd * 100).toFixed(1).padStart(6)}%  worstMo ${(s.worst * 100).toFixed(1).padStart(5)}%  negMo ${String(s.neg).padStart(2)}/${s.months}` : "n/a";

/** Does variant beat baseline on the LOSS metrics while keeping >=90% of total? */
function verdict(base, v) {
  if (!base || !v) return "n/a";
  const lossBetter = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg);
  const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot;
  return `${lossBetter}/3 loss metrics better, total ${keeps ? "kept" : "SACRIFICED"}${lossBetter >= 2 && keeps ? "  << PASS" : ""}`;
}

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);

  // ── data ──────────────────────────────────────────────────────────────────
  const hourly = {};
  for (const s of SYMS) hourly[s] = annotateHourly(await chart(s, "1h", nowSec - DAYS * 86400));
  const daily = {};
  for (const s of SYMS) {
    const bars = await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000));
    let si = 0;
    for (const b of bars) { b.d = new Date(b.t).toISOString().slice(0, 10); b.si = si++; b.isLast = true; }
    daily[s] = bars;
  }
  console.log(`hourly: ${SYMS.map((s) => s + ":" + hourly[s].length).join(" ")}`);
  console.log(`daily : ${SYMS.map((s) => s + ":" + daily[s][0].d.slice(0, 4)).join(" ")}  (symbols join as listed)\n`);
  const regD = regimeMap(daily.SPY);   // full history — serves both sims

  const H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d;
  const H_END = "2099-01-01", H_START = hourly.SPY[0].d;
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];

  // ── baseline ──────────────────────────────────────────────────────────────
  const baseH = simulate(hourly, SYMS, {}, true, regD);
  const baseD = simulate(daily, SYMS, {}, false, regD);
  const bH1 = score(baseH.curve, H_START, H_MID), bH2 = score(baseH.curve, H_MID, H_END);
  const bD1 = score(baseD.curve, ...FIT), bD2 = score(baseD.curve, ...HOLD);
  console.log("BASELINE (live analog @0.30)");
  console.log(`  hourly 1st half: ${fmt(bH1)}`);
  console.log(`  hourly 2nd half: ${fmt(bH2)}`);
  console.log(`  daily  fit     : ${fmt(bD1)}`);
  console.log(`  daily  holdout : ${fmt(bD2)}\n`);

  // ── variants ──────────────────────────────────────────────────────────────
  const variants = [
    { key: "A be+0.5%", opts: { be: 0.005 }, daily: true },
    { key: "A be+0.75%", opts: { be: 0.0075 }, daily: true },
    { key: "A be+1.0%", opts: { be: 0.010 }, daily: true },
    { key: "A be+1.5%", opts: { be: 0.015 }, daily: true },
    { key: "A be+2.0%", opts: { be: 0.020 }, daily: true },
    { key: "A be+2.5%", opts: { be: 0.025 }, daily: true },
    { key: "A be+3.0%", opts: { be: 0.030 }, daily: true },
    { key: "B half-size<200d", opts: { regimeHalfBelow: 0.5 }, daily: true },
    { key: "C breaker N=2", opts: { breakerN: 2 }, daily: true },
    { key: "C breaker N=3", opts: { breakerN: 3 }, daily: true },
    { key: "D dayCap 2", opts: { dayCapN: 2 }, daily: true },
    { key: "D dayCap 3", opts: { dayCapN: 3 }, daily: true },
    { key: "E timeout 3", opts: { timeoutS: 3 }, daily: true },
    { key: "F scale@+2%", opts: { scaleTp: 0.02 }, daily: true },
    { key: "F scale@+3%", opts: { scaleTp: 0.03 }, daily: true },
  ];
  for (const v of variants) {
    const sH = simulate(hourly, SYMS, v.opts, true, regD);
    const h1 = score(sH.curve, H_START, H_MID), h2 = score(sH.curve, H_MID, H_END);
    console.log(`${v.key}`);
    console.log(`  hourly 1st half: ${fmt(h1)}   ${verdict(bH1, h1)}`);
    console.log(`  hourly 2nd half: ${fmt(h2)}   ${verdict(bH2, h2)}`);
    if (v.daily) {
      const sD = simulate(daily, SYMS, v.opts, false, regD);
      const d1 = score(sD.curve, ...FIT), d2 = score(sD.curve, ...HOLD);
      console.log(`  daily  fit     : ${fmt(d1)}   ${verdict(bD1, d1)}`);
      console.log(`  daily  holdout : ${fmt(d2)}   ${verdict(bD2, d2)}`);
      const nBe = sD.trades.filter((x) => x.reason === "be_stop").length;
      if (nBe) console.log(`  daily be_stop exits: ${nBe} of ${sD.trades.length} trades (each pays ${(SLIP * 10000).toFixed(0)}bp slip)`);
    } else {
      console.log(`  (intraday mechanism — hourly bar only)`);
    }
    console.log("");
  }
  console.log("SHIP RULE: >=2/3 loss metrics better with total kept, on EVERY surface the");
  console.log("variant is expressible on. Improving average return is not the goal here.");
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
