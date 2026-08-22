/**
 * gap_vixts_lab.js — two levers from web round four (2026-08-22), on the full
 * Monday config (0.30 / morning 0.08 / 3% stop / trail / floor +1% / exit 0.6 /
 * no knife / no cooldown / 13:30-14:30 block / x1.5 at VIX>=20 / clean ruler).
 *
 * PART 1 — GAP DAYS. The gap literature: SPY shows much less mean reversion
 *   when it opens down more than -0.6%; fading a large gap fills ~8% of the
 *   time; small gaps fill 65-82%. Our washout entries land on gap days too.
 *   Split entries by the session's opening gap (first regular bar's open vs the
 *   prior session's close): n, WR, avg, net, stop-outs. Then the rules:
 *     skip entries when the gap <= -0.6% / <= -1.0%
 *     size x0.5 on those days
 *     require a deeper washout (IBS <= 0.15) on those days
 *   Four surfaces (daily: gap = open vs prior close).
 *
 * PART 2 — STRESS TRIGGER: VIX LEVEL vs TERM STRUCTURE. Backwardation
 *   (VIX / VIX3M >= 1) marks near-term stress more sharply than a VIX level;
 *   practitioners' "buy the relief" is the contango flip. Triggers for the
 *   x1.5 multiplier: VIX >= 20 (armed now), VIX/VIX3M >= 1.0, VIX/VIX3M >= 0.95,
 *   either. Chosen on fit, scored on holdout. (^VIX3M history begins ~2007;
 *   before that the ratio is unknown and the multiplier stays 1.)
 *
 * Usage: node experiments/gap_vixts_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5,
  skipHours: new Set([14]), stress: "vix20", gapSkip: null, gapHalf: null, gapDeep: null };

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
  let day = null, si = -1, runH = 0, runL = 0, prevClose = null, dayGap = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = intraday ? ET_DAY(b.t) : new Date(b.t).toISOString().slice(0, 10);
    if (d !== day) {
      if (day !== null) prevClose = bars[i - 1].c;
      day = d; si++; runH = -Infinity; runL = Infinity;
      dayGap = prevClose ? b.o / prevClose - 1 : null;
    }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d; b.gap = dayGap;
    b.closeMin = intraday ? ET_HM(b.t + 3600 * 1000) : 960;
    b.hour = Math.floor(b.closeMin / 60);
    b.isLast = intraday ? (i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d) : true;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
function priorCloseMap(dailyBars) { const m = new Map(); for (let i = 0; i + 1 < dailyBars.length; i++) m.set(dailyBars[i + 1].d, dailyBars[i].c); return m; }

function simulate(barsBySym, syms, cfg, intraday, aux) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  const stressed = (d) => {
    const v = aux.vix.get(d), v3 = aux.vix3m.get(d);
    if (o.stress === "vix20") return v != null && v >= 20;
    if (o.stress === "ts100") return v != null && v3 != null && v / v3 >= 1.0;
    if (o.stress === "ts095") return v != null && v3 != null && v / v3 >= 0.95;
    if (o.stress === "either") return (v != null && v >= 20) || (v != null && v3 != null && v / v3 >= 1.0);
    return false;
  };
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
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, pnlEq: pos.qtyVal * (exitPx / pos.entry - 1), reason, gap: pos.gap });
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
        let thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
        const g = b.gap;
        if (o.gapSkip != null && g != null && g <= o.gapSkip) continue;
        if (o.gapDeep != null && g != null && g <= o.gapDeep) thr = Math.min(thr, 0.15);
        const v = intraday ? rIbs(b) : dIbs(b);
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac * (stressed(c.b.d) ? 1.5 : 1);
        if (o.gapHalf != null && c.b.gap != null && c.b.gap <= o.gapHalf) frac *= 0.5;
        const size = equity * frac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx, gap: c.b.gap });
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
const verdict = (base, v) => { if (!base || !v) return "n/a"; const lb = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg); const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot; return `${lb}/3 loss better, total ${keeps ? "kept" : "SACRIFICED"}${lb >= 2 && keeps ? "  << PASS" : ""}`; };
const stat = (tr) => { if (!tr.length) return "n=   0"; const w = tr.filter((x) => x.ret > 0).length, st = tr.filter((x) => x.reason === "stop").length; return `n=${String(tr.length).padStart(4)} WR ${(w / tr.length * 100).toFixed(0).padStart(3)}% avg ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2).padStart(6)}%  net ${pct(tr.reduce((a, x) => a + x.pnlEq, 0) / 100, 6)}  stop-outs ${(st / tr.length * 100).toFixed(0).padStart(3)}%`; };

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
  // Yahoo serves only the latest ^VIX3M print; CBOE publishes the history as CSV
  // (https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX3M_History.csv, from 2009-09-18).
  let vix3m = new Map();
  const csvPath = process.env.LAB_VIX3M_CSV;
  if (csvPath && require("fs").existsSync(csvPath)) {
    const rows = require("fs").readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1).filter(Boolean)
      .map((l) => { const [d, o, h, lo, c] = l.split(","); const [m, dd, y] = d.split("/"); return { d: `${y}-${m}-${dd}`, c: Number(c) }; })
      .filter((r) => Number.isFinite(r.c));
    for (let i = 0; i + 1 < rows.length; i++) vix3m.set(rows[i + 1].d, rows[i].c);   // prior-session close, no look-ahead
  }
  const aux = { vix, vix3m };
  console.log(`^VIX3M history from ${[...vix3m.keys()].sort()[0] || "n/a"}\n`);
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (cfg) => { const h = simulate(hourly, SYMS, cfg, true, aux), d = simulate(daily, SYMS, cfg, false, aux); return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] }; };
  const base = run(MONDAY);
  console.log("BASELINE — Monday full");
  for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}`);

  console.log("\nPART 1 — ENTRIES BY THE SESSION'S OPENING GAP");
  const buckets = [["gap <= -1.0%", (g) => g <= -0.01], ["-1.0% < gap <= -0.6%", (g) => g > -0.01 && g <= -0.006], ["-0.6% < gap < 0", (g) => g > -0.006 && g < 0], ["0 <= gap < +0.6%", (g) => g >= 0 && g < 0.006], ["gap >= +0.6%", (g) => g >= 0.006]];
  for (const [label, tr] of [["hourly 2y", base.h.trades], ["daily holdout", base.d.trades.filter((x) => x.d >= "2015-01-01")]]) {
    console.log(`  ${label}:`);
    for (const [name, f] of buckets) console.log(`    ${name.padEnd(22)} ${stat(tr.filter((x) => x.gap != null && f(x.gap)))}`);
  }
  const show = (name, cfg) => {
    const r = run(cfg);
    console.log(name);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
    return r;
  };
  console.log("\nPART 1b — GAP RULES");
  show("skip entries when gap <= -0.6%", { ...MONDAY, gapSkip: -0.006 });
  show("skip entries when gap <= -1.0%", { ...MONDAY, gapSkip: -0.01 });
  show("size x0.5 when gap <= -0.6%", { ...MONDAY, gapHalf: -0.006 });
  show("require IBS <= 0.15 when gap <= -0.6%", { ...MONDAY, gapDeep: -0.006 });

  console.log("\nPART 2 — STRESS TRIGGER (x1.5): VIX level vs term structure");
  const grid = [["VIX >= 20 (armed)", "vix20"], ["VIX/VIX3M >= 1.00 (backwardation)", "ts100"], ["VIX/VIX3M >= 0.95", "ts095"], ["VIX >= 20 or backwardation", "either"]];
  const rows = [];
  for (const [name, stress] of grid) {
    const r = run({ ...MONDAY, stress });
    const rat = (s) => (s.dd < 0 ? s.tot / -s.dd : 0);
    rows.push({ name, r, fitScore: rat(r.s[0]) + rat(r.s[2]) });
    console.log(`  ${name.padEnd(34)} hourly1 ${pct(r.s[0].tot)} ÷DD ${ratio(r.s[0])} | hourly2 ${pct(r.s[1].tot)} ÷DD ${ratio(r.s[1])} | fit ${pct(r.s[2].tot, 7)} ÷DD ${ratio(r.s[2])} | holdout ${pct(r.s[3].tot, 7)} ÷DD ${ratio(r.s[3])}`);
  }
  const w = rows.sort((a, z) => z.fitScore - a.fitScore)[0];
  console.log(`  fit-surface winner (by return/DD): ${w.name}`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
