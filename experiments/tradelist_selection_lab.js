/**
 * tradelist_selection_lab.js — the tradelist is the lever (anatomy lab, 2026-08-22)
 *
 * The anatomy of the Monday config says: per-trade edge is a scalp (+0.10%),
 * 70% of capital sits idle, and on the recent 2y SOXL supplies essentially the
 * whole profit while TLT/GLD/SPY/QQQ/XLK net ≤ 0. Every DEFENSIVE lever (cap 3,
 * smaller size, regime-half) cuts return as much as drawdown — the return/DD
 * ratio is structural to a long-only washout book. SYMBOL SELECTION is the one
 * lever that moved the ratio (2.1 → 4–5).
 *
 * Done properly: choose the book on FIT surfaces only, score once on holdout.
 *   - candidates: the live 9 + the 9 peers from the universe lab (18).
 *   - each symbol's FIT expectancy: daily 2000–2014 when it has that history,
 *     else (leveraged names list ~2009–2012) the hourly FIRST half. A symbol is
 *     kept if its fit expectancy ≥ MIN_EDGE per trade (0.10% — the Monday
 *     book's own average; below that a symbol dilutes the book).
 *   - the selected book vs the live 9 on the HOLDOUT surfaces (hourly 2nd half,
 *     daily 2015–), reporting total, DD, return/DD, worst month.
 *   - concentration check: the selected book's stop-outs by symbol inside its
 *     worst drawdown, and how many distinct sectors it spans.
 *
 * Usage: node experiments/tradelist_selection_lab.js [--days 720] [--min-edge 0.001]
 */
"use strict";

const https = require("https");

const LIVE9 = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const PEERS = ["XLF", "XLE", "XLV", "XLI", "EEM", "EFA", "TQQQ", "UPRO", "TNA"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5 };

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

function simulate(barsBySym, syms, cfg, intraday, from, to) {
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
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (ibsV >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
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
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
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
  let peak = -Infinity, peakI = 0, dd = 0, ddPeakI = 0, ddTroughI = 0;
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].equity > peak) { peak = seg[i].equity; peakI = i; }
    const x = seg[i].equity / peak - 1;
    if (x < dd) { dd = x; ddPeakI = peakI; ddTroughI = i; }
  }
  const byMonth = new Map();
  for (const p of seg) { const m = p.d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, {}); byMonth.get(m).last = p.equity; }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length, ddPeakD: seg[ddPeakI].d, ddTroughD: seg[ddTroughI].d };
}
const pct = (x, w = 6) => (x * 100).toFixed(1).padStart(w) + "%";
const ratio = (s) => (s && s.dd < 0 ? (s.tot / -s.dd).toFixed(2).padStart(5) : "  n/a");

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const MIN_EDGE = args.includes("--min-edge") ? Number(args[args.indexOf("--min-edge") + 1]) : 0.001;
  const nowSec = Math.floor(Date.now() / 1000);
  const ALL = [...LIVE9, ...PEERS];
  const hourly = {}, daily = {};
  for (const s of ALL) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];

  // ── per-symbol FIT expectancy, each symbol traded alone (no cap contention) ─
  console.log(`PER-SYMBOL EXPECTANCY ON ITS FIT SURFACE (Monday rules, symbol alone; keep if ≥ ${(MIN_EDGE * 100).toFixed(2)}%/trade)`);
  console.log("  sym    fit surface       n    avg/trade   verdict");
  const keep = [], drop = [];
  for (const s of ALL) {
    const hasFit = daily[s][0].d < "2010-01-01";       // enough of 2000–2014 to be a fit window
    const r = hasFit ? simulate(daily, [s], MONDAY, false, FIT[0], FIT[1]) : simulate(hourly, [s], MONDAY, true, H_START, H_MID);
    const n = r.trades.length, avg = n ? r.trades.reduce((a, x) => a + x.ret, 0) / n : 0;
    const ok = n >= 30 && avg >= MIN_EDGE;
    (ok ? keep : drop).push(s);
    console.log(`  ${s.padEnd(5)}  ${(hasFit ? "daily 2000-14" : "hourly 1st half").padEnd(16)} ${String(n).padStart(4)}   ${(avg * 100).toFixed(3).padStart(7)}%   ${ok ? "KEEP" : "drop"}${LIVE9.includes(s) ? "" : "   (peer)"}`);
  }
  console.log(`\n  selected book (${keep.length}): ${keep.join(" ")}`);
  console.log(`  dropped (${drop.length}): ${drop.join(" ")}\n`);

  // ── books on HOLDOUT surfaces ─────────────────────────────────────────────
  console.log("BOOKS ON THE HOLDOUT SURFACES (chosen on fit, scored once here)");
  console.log("  book                         hourly 2nd half: tot / DD / tot÷DD / worstMo     daily 2015–: tot / DD / tot÷DD / worstMo");
  const live7 = LIVE9.filter((s) => keep.includes(s));
  const books = [["live 9 (reference)", LIVE9], ["selected by fit expectancy", keep], ["live 9 minus its dropped names", live7],
    // POST-HOC candidate (not fit-chosen — the leveraged family carries the edge on every surface of the universe lab;
    // it needs forward confirmation, not a ship decision): the pruned live book plus the three leveraged index peers.
    ["live 7 + TQQQ/UPRO/TNA (post-hoc)", [...live7, "TQQQ", "UPRO", "TNA"]]];
  const results = {};
  for (const [name, syms] of books) {
    const h = simulate(hourly, syms, MONDAY, true), d = simulate(daily, syms, MONDAY, false);
    const a = score(h.curve, H_MID, H_END), b = score(d.curve, ...HOLD);
    results[name] = { h, d, a, b };
    console.log(`  ${name.padEnd(28)} ${pct(a.tot)} ${pct(a.dd)} ${ratio(a)} ${pct(a.worst)}        ${pct(b.tot, 7)} ${pct(b.dd)} ${ratio(b)} ${pct(b.worst)}`);
  }
  // also the full hourly 2y and fit for completeness (fit is in-sample for the selection — labelled)
  console.log("\n  (in-sample, for completeness)  hourly FULL 2y: tot / DD        daily fit 2000-14: tot / DD");
  for (const [name, syms] of books) {
    const a = score(results[name].h.curve, H_START, H_END), c = score(results[name].d.curve, ...FIT);
    console.log(`  ${name.padEnd(28)} ${pct(a.tot)} ${pct(a.dd)}               ${pct(c.tot, 7)} ${pct(c.dd)}`);
  }

  // ── concentration check on the selected book ──────────────────────────────
  const sel = results["selected by fit expectancy"];
  const b = sel.b;
  const inDD = sel.d.trades.filter((x) => x.d >= b.ddPeakD && x.d <= b.ddTroughD && x.reason === "stop");
  const bySym = inDD.reduce((m, x) => ((m[x.sym] = (m[x.sym] || 0) + 1), m), {});
  console.log(`\nCONCENTRATION — selected book, daily holdout worst drawdown ${b.ddPeakD} → ${b.ddTroughD} (${pct(b.dd)}): stop-outs by symbol ${JSON.stringify(bySym)}`);
  const fam = { SOXL: "semis3x", SMH: "semis", TQQQ: "nasdaq3x", QQQ: "nasdaq", XLK: "tech", UPRO: "spx3x", SPY: "spx", DIA: "dow", TNA: "r2k3x", IWM: "r2k", GLD: "gold", TLT: "bonds", XLF: "fin", XLE: "energy", XLV: "health", XLI: "indust", EEM: "EM", EFA: "intl" };
  console.log(`  families in the selected book: ${[...new Set(keep.map((s) => fam[s] || s))].join(", ")}`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
