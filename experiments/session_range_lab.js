/**
 * session_range_lab.js — the live IBS is measured against the wrong range
 * (deep-flaws pass, 2026-08-22)
 *
 * lib/market-data-yahoo.js fetches every intraday chart with includePrePost=true
 * and parseBars keeps all of it; signal-engine/scan.js sessionIbs() takes every
 * bar carrying today's date. So the LIVE session IBS is (last - low) / (high -
 * low) over 04:00-now ET, pre-market prints included. Every lab validated the
 * regular-hours IBS (09:30-now). On a gap day the thin pre-market prints sit
 * near yesterday's close, stretching the range in the direction of the gap:
 * a gap-down morning reads "washed out" at the bell against a phantom high, and
 * the 0.6 bounce exit then needs most of the gap filled before it can fire.
 *
 * PART 1 — HOW OFTEN DO THE TWO RULERS DISAGREE? Hourly bars with extended
 *   prints, 2y, nine names: for each regular-hours bar, IBS over the RTH range
 *   so far vs IBS over the all-session range so far; share of bars where the
 *   ENTRY read (<= 0.30) or the EXIT read (>= 0.6) flips.
 * PART 2 — WHAT DOES IT COST? The Monday config simulated with the signal
 *   computed on the contaminated range (what the engine does today) vs the
 *   clean range (what was validated). Fills and exits use real RTH prices in
 *   both; only the IBS ruler differs. Entries/exits only in regular hours.
 *
 * Usage: node experiments/session_range_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, ruler: "rth" };

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
async function chart(sym, interval, fromSec, prepost) {
  const p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&period1=${fromSec}&period2=${p2}&includePrePost=${prepost ? "true" : "false"}`);
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
/** Two running ranges per session: RTH-only and all-prints. Bars get startMin (ET). */
function annotate(bars) {
  let day = null, si = -1, rH = -Infinity, rL = Infinity, aH = -Infinity, aL = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; rH = -Infinity; rL = Infinity; aH = -Infinity; aL = Infinity; }
    b.startMin = ET_HM(b.t);
    b.rth = b.startMin >= 570 && b.startMin < 960;
    aH = Math.max(aH, b.h); aL = Math.min(aL, b.l);
    if (b.rth) { rH = Math.max(rH, b.h); rL = Math.min(rL, b.l); }
    b.si = si; b.d = d;
    b.runH_rth = rH; b.runL_rth = rL; b.runH_all = aH; b.runL_all = aL;
    b.closeMin = Math.min(960, b.startMin + 60);
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let j = i + 1; while (j < bars.length && !bars[j].rth) j++;
    b.isLast = b.rth && (j >= bars.length || bars[j].d !== b.d);
  }
  return bars;
}
const ibsOf = (b, ruler) => {
  const H = ruler === "all" ? b.runH_all : b.runH_rth, L = ruler === "all" ? b.runL_all : b.runL_rth;
  return H - L > 0 && Number.isFinite(H) && Number.isFinite(L) ? (b.c - L) / (H - L) : null;
};

function simulate(barsBySym, syms, cfg) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if (b.rth) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  for (const t of timeline) {
    const d = ET_DAY(t);
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b || b.t <= pos.entryT) continue;
      const legs = b.c >= b.o ? ["L", "H", "C"] : ["H", "L", "C"];
      let exitPx = null, reason = null;
      for (const leg of legs) {
        if (leg === "H") {
          pos.peak = Math.max(pos.peak, b.h);
          if (o.be != null && b.h >= pos.entry * (1 + o.be)) { const want = pos.entry * (1 + o.lock); if (pos.stopPx < want) pos.stopPx = want; }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (px <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.trail) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const v = ibsOf(b, o.ruler);
      if (exitPx == null) {
        if (v != null && v >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size < o.maxConc) {
      const cands = [];
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || !b.rth || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        const v = ibsOf(b, o.ruler);
        if (v == null) continue;
        const thr = b.closeMin < 660 ? o.morningThr : o.thr;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx });
      }
    }
    curve.push({ t, d, equity });
  }
  return { curve, trades };
}
function score(curve, from, to) {
  const seg = curve.filter((p) => p.d >= from && p.d < to);
  if (seg.length < 10) return null;
  const tot = seg[seg.length - 1].equity / seg[0].equity - 1;
  let peak = -Infinity, dd = 0;
  const byMonth = new Map();
  for (const p of seg) { peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1); const m = p.d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, {}); byMonth.get(m).last = p.equity; }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length };
}
const pct = (x, w = 6) => (x * 100).toFixed(1).padStart(w) + "%";
const ratio = (s) => (s && s.dd < 0 ? (s.tot / -s.dd).toFixed(2).padStart(5) : "  n/a");

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const bars = {};
  for (const s of SYMS) bars[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400, true));
  const ext = Object.values(bars).reduce((a, arr) => a + arr.filter((b) => !b.rth).length, 0), tot = Object.values(bars).reduce((a, arr) => a + arr.length, 0);
  console.log(`hourly bars with extended prints: ${tot} total, ${ext} outside 09:30-16:00 (${(ext / tot * 100).toFixed(0)}%)\n`);

  console.log("PART 1 — HOW OFTEN DO THE TWO RULERS DISAGREE? (regular-hours bars, 2y)");
  let n = 0, entryFlip = 0, falseFire = 0, missedFire = 0, exitFlip = 0, gapDays = 0, days = new Set(), diffSum = 0;
  for (const s of SYMS) for (const b of bars[s]) {
    if (!b.rth) continue;
    const a = ibsOf(b, "all"), r = ibsOf(b, "rth");
    if (a == null || r == null) continue;
    n++; diffSum += Math.abs(a - r);
    const fa = a <= 0.30, fr = r <= 0.30;
    if (fa !== fr) { entryFlip++; if (fa && !fr) falseFire++; else missedFire++; }
    if ((a >= 0.6) !== (r >= 0.6)) exitFlip++;
    if (b.runH_all > b.runH_rth || b.runL_all < b.runL_rth) days.add(s + b.d);
  }
  console.log(`  bars ${n}; mean |IBS_all - IBS_rth| ${(diffSum / n).toFixed(3)}`);
  console.log(`  ENTRY read (<= 0.30) flips on ${(entryFlip / n * 100).toFixed(1)}% of bars — contaminated says FIRE but clean does not: ${falseFire}; clean says fire but contaminated does not: ${missedFire}`);
  console.log(`  EXIT read (>= 0.6) flips on ${(exitFlip / n * 100).toFixed(1)}% of bars`);
  console.log(`  symbol-sessions where pre-market prints lie OUTSIDE the regular range at some point: ${days.size}\n`);

  console.log("PART 2 — WHAT DOES IT COST? Monday config; only the IBS ruler differs");
  const H_START = bars.SPY.find((b) => b.rth).d, H_MID = bars.SPY[Math.floor(bars.SPY.length / 2)].d, H_END = "2099-01-01";
  const LABELS = ["hourly 1st half", "hourly 2nd half", "hourly FULL 2y "];
  for (const [name, ruler] of [["CLEAN ruler (09:30-now) — what was validated", "rth"], ["CONTAMINATED ruler (04:00-now) — what the engine computes today", "all"]]) {
    const r = simulate(bars, SYMS, { ...MONDAY, ruler });
    const s = [score(r.curve, H_START, H_MID), score(r.curve, H_MID, H_END), score(r.curve, H_START, H_END)];
    const mix = r.trades.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {});
    const w = r.trades.filter((x) => x.ret > 0).length;
    console.log(`  ${name}`);
    for (let i = 0; i < 3; i++) console.log(`    ${LABELS[i]}: tot ${pct(s[i].tot, 7)}  DD ${pct(s[i].dd)}  tot÷DD ${ratio(s[i])}  worstMo ${pct(s[i].worst)}`);
    console.log(`    trades ${r.trades.length}  WR ${(w / r.trades.length * 100).toFixed(0)}%  avg ${(r.trades.reduce((a, x) => a + x.ret, 0) / r.trades.length * 100).toFixed(2)}%  exits ${JSON.stringify(mix)}`);
  }
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
