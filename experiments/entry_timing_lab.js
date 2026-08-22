/**
 * entry_timing_lab.js — "the positions go negative first, then win: the trader
 * is not waiting" (operator, 2026-08-22)
 *
 * The operator's thesis, which every earlier lab held FIXED while it varied the
 * exits: entries are early. Evidence already pointing that way — live fills
 * +0.09% above the analog's close entries (#3419), first-touch entries
 * 0.06-0.15% above the eventual close (#3411), 37% of trades touch -1% before
 * resolving (#3415). The stop sweeps that rejected tighter stops kept the early
 * entry; a later entry is precisely what would make a tight stop survivable.
 *
 * PART 1 — HOW OFTEN DOES A WINNER GO NEGATIVE FIRST? On the Monday config:
 *   the adverse-excursion (MAE) distribution of winners and losers — share that
 *   dipped ≤ -0.25% / -0.5% / -1% before resolving, median MAE, bars to the low.
 *
 * PART 2 — LATER ENTRIES × STOP WIDTH. Entry modes:
 *   touch   — first bar close with session IBS ≤ 0.30 (the live rule)
 *   confirm — after a touch, the first subsequent bar that closes ABOVE the
 *             prior bar's close (the reversal has started); missed if session
 *             IBS is already ≥ 0.6 or the window expires (6 bars)
 *   deeper  — session IBS ≤ 0.15 (wait for a deeper washout)
 *   limit   — after a touch, a resting limit 0.5% below the touch close,
 *             filled if the session trades there; else no trade
 *   each × stop 3% / 2% / 1.5%, with the Monday exits (trail, +1% floor,
 *   IBS ≥ 0.6 bounce). Reported on the four surfaces plus the MAE shift:
 *   did the later entry actually reduce the adverse excursion?
 *
 * Daily bars express touch/confirm/deeper (confirm = next day closes up);
 * limit is intraday-only. Costs charged (5bp entry + exit), gap-aware fills.
 * Usage: node experiments/entry_timing_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, entry: "touch" };

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
    b.prevC = i ? bars[i - 1].c : b.c;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);

function simulate(barsBySym, syms, cfg, intraday) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map(), armed = new Map();      // sym -> {touchC, si, bars}
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  const ibsOf = (b) => (intraday ? rIbs(b) : dIbs(b));
  for (const t of timeline) {
    const d = ET_DAY(t);
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b || b.t <= pos.entryT) continue;
      pos.bars++;
      if (b.l / pos.entry - 1 < pos.mae) { pos.mae = b.l / pos.entry - 1; pos.maeBar = pos.bars; }
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
      const ibsV = ibsOf(b);
      if (exitPx == null) {
        if (ibsV >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, mae: pos.mae, maeBar: pos.maeBar });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    // ── entries by mode ──────────────────────────────────────────────────────
    const cands = [];
    for (const sym of syms) {
      const b = idx[sym].get(t);
      if (!b || b.si === 0) continue;
      const v = ibsOf(b);
      const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
      if (open.has(sym)) { armed.delete(sym); continue; }
      if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
      if (o.entry === "touch") { if (v <= thr) cands.push({ sym, b, v, px: b.c }); continue; }
      if (o.entry === "deeper") { if (v <= Math.min(thr, 0.15)) cands.push({ sym, b, v, px: b.c }); continue; }
      // armed modes: a touch arms the symbol; the entry comes on a later bar
      const a = armed.get(sym);
      if (a) {
        a.bars++;
        const expired = a.bars > (intraday ? 6 : 2) || v >= o.exitIbs;     // bounce already done, or window over
        if (o.entry === "confirm") {
          if (!expired && b.c > b.prevC && b.t > a.t) { cands.push({ sym, b, v, px: b.c }); armed.delete(sym); continue; }
        } else if (o.entry === "limit") {
          const lim = a.touchC * (1 - 0.005);
          if (b.si === a.si && b.t > a.t && b.l <= lim) { cands.push({ sym, b, v, px: Math.min(lim, b.o) }); armed.delete(sym); continue; }
          if (b.si !== a.si) { armed.delete(sym); }
        }
        if (expired) armed.delete(sym);
      }
      if (v <= thr && !armed.has(sym)) armed.set(sym, { touchC: b.c, si: b.si, t: b.t, bars: 0 });
    }
    if (open.size < o.maxConc) {
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.px * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx, mae: 0, maeBar: 0, bars: 0 });
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
function verdict(base, v) {
  if (!base || !v) return "n/a";
  const lossBetter = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg);
  const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot;
  return `${lossBetter}/3 loss better, total ${keeps ? "kept" : "SACRIFICED"}${lossBetter >= 2 && keeps ? "  << PASS" : ""}`;
}
function maeStats(tr) {
  const w = tr.filter((x) => x.ret > 0), l = tr.filter((x) => x.ret <= 0);
  const share = (arr, thr) => (arr.length ? arr.filter((x) => x.mae <= thr).length / arr.length : 0);
  const med = (arr, k) => { const v = arr.map((x) => x[k]).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  return { n: tr.length, wr: w.length / (tr.length || 1),
    w25: share(w, -0.0025), w50: share(w, -0.005), w100: share(w, -0.01), wMed: med(w, "mae"), wBar: med(w, "maeBar"),
    l100: share(l, -0.01), avgW: w.reduce((a, x) => a + x.ret, 0) / (w.length || 1), avgL: l.reduce((a, x) => a + x.ret, 0) / (l.length || 1) };
}

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (cfg) => {
    const h = simulate(hourly, SYMS, cfg, true), d = simulate(daily, SYMS, cfg, false);
    return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] };
  };

  const base = run(MONDAY);
  console.log("PART 1 — DO WINNERS GO NEGATIVE FIRST? (Monday config)");
  for (const [label, tr] of [["hourly 2y", base.h.trades], ["daily 26y", base.d.trades]]) {
    const m = maeStats(tr);
    console.log(`  ${label}: ${m.n} trades, WR ${(m.wr * 100).toFixed(0)}%`);
    console.log(`    winners that first dipped ≤ -0.25%: ${(m.w25 * 100).toFixed(0)}%   ≤ -0.5%: ${(m.w50 * 100).toFixed(0)}%   ≤ -1.0%: ${(m.w100 * 100).toFixed(0)}%   median winner MAE ${(m.wMed * 100).toFixed(2)}% reached after ${m.wBar} bar(s)`);
    console.log(`    losers that dipped ≤ -1.0%: ${(m.l100 * 100).toFixed(0)}%   avg win ${(m.avgW * 100).toFixed(2)}%  avg loss ${(m.avgL * 100).toFixed(2)}%`);
  }
  console.log("");

  console.log("PART 2 — LATER ENTRIES × STOP WIDTH (Monday exits; verdict vs the Monday config)");
  for (const entry of ["touch", "confirm", "deeper", "limit"]) {
    for (const stopPct of [0.03, 0.02, 0.015]) {
      if (entry === "touch" && stopPct === 0.03) continue;   // that is the baseline
      const r = run({ ...MONDAY, entry, stopPct });
      const mh = maeStats(r.h.trades);
      console.log(`  entry=${entry.padEnd(7)} stop ${(stopPct * 100).toFixed(1)}%   hourly: ${mh.n} trades WR ${(mh.wr * 100).toFixed(0)}%  winners dipped ≤-0.5%: ${(mh.w50 * 100).toFixed(0)}%  avg win ${(mh.avgW * 100).toFixed(2)}% / loss ${(mh.avgL * 100).toFixed(2)}%`);
      for (let i = 0; i < 4; i++) {
        if (!r.s[i]) { console.log(`    ${LABELS[i]}: n/a`); continue; }
        console.log(`    ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
      }
    }
  }
  const mb = maeStats(base.h.trades);
  console.log(`\n  baseline (touch, 3%): hourly ${mb.n} trades WR ${(mb.wr * 100).toFixed(0)}%  winners dipped ≤-0.5%: ${(mb.w50 * 100).toFixed(0)}%  avg win ${(mb.avgW * 100).toFixed(2)}% / loss ${(mb.avgL * 100).toFixed(2)}%`);
  for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
