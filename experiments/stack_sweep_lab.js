/**
 * stack_sweep_lab.js — the knobs nobody swept under the FULL stack (round 5,
 * 2026-08-22). Every parameter below was chosen under an earlier, different
 * exit/gate configuration. Re-sweep each under the Monday stack, one at a
 * time, chosen on the FIT surfaces (hourly 1st half + daily 2000-14), scored
 * once on holdout (hourly 2nd half + daily 2015-).
 *
 *   A. EXIT LEVEL — bounce at session IBS >= {0.5, 0.6, 0.7, 0.8}. 0.6 came
 *      from the original research and was never varied.
 *   B. ENTRY THRESHOLD — {0.20, 0.25, 0.30, 0.35, 0.40}; 0.30 was chosen under
 *      the old exits (#3411).
 *   C. MORNING GATE — pre-11:00 threshold {0.08 (live), 0.15, off}.
 *   D. SYMBOL TILT — size each name by its FIT expectancy (daily 2000-14,
 *      hourly 1st half for SOXL): weight = clamp(edge / median edge, 0.5, 1.5)
 *      x 12%, chosen on fit, scored on holdout. The anatomy: SOXL supplies the
 *      profit; TLT/GLD are dead weight; the live room tier halves SOXL.
 *   E. KELLY — what the stack's own win rate and payoff imply for size.
 *
 * Monday stack: 0.30 / morning 0.08 / 3% stop / trail / floor +1% / exit 0.6 /
 * no knife / no cooldown / 13:30-14:30 block / x1.5 at VIX >= 20 / clean ruler.
 * Usage: node experiments/stack_sweep_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, skipHours: new Set([14]), vixUp: 20, weights: null };

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
function annotate(bars, intraday) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = intraday ? ET_DAY(b.t) : new Date(b.t).toISOString().slice(0, 10);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = intraday ? ET_HM(b.t + 3600 * 1000) : 960;
    b.hour = Math.floor(b.closeMin / 60);
    b.isLast = intraday ? (i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d) : true;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
function priorCloseMap(dailyBars) { const m = new Map(); for (let i = 0; i + 1 < dailyBars.length; i++) m.set(dailyBars[i + 1].d, dailyBars[i].c); return m; }

function simulate(barsBySym, syms, cfg, intraday, vix, from, to) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if ((!from || b.d >= from) && (!to || b.d < to)) tsSet.add(b.t);
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
      const v = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (v >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, pnlEq: pos.qtyVal * (exitPx / pos.entry - 1), reason });
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
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        if (intraday && o.skipHours && o.skipHours.has(b.hour)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 && o.morningThr != null ? o.morningThr : o.thr;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac * (o.weights ? (o.weights[c.sym] || 1) : 1);
        if (o.vixUp != null && vix && vix.get(c.b.d) >= o.vixUp) frac *= 1.5;
        const size = equity * frac;
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
const rat = (s) => (s && s.dd < 0 ? s.tot / -s.dd : 0);
const ratio = (s) => rat(s).toFixed(2).padStart(5);

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false));
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const run = (cfg) => { const h = simulate(hourly, SYMS, cfg, true, vix), d = simulate(daily, SYMS, cfg, false, vix); return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] }; };
  const line = (name, r) => `  ${name.padEnd(26)} fit: h1 ${pct(r.s[0].tot)} ÷${ratio(r.s[0])} | d ${pct(r.s[2].tot, 7)} ÷${ratio(r.s[2])}   hold: h2 ${pct(r.s[1].tot)} ÷${ratio(r.s[1])} | d ${pct(r.s[3].tot, 7)} ÷${ratio(r.s[3])}`;
  const base = run(MONDAY);
  console.log("BASELINE — Monday stack");
  console.log(line("0.30 / morning 0.08 / exit 0.6", base));
  // a sweep: choose on FIT by return/DD summed over the two fit surfaces; report holdout of the winner vs baseline
  const sweep = (title, variants) => {
    console.log(`\n${title}`);
    const rows = variants.map(([name, cfg]) => ({ name, r: run(cfg) }));
    for (const x of rows) console.log(line(x.name, x.r));
    const fitScore = (r) => rat(r.s[0]) / rat(base.s[0]) + rat(r.s[2]) / rat(base.s[2]);
    const w = rows.slice().sort((a, z) => fitScore(z.r) - fitScore(a.r))[0];
    const hOk = rat(w.r.s[1]) >= rat(base.s[1]) * 0.98 && rat(w.r.s[3]) >= rat(base.s[3]) * 0.98;
    const same = /\(live\)/.test(w.name);
    console.log(`  → fit winner: ${w.name}${same ? " — the live setting" : ` — holdout ${hOk ? "CONFIRMS (return/DD held on both holdout surfaces)" : "REJECTS"}`}`);
  };
  sweep("A. EXIT LEVEL (bounce at session IBS >= x)", [["exit 0.5", { ...MONDAY, exitIbs: 0.5 }], ["exit 0.6 (live)", MONDAY], ["exit 0.7", { ...MONDAY, exitIbs: 0.7 }], ["exit 0.8", { ...MONDAY, exitIbs: 0.8 }]]);
  sweep("B. ENTRY THRESHOLD", [["thr 0.20", { ...MONDAY, thr: 0.20 }], ["thr 0.25", { ...MONDAY, thr: 0.25 }], ["thr 0.30 (live)", MONDAY], ["thr 0.35", { ...MONDAY, thr: 0.35 }], ["thr 0.40", { ...MONDAY, thr: 0.40 }]]);
  sweep("C. MORNING GATE (pre-11:00 threshold)", [["morning 0.08 (live)", MONDAY], ["morning 0.15", { ...MONDAY, morningThr: 0.15 }], ["morning off (0.30 all day)", { ...MONDAY, morningThr: null }]]);

  console.log("\nD. SYMBOL TILT — weights from FIT expectancy only");
  const edge = {};
  for (const s of SYMS) {
    const hasFit = daily[s][0].d < "2010-01-01";
    const r = hasFit ? simulate(daily, [s], { ...MONDAY, vixUp: null }, false, vix, FIT[0], FIT[1]) : simulate(hourly, [s], { ...MONDAY, vixUp: null }, true, vix, H_START, H_MID);
    edge[s] = r.trades.length ? r.trades.reduce((a, x) => a + x.ret, 0) / r.trades.length : 0;
  }
  const med = Object.values(edge).slice().sort((a, b) => a - b)[Math.floor(SYMS.length / 2)];
  const weights = Object.fromEntries(SYMS.map((s) => [s, Math.min(1.5, Math.max(0.5, med > 0 ? edge[s] / med : 1))]));
  console.log("  fit edge/trade: " + SYMS.map((s) => `${s} ${(edge[s] * 100).toFixed(2)}%`).join("  "));
  console.log("  weights (x12%): " + SYMS.map((s) => `${s} ${weights[s].toFixed(2)}`).join("  "));
  const tilt = run({ ...MONDAY, weights });
  console.log(line("flat 12% (live)", base));
  console.log(line("fit-expectancy tilt", tilt));
  const tOk = rat(tilt.s[1]) >= rat(base.s[1]) * 0.98 && rat(tilt.s[3]) >= rat(base.s[3]) * 0.98;
  console.log(`  → tilt on fit: h1 ÷DD ${ratio(tilt.s[0])} vs ${ratio(base.s[0])}, d ÷DD ${ratio(tilt.s[2])} vs ${ratio(base.s[2])}; holdout ${tOk ? "CONFIRMS" : "REJECTS"}`);

  console.log("\nE. KELLY — what the stack's own statistics imply for size (hourly 2y)");
  const tr = base.h.trades, w = tr.filter((x) => x.ret > 0), l = tr.filter((x) => x.ret <= 0);
  const p = w.length / tr.length, aw = w.reduce((a, x) => a + x.ret, 0) / w.length, al = -l.reduce((a, x) => a + x.ret, 0) / l.length;
  const b = aw / al, f = p - (1 - p) / b;
  console.log(`  WR ${(p * 100).toFixed(1)}%  avg win ${(aw * 100).toFixed(2)}%  avg loss ${(al * 100).toFixed(2)}%  payoff b ${b.toFixed(2)}`);
  console.log(`  full Kelly f* = p - (1-p)/b = ${(f * 100).toFixed(1)}% of equity per position   (live: 12%, 18% under stress)`);
  console.log(`  half Kelly ${(f / 2 * 100).toFixed(1)}% — expected growth ~75% of full Kelly's at roughly half the drawdown; quarter Kelly ${(f / 4 * 100).toFixed(1)}%`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
