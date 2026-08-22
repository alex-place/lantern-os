/**
 * limit_entry_lab.js — enter LOWER: the limit-entry depth sweep (operator,
 * 2026-08-22: "it enters before a reversal sign appears — fixing this would
 * both decrease losses and increase the profit per trade")
 *
 * Entry-timing lab (#3423): 57% of winners dip first (median -0.32%); waiting
 * for a confirmation bar destroys the edge; a limit 0.5% under the touch was
 * the one variant with signal — recent half 24.2% vs 13.7% — but failed the
 * correction half (adverse selection) and filled only 43% of signals. This lab
 * does the follow-up properly:
 *
 *   DEPTH — fixed d ∈ {0.25, 0.5, 0.75, 1.0, 1.5}% under the touch close, and
 *           move-size-aware k × ATR14% (k ∈ {0.1, 0.2, 0.3}; 0.2 ATR ≈ 0.25% on
 *           SPY, ≈ 2% on SOXL) — the same rule means different dollars per
 *           instrument.
 *   FALLBACK — none (a missed signal is skipped) vs session-end (if the limit
 *           never fills, enter at the touch session's last close): recovers
 *           the missed 57% at a worse price than the limit but no later than
 *           the old rule's worst case.
 *   ADVERSE SELECTION — each variant reports the filled-limit trades and the
 *           fallback trades separately (count, WR, avg ret): if limit fills
 *           are systematically worse, the fills are the bad days.
 *   DAILY — a limit under the touch-day close, working the NEXT session (fill
 *           at min(limit, open)); fallback at that session's close. Gives the
 *           limit the 26y two-window bar it lacked in #3423.
 *
 * Depth chosen on the FIT surfaces (hourly 1st half + daily 2000-14), scored
 * once on holdout. Monday exits throughout (3% stop, trail, +1% floor, bounce
 * at IBS >= 0.6); costs charged; gap-aware fills.
 * Usage: node experiments/limit_entry_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, depth: null, atrK: null, fallback: false };

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
function atrMap(dailyBars) {
  const m = new Map(); const tr = [];
  for (let i = 0; i < dailyBars.length; i++) {
    const b = dailyBars[i], pc = i ? dailyBars[i - 1].c : b.c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    if (i >= 14 && i + 1 < dailyBars.length) m.set(dailyBars[i + 1].d, tr.slice(i - 13, i + 1).reduce((x, y) => x + y, 0) / 14 / b.c);
  }
  return m;
}

function simulate(barsBySym, syms, cfg, intraday, atr) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map(), armed = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  const ibsOf = (b) => (intraday ? rIbs(b) : dIbs(b));
  const limitMode = o.depth != null || o.atrK != null;
  for (const t of timeline) {
    const d = ET_DAY(t);
    for (const [sym, pos] of [...open]) {
      const b = idx[sym].get(t);
      if (!b || b.t <= pos.entryT) continue;
      if (b.l / pos.entry - 1 < pos.mae) pos.mae = b.l / pos.entry - 1;
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
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, mae: pos.mae, via: pos.via });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    // ── entries ─────────────────────────────────────────────────────────────
    const cands = [];
    for (const sym of syms) {
      const b = idx[sym].get(t);
      if (!b || b.si === 0) continue;
      if (open.has(sym)) { armed.delete(sym); continue; }
      if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
      const v = ibsOf(b);
      const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
      if (!limitMode) { if (v <= thr) cands.push({ sym, b, v, px: b.c, via: "touch" }); continue; }
      const a = armed.get(sym);
      if (a && b.t > a.t) {
        // the limit works: intraday → rest of the touch session; daily → the next session
        const inWindow = intraday ? b.si === a.si : b.si === a.si + 1;
        if (inWindow && b.l <= a.lim) { cands.push({ sym, b, v, px: Math.min(a.lim, b.o), via: "limit" }); armed.delete(sym); continue; }
        const windowEnds = intraday ? (b.si === a.si && b.isLast) || b.si > a.si : b.si >= a.si + 1;
        if (windowEnds) {
          armed.delete(sym);
          // fallback: enter at the window's last close unless the bounce is already gone
          if (o.fallback && inWindow && v < o.exitIbs) { cands.push({ sym, b, v, px: b.c, via: "fallback" }); continue; }
        }
      }
      if (!armed.has(sym) && v <= thr) {
        const ak = o.atrK != null ? (atr[sym] ? atr[sym].get(b.d) : null) : null;
        const depth = o.atrK != null ? (ak == null ? null : o.atrK * ak) : o.depth;
        if (depth != null) armed.set(sym, { lim: b.c * (1 - depth), si: b.si, t: b.t });
      }
    }
    if (open.size < o.maxConc) {
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.px * (1 + (c.via === "limit" ? 0 : ENTRY_SLIP));   // a limit fills at its price; market entries pay slip
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx, mae: 0, via: c.via });
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
const split = (tr) => {
  const g = (via) => { const s = tr.filter((x) => x.via === via); const w = s.filter((x) => x.ret > 0).length; return s.length ? `${s.length} trades WR ${(w / s.length * 100).toFixed(0)}% avg ${(s.reduce((a, x) => a + x.ret, 0) / s.length * 100).toFixed(2)}%` : "none"; };
  return `limit fills: ${g("limit")}   fallback: ${g("fallback")}`;
};

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
  console.log("BASELINE — Monday config (touch entry)");
  for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}`);
  console.log(`  hourly trades ${base.h.trades.length}, daily ${base.d.trades.length}\n`);

  const VARIANTS = [];
  for (const depth of [0.0025, 0.005, 0.0075, 0.01, 0.015]) for (const fallback of [false, true]) VARIANTS.push([`limit ${(depth * 100).toFixed(2)}%${fallback ? " + fallback" : ""}`, { depth, fallback }]);
  for (const atrK of [0.1, 0.2, 0.3]) for (const fallback of [false, true]) VARIANTS.push([`limit ${atrK}×ATR${fallback ? " + fallback" : ""}`, { atrK, fallback }]);
  const grid = [];
  for (const [name, extra] of VARIANTS) {
    const r = run({ ...MONDAY, ...extra });
    const fitOk = /PASS/.test(verdict(base.s[0], r.s[0])) && /PASS/.test(verdict(base.s[2], r.s[2]));
    grid.push({ name, r, fitOk, fitTot: r.s[0].tot + r.s[2].tot });
    console.log(name);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
    console.log(`  hourly: ${split(r.h.trades)}   (signals filled ${(r.h.trades.length / base.h.trades.length * 100).toFixed(0)}% of baseline count)`);
    console.log(`  daily : ${split(r.d.trades)}`);
  }
  const ok = grid.filter((g) => g.fitOk).sort((a, z) => z.fitTot - a.fitTot);
  console.log(`\n${ok.length}/${grid.length} variants pass BOTH fit surfaces.`);
  if (ok.length) {
    const w = ok[0];
    console.log(`FIT WINNER: ${w.name}`);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(w.r.s[i].tot, 7)}  DD ${pct(w.r.s[i].dd)}  tot÷DD ${ratio(w.r.s[i])}  worstMo ${pct(w.r.s[i].worst)}   ${verdict(base.s[i], w.r.s[i])}`);
    const hOk = /PASS/.test(verdict(base.s[1], w.r.s[1])) && /PASS/.test(verdict(base.s[3], w.r.s[3]));
    console.log(`  → HOLDOUT ${hOk ? "CONFIRMS" : "REJECTS"} the fit winner`);
  }
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
