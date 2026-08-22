/**
 * rr_volscale_lab.js — reward:risk and "move size" (operator, 2026-08-22)
 *
 *   "the take-profit / stop ratios are not working — it does not maintain 2:1 or
 *    3:1 on every trade; the stop should be 2-3x smaller than the take profit;
 *    maybe the take profits are too high and do not get reached; the trader
 *    does not understand move sizes as well as we do."
 *
 * PART A — FIXED REWARD:RISK PER TRADE, taken literally. Stop S, hard take-
 *   profit at k×S (limit fill at the level), timeout 5 — no bounce exit, no
 *   floor, so the ratio is exactly what the operator describes. Grid S ∈
 *   {1, 1.5, 2, 3}%, k ∈ {2, 3}. The question is not whether 2:1 is a good
 *   ratio in the abstract; it is whether the washout signal produces moves of
 *   2-3 stops. Win rate × size tells.
 *
 * PART B — MOVE SIZE, the measurable form: VOLATILITY SCALING. The bounce a
 *   washout produces scales with the instrument's range (SOXL's ATR is ~5x
 *   SPY's). The Monday config uses a FLAT +1% floor and FLAT 3% stop for every
 *   symbol — too high a target for SPY (rarely reached), too low for SOXL
 *   (leaves the move). Variant: floor = f × ATR%, stop = s × ATR% (ATR14 of
 *   DAILY bars through the PRIOR session — no look-ahead), clamped to sane
 *   bounds, bounce exit as Monday. (f, s) chosen on the FIT surfaces, scored
 *   once on holdout. Per-symbol ATR% printed so the move-size spread is visible.
 *
 * Baseline: the Monday config (0.30 / morning 0.08 / 3% stop / trail / floor
 * +1% / exit at IBS ≥ 0.6), live-faithful analog, costs charged.
 * Usage: node experiments/rr_volscale_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
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
/** date -> ATR14% of the PRIOR session (no look-ahead). */
function atrMap(dailyBars) {
  const m = new Map(); const tr = [];
  for (let i = 0; i < dailyBars.length; i++) {
    const b = dailyBars[i], pc = i ? dailyBars[i - 1].c : b.c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    if (i >= 14 && i + 1 < dailyBars.length) {
      const a = tr.slice(i - 13, i + 1).reduce((x, y) => x + y, 0) / 14;
      m.set(dailyBars[i + 1].d, a / b.c);
    }
  }
  return m;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function simulate(barsBySym, syms, cfg, intraday, atr) {
  const o = { hardTp: null, volF: null, volS: null, ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
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
          if (pos.tpPx && b.h >= pos.tpPx) { reason = "take_profit"; exitPx = Math.max(pos.tpPx, Math.min(b.o, b.h)); break; }   // limit fill at the level (or a better open)
          if (pos.be != null && b.h >= pos.entry * (1 + pos.be)) { const want = pos.entry * (1 + pos.lock); if (pos.stopPx < want) pos.stopPx = want; }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (px <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.trail && !pos.tpPx) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (o.exitIbs != null && ibsV >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
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
        // per-trade geometry: flat, or scaled to the symbol's prior-session ATR%
        let stopPct = o.stopPct, be = o.be, lock = o.lock;
        if (o.volS != null) {
          const a = atr && atr[c.sym] ? atr[c.sym].get(c.b.d) : null;
          if (a == null) continue;                              // no ATR yet (warm-up) — skip
          stopPct = clamp(o.volS * a, 0.015, 0.08);
          const fl = clamp(o.volF * a, 0.004, 0.04);
          be = fl; lock = fl;
        }
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx,
          be, lock, tpPx: o.hardTp ? entryPx * (1 + o.hardTp * stopPct) : null });
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

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {}, atr = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
    atr[s] = atrMap(daily[s]);
  }
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (cfg) => {
    const h = simulate(hourly, SYMS, cfg, true, atr), d = simulate(daily, SYMS, cfg, false, atr);
    return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] };
  };
  const base = run(MONDAY);
  console.log("BASELINE — Monday config");
  for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}  negMo ${base.s[i].neg}/${base.s[i].months}`);
  const stats = (tr) => { const w = tr.filter((x) => x.ret > 0), l = tr.filter((x) => x.ret <= 0); return `WR ${(w.length / tr.length * 100).toFixed(0)}%  avg win ${(w.reduce((a, x) => a + x.ret, 0) / (w.length || 1) * 100).toFixed(2)}%  avg loss ${(l.reduce((a, x) => a + x.ret, 0) / (l.length || 1) * 100).toFixed(2)}%  realized R:R ${(Math.abs(w.reduce((a, x) => a + x.ret, 0) / (w.length || 1)) / Math.abs(l.reduce((a, x) => a + x.ret, 0) / (l.length || 1) || 1)).toFixed(2)}:1`; };
  console.log(`  hourly 2y: ${stats(base.h.trades)}\n`);

  // ── PART A: fixed reward:risk ──────────────────────────────────────────────
  console.log("PART A — FIXED REWARD:RISK PER TRADE (hard TP at k×stop, no bounce exit, no floor)");
  for (const S of [0.01, 0.015, 0.02, 0.03]) for (const k of [2, 3]) {
    const r = run({ ...MONDAY, stopPct: S, hardTp: k, be: null, lock: 0, exitIbs: null, trail: null });
    console.log(`  stop ${(S * 100).toFixed(1)}% / TP ${(S * k * 100).toFixed(1)}% (${k}:1)`);
    for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}   ${verdict(base.s[i], r.s[i])}`);
    const tp = r.h.trades.filter((x) => x.reason === "take_profit").length;
    console.log(`    hourly 2y: ${stats(r.h.trades)}  — TP reached on ${(tp / r.h.trades.length * 100).toFixed(0)}% of trades`);
  }
  console.log("");

  // ── PART B: volatility-scaled floor and stop ──────────────────────────────
  console.log("PART B — MOVE SIZE: floor and stop as multiples of each symbol's prior-session ATR14%");
  const avgAtr = (s) => { const v = [...atr[s].entries()].filter(([d]) => d >= "2024-09-01").map(([, a]) => a); return v.reduce((a, x) => a + x, 0) / v.length; };
  console.log("  ATR% (last 2y avg): " + SYMS.map((s) => `${s} ${(avgAtr(s) * 100).toFixed(2)}%`).join("  "));
  console.log("  → flat +1% floor / 3% stop = " + SYMS.map((s) => `${s} ${(0.01 / avgAtr(s)).toFixed(2)}/${(0.03 / avgAtr(s)).toFixed(2)} ATR`).join("  "));
  const grid = [];
  for (const f of [0.25, 0.33, 0.5]) for (const s of [0.75, 1.0, 1.5]) {
    const r = run({ ...MONDAY, volF: f, volS: s });
    const fitOk = /PASS/.test(verdict(base.s[0], r.s[0])) && /PASS/.test(verdict(base.s[2], r.s[2]));
    grid.push({ key: `floor ${f}×ATR / stop ${s}×ATR`, r, fitOk, fitTot: r.s[2].tot + r.s[0].tot });
    console.log(`  floor ${f}×ATR / stop ${s}×ATR`);
    for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
    console.log(`    hourly 2y: ${stats(r.h.trades)}`);
  }
  const ok = grid.filter((g) => g.fitOk).sort((a, z) => z.fitTot - a.fitTot);
  console.log(`\n  ${ok.length}/${grid.length} pass both FIT surfaces.`);
  if (ok.length) {
    const w = ok[0];
    console.log(`  FIT WINNER: ${w.key}`);
    for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(w.r.s[i].tot, 7)}  DD ${pct(w.r.s[i].dd)}  tot÷DD ${ratio(w.r.s[i])}  worstMo ${pct(w.r.s[i].worst)}   ${verdict(base.s[i], w.r.s[i])}`);
    const hOk = /PASS/.test(verdict(base.s[1], w.r.s[1])) && /PASS/.test(verdict(base.s[3], w.r.s[3]));
    console.log(`    hourly 2y: ${stats(w.r.h.trades)}`);
    console.log(`    → HOLDOUT ${hOk ? "CONFIRMS" : "REJECTS"} the fit winner`);
  }
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
