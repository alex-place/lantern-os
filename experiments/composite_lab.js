/**
 * composite_lab.js — do the fixes perform better TOGETHER? (operator 2026-08-22:
 * "run backtest all categories to test the fixes actually performing better")
 *
 * Every change this weekend was validated alone. This runs the whole stack as
 * one configuration and breaks the result into categories.
 *
 * CONFIGS (all on the live-faithful analog: 9-name tradelist, 12% positions,
 * cap 5, gap-aware fills, 5bp entry + exit slippage, live trail schedule):
 *   LAST WEEK      — as it actually traded: IBS 0.15, early signal-exit (sell
 *                    once session IBS > 0.15), no floor, knife veto ON, 1-day
 *                    post-stop cooldown, IBS on the CONTAMINATED ruler (04:00-).
 *   SATURDAY AM    — after the first arming: 0.30, exit at IBS >= 0.6, floor
 *                    +1%, knife ON, cooldown 1, contaminated ruler.
 *   MONDAY (no fix)— all switches armed but the IBS ruler still contaminated.
 *   MONDAY FULL    — 0.30, exit 0.6, floor +1%, knife OFF, cooldown 0, no
 *                    entries 13:30-14:30, x1.5 when prior VIX >= 20, CLEAN
 *                    ruler (#3430). (The support-entry gate is unmodelable —
 *                    zones — and is omitted from every config.)
 *
 * SURFACES: hourly 2y halves + full (bars fetched WITH extended prints so the
 * ruler can be switched). The 26y daily two-window for the subset the daily
 * bars can express (threshold, exit, floor, knife, cooldown, stress).
 *
 * CATEGORIES for MONDAY FULL (hourly 2y, with SATURDAY AM beside it): by
 * symbol, exit reason, month, entry hour, VIX regime, market-wide vs single-
 * name washout.
 * Usage: node experiments/composite_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const BASE = { morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, sizeFrac: 0.12, maxConc: 5, timeoutS: 5 };
const CONFIGS = {
  "LAST WEEK": { ...BASE, thr: 0.15, exitIbs: 0.15, exitStrict: true, be: null, lock: 0, knife: true, cooldownS: 1, skipHours: null, stressVix: null, ruler: "all" },
  "SATURDAY AM": { ...BASE, thr: 0.30, exitIbs: 0.6, exitStrict: false, be: 0.01, lock: 0.01, knife: true, cooldownS: 1, skipHours: null, stressVix: null, ruler: "all" },
  "MONDAY (no IBS fix)": { ...BASE, thr: 0.30, exitIbs: 0.6, exitStrict: false, be: 0.01, lock: 0.01, knife: false, cooldownS: 0, skipHours: new Set([14]), stressVix: 20, ruler: "all" },
  "MONDAY FULL": { ...BASE, thr: 0.30, exitIbs: 0.6, exitStrict: false, be: 0.01, lock: 0.01, knife: false, cooldownS: 0, skipHours: new Set([14]), stressVix: 20, ruler: "rth" },
};

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
function macdKnife(bars) {
  const ema = (n) => { const k = 2 / (n + 1); let e = null; return bars.map((b) => (e = e == null ? b.c : b.c * k + e * (1 - k))); };
  const e12 = ema(12), e26 = ema(26);
  const macd = bars.map((_, i) => e12[i] - e26[i]);
  let sig = null;
  for (let i = 0; i < bars.length; i++) { sig = sig == null ? macd[i] : macd[i] * 0.2 + sig * 0.8; bars[i].hist = macd[i] - sig; bars[i].knife = i >= 35 && bars[i].hist < 0 && bars[i].hist < bars[i - 1].hist; }
}
function annotateHourly(bars) {
  let day = null, si = -1, rH = -Infinity, rL = Infinity, aH = -Infinity, aL = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; rH = -Infinity; rL = Infinity; aH = -Infinity; aL = Infinity; }
    b.startMin = ET_HM(b.t);
    b.rth = b.startMin >= 570 && b.startMin < 960;
    aH = Math.max(aH, b.h); aL = Math.min(aL, b.l);
    if (b.rth) { rH = Math.max(rH, b.h); rL = Math.min(rL, b.l); }
    b.si = si; b.d = d; b.runH_rth = rH; b.runL_rth = rL; b.runH_all = aH; b.runL_all = aL;
    b.closeMin = Math.min(960, b.startMin + 60); b.hour = Math.floor(b.closeMin / 60);
  }
  for (let i = 0; i < bars.length; i++) { const b = bars[i]; let j = i + 1; while (j < bars.length && !bars[j].rth) j++; b.isLast = b.rth && (j >= bars.length || bars[j].d !== b.d); }
  macdKnife(bars.filter((b) => b.rth));   // the knife reads regular-hours closes (the live 5m/15m series is RTH-dominated)
  return bars;
}
function annotateDaily(bars) {
  for (let i = 0; i < bars.length; i++) { const b = bars[i]; b.d = new Date(b.t).toISOString().slice(0, 10); b.si = i; b.rth = true; b.isLast = true; b.closeMin = 960; b.hour = 16; b.runH_rth = b.h; b.runL_rth = b.l; b.runH_all = b.h; b.runL_all = b.l; }
  macdKnife(bars);
  return bars;
}
const ibsOf = (b, ruler) => { const H = ruler === "all" ? b.runH_all : b.runH_rth, L = ruler === "all" ? b.runL_all : b.runL_rth; return H - L > 0 && Number.isFinite(H) && Number.isFinite(L) ? (b.c - L) / (H - L) : null; };
function priorCloseMap(dailyBars) { const m = new Map(); for (let i = 0; i + 1 < dailyBars.length; i++) m.set(dailyBars[i + 1].d, dailyBars[i].c); return m; }

function simulate(barsBySym, syms, cfg, intraday, vix) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if (b.rth) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  const spyIdx = new Map(barsBySym.SPY.map((b) => [b.t, b]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map(), stopBlock = new Map();
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
      if (exitPx == null && v != null) {
        const bounced = o.exitStrict ? v > o.exitIbs : v >= o.exitIbs;
        if (bounced) { exitPx = b.c * (1 - SLIP); reason = o.exitStrict ? "early_exit" : "bounce"; }
      }
      if (exitPx == null && b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, pnlEq: pos.qtyVal * (exitPx / pos.entry - 1), reason, hour: pos.hour, vixHi: pos.vixHi, mkt: pos.mkt, stressed: pos.stressed });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        if (reason === "stop" && o.cooldownS > 0) stopBlock.set(sym, b.si + o.cooldownS + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size < o.maxConc) {
      const cands = [];
      const spyB = spyIdx.get(t), spyIbs = spyB ? ibsOf(spyB, o.ruler) : null;
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || !b.rth || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        if (stopBlock.has(sym) && b.si < stopBlock.get(sym)) continue;
        if (o.skipHours && intraday && o.skipHours.has(b.hour)) continue;
        if (o.knife && b.knife) continue;
        const v = ibsOf(b, o.ruler);
        if (v == null) continue;
        const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
        if (v <= thr) cands.push({ sym, b, v, spyIbs });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const vp = vix ? vix.get(c.b.d) : null;
        const stressed = o.stressVix != null && vp != null && vp >= o.stressVix;
        const size = equity * o.sizeFrac * (stressed ? 1.5 : 1);
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx,
          hour: c.b.hour, vixHi: vp != null ? vp >= 20 : null, mkt: c.spyIbs != null ? c.spyIbs <= 0.5 : null, stressed });
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
  const months = (seg[seg.length - 1].t - seg[0].t) / 86400000 / 30.44;
  let peak = -Infinity, dd = 0;
  const byMonth = new Map();
  for (const p of seg) { peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1); const m = p.d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, {}); byMonth.get(m).last = p.equity; }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0; const rows = [];
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; rows.push({ m: ms[i], r }); if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length, geoM: Math.pow(1 + tot, 1 / months) - 1, rows };
}
const pct = (x, w = 6) => (x * 100).toFixed(1).padStart(w) + "%";
const ratio = (s) => (s && s.dd < 0 ? (s.tot / -s.dd).toFixed(2).padStart(5) : "  n/a");
const stat = (tr) => { if (!tr.length) return "n=   0"; const w = tr.filter((x) => x.ret > 0).length; return `n=${String(tr.length).padStart(4)} WR ${(w / tr.length * 100).toFixed(0).padStart(3)}% avg ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2).padStart(6)}%  net ${pct(tr.reduce((a, x) => a + x.pnlEq, 0) / 100, 6)}`; };

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) {
    hourly[s] = annotateHourly(await chart(s, "1h", nowSec - DAYS * 86400, true));
    daily[s] = annotateDaily(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000), false));
  }
  const vix = priorCloseMap(annotateDaily(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000), false)));
  const H_START = hourly.SPY.find((b) => b.rth).d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "hourly FULL 2y ", "daily fit 00-14", "daily holdout  "];

  console.log("THE STACK, CONFIG BY CONFIG");
  const results = {};
  for (const [name, cfg] of Object.entries(CONFIGS)) {
    const h = simulate(hourly, SYMS, cfg, true, vix), d = simulate(daily, SYMS, cfg, false, vix);
    const s = [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(h.curve, H_START, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)];
    results[name] = { h, d, s };
    console.log(`\n=== ${name} ===`);
    for (let i = 0; i < 5; i++) console.log(`  ${LABELS[i]}: tot ${pct(s[i].tot, 7)}  ${(s[i].geoM * 100).toFixed(2).padStart(5)}%/mo  DD ${pct(s[i].dd)}  tot÷DD ${ratio(s[i])}  worstMo ${pct(s[i].worst)}  negMo ${String(s[i].neg).padStart(2)}/${s[i].months}`);
    const w = h.trades.filter((x) => x.ret > 0).length;
    console.log(`  hourly 2y: ${h.trades.length} trades  WR ${(w / h.trades.length * 100).toFixed(0)}%  avg ${(h.trades.reduce((a, x) => a + x.ret, 0) / h.trades.length * 100).toFixed(2)}%/trade`);
  }

  const M = results["MONDAY FULL"], S = results["SATURDAY AM"];
  const group = (tr, key) => { const m = {}; for (const x of tr) { const k = key(x); if (k == null) continue; (m[k] = m[k] || []).push(x); } return m; };
  const table = (title, key, order) => {
    console.log(`\n${title}   (MONDAY FULL  |  SATURDAY AM)`);
    const a = group(M.h.trades, key), b = group(S.h.trades, key);
    const keys = order || [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) console.log(`  ${String(k).padEnd(12)} ${stat(a[k] || [])}   |   ${stat(b[k] || [])}`);
  };
  console.log("\nCATEGORIES (hourly 2y)");
  table("BY SYMBOL", (x) => x.sym);
  table("BY EXIT REASON", (x) => x.reason);
  table("BY ENTRY HOUR (bar close)", (x) => x.hour, [10, 11, 12, 13, 14, 15, 16]);
  table("BY VIX REGIME (prior close >= 20)", (x) => (x.vixHi == null ? null : x.vixHi ? "VIX>=20" : "VIX<20"));
  table("MARKET-WIDE vs SINGLE-NAME (SPY IBS <= 0.5 at entry)", (x) => (x.mkt == null ? null : x.mkt ? "market-wide" : "single-name"));
  table("STRESS-SIZED ENTRIES", (x) => (x.stressed ? "x1.5" : "x1.0"));
  console.log("\nBY MONTH (MONDAY FULL vs SATURDAY AM, hourly 2y)");
  const mm = M.s[2].rows, sm = S.s[2].rows;
  let line = "  ";
  for (let i = 0; i < mm.length; i++) { line += `${mm[i].m.slice(2)}: ${(mm[i].r * 100).toFixed(1).padStart(5)} vs ${(sm[i].r * 100).toFixed(1).padStart(5)}  `; if ((i + 1) % 4 === 0) { console.log(line); line = "  "; } }
  if (line.trim()) console.log(line);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
