/**
 * overnight_leg_lab.js — where in the day does the washout edge live? (web
 * research pass, 2026-08-22)
 *
 * Literature: nearly all equity return accrues overnight and intraday returns
 * predict the next overnight NEGATIVELY (Lou/Polk/Skouras "Tug of War"; NY Fed
 * "Overnight Drift"; Della Corte/Kosowski "Market Closure and Short-Term
 * Reversal"); leveraged-ETF rebalancing flow ($30-50B in the last 30-60 min)
 * pushes late-day moves that are "completely reversed overnight". Two live
 * rules sit across those findings: the IBS >= 0.6 exit waits into the next
 * session's intraday, and the 15:50 de-carry flattens 3x holdings INTO the
 * rebalancing flow (justified by one gap incident, #3298).
 *
 * PART 1 — ENTRY HOUR. Monday config, entries bucketed by the hour of the bar
 *   they fired on: n, WR, avg/trade. Is the afternoon washout (which captures
 *   the overnight leg directly) worth more than the morning one?
 * PART 2 — EXIT TIMING. Monday exit (IBS >= 0.6 or floor/stop) vs
 *   "next open" (sell at the first bar of the next session, whatever it is)
 *   vs "next open if gapped up, else Monday rules" — does waiting into the
 *   reverting intraday cost the overnight gain?
 * PART 3 — LEVERAGED DE-CARRY. For the 3x names (SOXL + TQQQ/UPRO/TNA as
 *   peers): Monday rules (hold overnight) vs flatten at the last bar of the
 *   entry session (the live 15:50 rule). Plus the plain statistic: the
 *   average overnight return of a 3x name after a down session.
 *
 * Hourly 2y (halves) — daily bars cannot express any of this. Costs charged.
 * Usage: node experiments/overnight_leg_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const LEV = ["SOXL", "TQQQ", "UPRO", "TNA"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, exitMode: "monday", decarry: false };

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
function annotate(bars) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; b.isFirst = true; } else b.isFirst = false;
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = ET_HM(b.t + 3600 * 1000);
    b.isLast = i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);

function simulate(barsBySym, syms, cfg) {
  const o = { ...cfg };
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
      let exitPx = null, reason = null;
      // next-open exits are decided at the first bar of a new session, BEFORE the bar trades
      if (b.isFirst && b.si > pos.entrySi) {
        if (o.exitMode === "nextOpen") { exitPx = b.o * (1 - SLIP); reason = "next_open"; }
        else if (o.exitMode === "nextOpenIfUp" && b.o > pos.entry) { exitPx = b.o * (1 - SLIP); reason = "next_open_up"; }
      }
      if (exitPx == null) {
        const legs = b.c >= b.o ? ["L", "H", "C"] : ["H", "L", "C"];
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
        if (exitPx == null) {
          const v = rIbs(b);
          if (v >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
          else if (o.decarry && LEV.includes(sym) && b.isLast) { exitPx = b.c * (1 - SLIP); reason = "eod_decarry"; }
          else if (b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
        }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, hour: pos.hour, overnight: pos.overnight });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      } else if (b.isFirst && b.si > pos.entrySi && pos.overnight == null) {
        pos.overnight = b.o / pos.lastClose - 1;          // the overnight leg the position actually carried
      }
      if (exitPx == null && b.isLast) pos.lastClose = b.c;
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
        const v = rIbs(b);
        const thr = b.closeMin < 660 ? o.morningThr : o.thr;
        if (o.skipHours && o.skipHours.has(Math.floor(b.closeMin / 60))) continue;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx,
          hour: Math.floor(c.b.closeMin / 60), lastClose: c.b.isLast ? c.b.c : null, overnight: null });
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
const stat = (tr) => { if (!tr.length) return "n=0"; const w = tr.filter((x) => x.ret > 0).length; return `n=${String(tr.length).padStart(4)} WR ${(w / tr.length * 100).toFixed(0).padStart(3)}% avg ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2).padStart(6)}%`; };

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {};
  for (const s of [...new Set([...SYMS, ...LEV])]) hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400));
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const LABELS = ["hourly 1st half", "hourly 2nd half", "hourly FULL 2y "];
  const sc = (r) => [score(r.curve, H_START, H_MID), score(r.curve, H_MID, H_END), score(r.curve, H_START, H_END)];
  const show = (name, r, base) => {
    const s = sc(r), b = base ? sc(base) : null;
    console.log(`  ${name}`);
    for (let i = 0; i < 3; i++) console.log(`    ${LABELS[i]}: tot ${pct(s[i].tot, 7)}  DD ${pct(s[i].dd)}  tot÷DD ${ratio(s[i])}  worstMo ${pct(s[i].worst)}${b ? `   (base ${pct(b[i].tot)} / ${pct(b[i].dd)})` : ""}`);
    const mix = r.trades.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {});
    console.log(`    ${stat(r.trades)}  exits ${JSON.stringify(mix)}`);
  };

  const base = simulate(hourly, SYMS, MONDAY);
  console.log("PART 1 — ENTRY HOUR (Monday config, hourly 2y): hour the entry bar closed");
  const byHour = {};
  for (const x of base.trades) (byHour[x.hour] = byHour[x.hour] || []).push(x);
  for (const h of Object.keys(byHour).sort((a, b) => a - b)) console.log(`  ${String(h).padStart(2)}:00  ${stat(byHour[h])}`);
  const carried = base.trades.filter((x) => x.overnight != null);
  console.log(`  overnight leg actually carried by positions: n=${carried.length} avg ${(carried.reduce((a, x) => a + x.overnight, 0) / carried.length * 100).toFixed(3)}%  (positive share ${(carried.filter((x) => x.overnight > 0).length / carried.length * 100).toFixed(0)}%)\n`);

  console.log("PART 2 — EXIT TIMING (all 9 names)");
  show("Monday exit (IBS >= 0.6 / floor / stop)", base);
  show("next OPEN, unconditional", simulate(hourly, SYMS, { ...MONDAY, exitMode: "nextOpen" }), base);
  show("next OPEN if gapped above entry, else Monday rules", simulate(hourly, SYMS, { ...MONDAY, exitMode: "nextOpenIfUp" }), base);
  console.log("");

  console.log("PART 3 — LEVERAGED DE-CARRY (SOXL TQQQ UPRO TNA book, Monday rules)");
  const lb = simulate(hourly, LEV, MONDAY);
  show("hold overnight (no de-carry)", lb);
  show("flatten at the last bar of the entry session (the live 15:50 rule)", simulate(hourly, LEV, { ...MONDAY, decarry: true }), lb);
  // the plain statistic: 3x overnight return after a down session
  for (const s of LEV) {
    const bars = hourly[s]; const on = [];
    for (let i = 1; i < bars.length; i++) if (bars[i].isFirst) {
      let j = i - 1; while (j > 0 && !bars[j].isLast) j--;
      const dayOpen = bars.find((b) => b.si === bars[j].si && b.isFirst);
      if (dayOpen && bars[j].c < dayOpen.o) on.push(bars[i].o / bars[j].c - 1);
    }
    console.log(`  ${s}: overnight after a DOWN session n=${on.length} avg ${(on.reduce((a, x) => a + x, 0) / on.length * 100).toFixed(3)}%  positive ${(on.filter((x) => x > 0).length / on.length * 100).toFixed(0)}%`);
  }

  console.log("\nPART 4 — ENTRY-HOUR FILTER, chosen on the FIRST half only, confirmed on the second");
  const prof = (tr) => { const m = {}; for (const x of tr) (m[x.hour] = m[x.hour] || []).push(x); return m; };
  const p1 = prof(base.trades.filter((x) => x.d < H_MID)), p2 = prof(base.trades.filter((x) => x.d >= H_MID));
  console.log("  hour   1st half                          2nd half");
  for (const h of Object.keys(p1).sort((a, b) => a - b)) console.log(`  ${String(h).padStart(2)}:00  ${stat(p1[h])}   ${p2[h] ? stat(p2[h]) : "n=0"}`);
  const bad = new Set(Object.keys(p1).filter((h) => p1[h].length >= 50 && p1[h].reduce((a, x) => a + x.ret, 0) / p1[h].length < 0).map(Number));
  console.log(`  hours with negative expectancy on the FIRST half (n>=50): ${[...bad].join(", ") || "none"}`);
  if (bad.size) {
    const v = simulate(hourly, SYMS, { ...MONDAY, skipHours: bad });
    const robust = new Set([...bad].filter((h) => p2[h] && p2[h].reduce((a, x) => a + x.ret, 0) / p2[h].length < 0));
    console.log(`  hours negative on BOTH halves (robust): ${[...robust].join(", ") || "none"}`);
    if (robust.size) show(`skip entries in hours {${[...robust].join(",")}} (robust set)`, simulate(hourly, SYMS, { ...MONDAY, skipHours: robust }), base);
    show(`skip entries in hours {${[...bad].join(",")}}`, v, base);
    const s = sc(v), b = sc(base);
    console.log(`    2nd half (the confirmation): tot ${pct(s[1].tot)} vs ${pct(b[1].tot)}, DD ${pct(s[1].dd)} vs ${pct(b[1].dd)}, worstMo ${pct(s[1].worst)} vs ${pct(b[1].worst)} -> ${s[1].tot >= b[1].tot * 0.9 && s[1].dd >= b[1].dd ? "CONFIRMED" : "NOT confirmed"}`);
  }
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
