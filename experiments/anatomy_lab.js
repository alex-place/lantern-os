/**
 * anatomy_lab.js — "why does it only make 1% a month? where is it losing? the
 * max loss is too high relative to the gains." (operator, 2026-08-22)
 *
 * The Monday config (IBS 0.30, morning 0.08, 3% stop, trail, floor +1%, exit
 * at IBS ≥ 0.6) taken apart on the live-faithful analog:
 *
 *   1. THE ARITHMETIC — return/month = trades/month × edge/trade × position
 *      fraction. Which factor is small, and what moves it.
 *   2. P&L BY EXIT REASON — gross won / gross lost in equity terms: where the
 *      profit is made and where it leaks.
 *   3. P&L BY SYMBOL — who earns, who is dead weight.
 *   4. THE DRAWDOWN EPISODE — peak → trough → recovery dates, stops inside it,
 *      SPY over the same window: is the drawdown a market correction or a
 *      strategy failure?
 *   5. THE RISK FRONTIER — levers on top of the new config, each scored on
 *      return, drawdown and return/drawdown, on every surface: drop the
 *      dead-weight symbols, flatten at the close (no overnight), cap 3,
 *      smaller positions, regime-half sizing, and combinations. No ship rule
 *      here: this is the menu of trade-offs, with the numbers attached.
 *
 * Usage: node experiments/anatomy_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5 };

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
    b.isLast = intraday ? (i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d) : true;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
function regimeMap(spyDaily) {
  const m = new Map(); let acc = 0;
  for (let i = 0; i < spyDaily.length; i++) {
    acc += spyDaily[i].c; if (i >= 200) acc -= spyDaily[i - 200].c;
    const above = i >= 199 ? spyDaily[i].c > acc / 200 : true;
    if (i + 1 < spyDaily.length) m.set(spyDaily[i + 1].d, above);
  }
  return m;
}

function simulate(barsBySym, syms, cfg, intraday, regime) {
  const o = { timeoutS: 5, flattenEod: false, regimeHalf: null, ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  let busyBars = 0;
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
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (ibsV >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (o.flattenEod && b.isLast) { exitPx = b.c * (1 - SLIP); reason = "eod_flat"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        const pnlEq = pos.qtyVal * (exitPx / pos.entry - 1);   // in starting-equity units (≈ equity %)
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, entryD: pos.entryD, ret: exitPx / pos.entry - 1, pnlEq, reason, sessions: b.si - pos.entrySi, gap: b.o < pos.stopPx && reason === "stop" });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size) busyBars++;
    if (open.size < o.maxConc) {
      const cands = [];
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        if (o.flattenEod && b.isLast) continue;                 // never open into the close when flattening
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac;
        if (o.regimeHalf != null && regime && regime.get(d) === false) frac *= o.regimeHalf;
        const size = equity * frac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, entryD: c.b.d, peak: entryPx });
      }
    }
    curve.push({ t, d, equity, open: open.size });
  }
  return { curve, trades, finalEquity: curve[curve.length - 1].equity, busyFrac: busyBars / timeline.length };
}
function score(curve, from, to) {
  const seg = curve.filter((p) => p.d >= from && p.d < to);
  if (seg.length < 10) return null;
  const tot = seg[seg.length - 1].equity / seg[0].equity - 1;
  const months = (seg[seg.length - 1].t - seg[0].t) / 86400000 / 30.44;
  let peak = -Infinity, peakI = 0, dd = 0, ddPeakI = 0, ddTroughI = 0;
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].equity > peak) { peak = seg[i].equity; peakI = i; }
    const x = seg[i].equity / peak - 1;
    if (x < dd) { dd = x; ddPeakI = peakI; ddTroughI = i; }
  }
  let recI = -1;
  for (let i = ddTroughI; i < seg.length; i++) if (seg[i].equity >= seg[ddPeakI].equity) { recI = i; break; }
  const byMonth = new Map();
  for (const p of seg) { const m = p.d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, {}); byMonth.get(m).last = p.equity; }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length, geoM: Math.pow(1 + tot, 1 / months) - 1,
    ddPeakD: seg[ddPeakI].d, ddTroughD: seg[ddTroughI].d, ddRecD: recI >= 0 ? seg[recI].d : null, avgOpen: seg.reduce((a, p) => a + p.open, 0) / seg.length };
}
const pct = (x, w = 6) => (x * 100).toFixed(1).padStart(w) + "%";

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  const regD = regimeMap(daily.SPY);
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];

  const h = simulate(hourly, SYMS, MONDAY, true, regD);
  const dd = simulate(daily, SYMS, MONDAY, false, regD);
  const sH = score(h.curve, H_START, H_END), sD = score(dd.curve, ...HOLD);

  // ── 1. ARITHMETIC ─────────────────────────────────────────────────────────
  console.log("1. THE ARITHMETIC (hourly 2y, Monday config)");
  const months = (h.curve[h.curve.length - 1].t - h.curve[0].t) / 86400000 / 30.44;
  const avgRet = h.trades.reduce((a, x) => a + x.ret, 0) / h.trades.length;
  const wins = h.trades.filter((x) => x.ret > 0), losses = h.trades.filter((x) => x.ret <= 0);
  console.log(`  trades ${h.trades.length} over ${months.toFixed(1)} months = ${(h.trades.length / months).toFixed(1)} trades/month`);
  console.log(`  edge per trade ${(avgRet * 100).toFixed(3)}%  (winners ${(wins.length / h.trades.length * 100).toFixed(0)}% avg ${(wins.reduce((a, x) => a + x.ret, 0) / wins.length * 100).toFixed(2)}%  |  losers ${(losses.length / h.trades.length * 100).toFixed(0)}% avg ${(losses.reduce((a, x) => a + x.ret, 0) / losses.length * 100).toFixed(2)}%)`);
  console.log(`  position ${(MONDAY.sizeFrac * 100).toFixed(0)}% of equity  → ${(h.trades.length / months).toFixed(1)} × ${(avgRet * 100).toFixed(3)}% × ${MONDAY.sizeFrac} ≈ ${(h.trades.length / months * avgRet * MONDAY.sizeFrac * 100).toFixed(2)}%/month (measured ${(sH.geoM * 100).toFixed(2)}%)`);
  console.log(`  deployment: a position is open ${(h.busyFrac * 100).toFixed(0)}% of bars; avg ${sH.avgOpen.toFixed(2)} of ${MONDAY.maxConc} slots in use → avg ${(sH.avgOpen * MONDAY.sizeFrac * 100).toFixed(0)}% of equity at work, ${(100 - sH.avgOpen * MONDAY.sizeFrac * 100).toFixed(0)}% idle\n`);

  // ── 2. BY EXIT REASON ─────────────────────────────────────────────────────
  const byReason = (tr) => {
    const m = {};
    for (const x of tr) { const r = m[x.reason] = m[x.reason] || { n: 0, won: 0, lost: 0, gapN: 0 }; r.n++; if (x.pnlEq >= 0) r.won += x.pnlEq; else r.lost += x.pnlEq; if (x.gap) r.gapN++; }
    return m;
  };
  for (const [label, tr] of [["hourly 2y", h.trades], ["daily holdout 2015–", dd.trades.filter((x) => x.d >= "2015-01-01")]]) {
    console.log(`2. P&L BY EXIT REASON (${label}, in % of starting equity)`);
    const m = byReason(tr);
    const gw = Object.values(m).reduce((a, r) => a + r.won, 0), gl = Object.values(m).reduce((a, r) => a + r.lost, 0);
    console.log("  reason      n     won      lost      net     share of all losses");
    for (const [k, r] of Object.entries(m).sort((a, z) => a[1].lost - z[1].lost))
      console.log(`  ${k.padEnd(9)} ${String(r.n).padStart(5)}  ${pct(r.won / 100, 6)}  ${pct(r.lost / 100, 7)}  ${pct((r.won + r.lost) / 100, 7)}   ${gl ? (r.lost / gl * 100).toFixed(0).padStart(3) : "  0"}%${r.gapN ? `   (${r.gapN} filled through a gap)` : ""}`);
    console.log(`  TOTAL            ${pct(gw / 100, 6)}  ${pct(gl / 100, 7)}  ${pct((gw + gl) / 100, 7)}   profit factor ${gl ? (gw / -gl).toFixed(2) : "inf"}\n`);
  }

  // ── 3. BY SYMBOL ──────────────────────────────────────────────────────────
  console.log("3. P&L BY SYMBOL (hourly 2y): n / net / stops / avg ret");
  const bs = {};
  for (const x of h.trades) { const r = bs[x.sym] = bs[x.sym] || { n: 0, net: 0, stops: 0, ret: 0 }; r.n++; r.net += x.pnlEq; r.ret += x.ret; if (x.reason === "stop") r.stops++; }
  for (const [k, r] of Object.entries(bs).sort((a, z) => z[1].net - a[1].net))
    console.log(`  ${k.padEnd(5)} ${String(r.n).padStart(4)}  ${pct(r.net / 100, 6)}  ${String(r.stops).padStart(3)} stops  avg ${(r.ret / r.n * 100).toFixed(2)}%`);
  console.log("");

  // ── 4. THE DRAWDOWN EPISODE ───────────────────────────────────────────────
  console.log("4. THE DRAWDOWN EPISODE (hourly 2y)");
  console.log(`  peak ${sH.ddPeakD} → trough ${sH.ddTroughD} (${pct(sH.dd)}) → recovered ${sH.ddRecD || "not yet"}`);
  const inDD = h.trades.filter((x) => x.d >= sH.ddPeakD && x.d <= sH.ddTroughD);
  const ddStops = inDD.filter((x) => x.reason === "stop");
  const spyH = hourly.SPY, spyAt = (d) => { const b = spyH.find((x) => x.d >= d); return b ? b.c : null; };
  const spyMove = spyAt(sH.ddTroughD) / spyAt(sH.ddPeakD) - 1;
  console.log(`  inside it: ${inDD.length} trades, ${ddStops.length} full stop-outs (${ddStops.filter((x) => x.gap).length} through gaps) costing ${pct(ddStops.reduce((a, x) => a + x.pnlEq, 0) / 100)}; SPY moved ${pct(spyMove)} over the same window`);
  const ddSyms = {};
  for (const x of ddStops) ddSyms[x.sym] = (ddSyms[x.sym] || 0) + 1;
  console.log(`  stop-outs by symbol: ${JSON.stringify(ddSyms)}`);
  console.log(`  daily holdout worst episode: ${sD.ddPeakD} → ${sD.ddTroughD} (${pct(sD.dd)}) → recovered ${sD.ddRecD || "not yet"}\n`);

  // ── 5. THE RISK FRONTIER ──────────────────────────────────────────────────
  console.log("5. THE RISK FRONTIER — levers on top of the Monday config (no ship rule; the menu)");
  console.log("  lever                              hourly 2y: tot / DD / tot÷DD / worstMo    daily holdout: tot / DD / tot÷DD      daily fit: tot / DD");
  const LEVERS = [
    ["Monday config (reference)", SYMS, {}],
    ["drop SPY + DIA (dead weight)", SYMS.filter((s) => s !== "SPY" && s !== "DIA"), {}],
    ["flatten at the close (no overnight)", SYMS, { flattenEod: true }],
    ["cap 3 instead of 5", SYMS, { maxConc: 3 }],
    ["positions 8% instead of 12%", SYMS, { sizeFrac: 0.08 }],
    ["half size below SPY 200d", SYMS, { regimeHalf: 0.5 }],
    ["stop 4% (wider, fewer gap stop-outs)", SYMS, { stopPct: 0.04 }],
    ["drop SPY+DIA AND half size below 200d", SYMS.filter((s) => s !== "SPY" && s !== "DIA"), { regimeHalf: 0.5 }],
    ["leveraged only (SOXL SMH QQQ XLK)", ["SOXL", "SMH", "QQQ", "XLK"], {}],
  ];
  for (const [name, syms, extra] of LEVERS) {
    const cfg = { ...MONDAY, ...extra };
    const hh = simulate(hourly, syms, cfg, true, regD), ddd = simulate(daily, syms, cfg, false, regD);
    const a = score(hh.curve, H_START, H_END), b = score(ddd.curve, ...HOLD), c = score(ddd.curve, ...FIT);
    const ratio = (s) => (s && s.dd < 0 ? (s.tot / -s.dd).toFixed(2).padStart(5) : "  n/a");
    console.log(`  ${name.padEnd(36)} ${pct(a.tot)} ${pct(a.dd)} ${ratio(a)} ${pct(a.worst)}      ${pct(b.tot, 7)} ${pct(b.dd)} ${ratio(b)}      ${pct(c.tot, 7)} ${pct(c.dd)}`);
  }
  console.log("\n  tot÷DD = return per unit of max drawdown over the window (higher = better risk-adjusted).");
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
