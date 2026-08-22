/**
 * universe_lab.js — "what else can we do?" (operator, 2026-08-22), answered as
 * the three highest value-of-information arms the existing simulator can pull:
 *
 *   A. LAB↔LIVE FIDELITY. Every projection this weekend rests on the portfolio
 *      analog. Replay the live window 8/10–8/21 through it at the config that
 *      was live then (IBS 0.15, morning 0.08, 3% stop, real trail, no floor) and
 *      compare with the stable ledger: entries per symbol, symbol-day overlap,
 *      fill deltas on matched entries, exit mix, P&L. This calibrates how much
 *      of the analog's edge to expect live — the number that matters most.
 *
 *   B. UNIVERSE EXPANSION. Frequency is the binding constraint (the 0.30
 *      threshold and the +1% floor both attack it). The tradelist long side is
 *      9 ETFs; add 9 liquid peers (sector SPDRs, EEM/EFA, the 3x index family)
 *      and measure base-9 vs all-18 under the config now live (0.30, morning
 *      0.08, 3% stop, trail, floor +1%), cap 5, deepest washout first. Also the
 *      per-symbol expectancy table: who carries the edge, who is dead weight.
 *
 *   C. MORNING GATE. TRADER_IBS_MAX_MORNING=0.08 (pre-11:00 ET) came from a
 *      23-session pilot and was never put through the bar. Gate on vs off on
 *      the hourly halves (daily bars cannot express it).
 *
 * Simulator = stop_trail_lab (live-faithful: gap-aware fills, 5bp entry+exit
 * slippage, within-bar ordering heuristic, trail schedule, ratchet/lock).
 * Usage: node experiments/universe_lab.js [--days 720]
 */
"use strict";

const https = require("https");
const fs = require("fs");

const BASE9 = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const ADD9 = ["XLF", "XLE", "XLV", "XLI", "EEM", "EFA", "TQQQ", "UPRO", "TNA"];
const POS_FRAC = 0.12, MAX_CONC = 5;
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const LIVE_NOW = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01 };
const LIVE_THEN = { thr: 0.15, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: null, lock: 0 };

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
  const o = { timeoutS: 5, ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if ((!from || b.d >= from) && (!to || b.d <= to)) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [], entries = [];
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
        if (ibsV >= 0.6) { exitPx = b.c; reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, entryD: pos.entryD });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size < MAX_CONC) {
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
        if (open.size >= MAX_CONC) break;
        const size = equity * POS_FRAC;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, entryD: c.b.d, peak: entryPx });
        entries.push({ sym: c.sym, d: c.b.d, t: c.b.t, px: entryPx, ibs: c.v });
      }
    }
    curve.push({ t, d, equity });
  }
  const last = curve[curve.length - 1];
  return { curve, trades, entries, finalEquity: last ? last.equity : 100, openAtEnd: [...open.keys()] };
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
const fmt = (s) => s ? `tot ${(s.tot * 100).toFixed(1).padStart(6)}%  DD ${(s.dd * 100).toFixed(1).padStart(6)}%  worstMo ${(s.worst * 100).toFixed(1).padStart(5)}%  negMo ${String(s.neg).padStart(2)}/${s.months}` : "n/a";
function verdict(base, v) {
  if (!base || !v) return "n/a";
  const lossBetter = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg);
  const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot;
  return `${lossBetter}/3 loss metrics better, total ${keeps ? "kept" : "SACRIFICED"}${lossBetter >= 2 && keeps ? "  << PASS" : ""}`;
}

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const ALL = [...BASE9, ...ADD9];
  const hourly = {}, daily = {};
  for (const s of ALL) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  console.log(`symbols: ${ALL.map((s) => s + "(" + daily[s][0].d.slice(0, 4) + ")").join(" ")}\n`);
  const H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_START = hourly.SPY[0].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (syms, cfg) => {
    const h = simulate(hourly, syms, cfg, true), dd = simulate(daily, syms, cfg, false);
    return { h, dd, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(dd.curve, ...FIT), score(dd.curve, ...HOLD)] };
  };

  // ── A. FIDELITY ───────────────────────────────────────────────────────────
  console.log("A. LAB↔LIVE FIDELITY — 2026-08-10 → 08-21, analog at the config live THEN (0.15, no floor)");
  const ledgerPath = process.env.LAB_LEDGER || "C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl";
  const ET = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const live = { entries: [], exits: [] };
  if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (e) { continue; }
      if (!r.ts) continue;
      const d = ET(r.ts);
      if (d < "2026-08-10" || d > "2026-08-21") continue;
      if (!BASE9.includes(r.symbol)) continue;
      if (r.event === "entry") live.entries.push({ sym: r.symbol, d, px: Number(r.price || r.entry) || null, qty: Number(r.qty) || null });
      if (r.event === "exit" && typeof r.pnl === "number") live.exits.push({ sym: r.symbol, d, pnl: r.pnl, reason: String(r.reason || "").split(" ")[0] });
    }
  } else console.log("  (ledger not found at " + ledgerPath + ")");
  const an = simulate(hourly, BASE9, LIVE_THEN, true, "2026-08-07", "2026-08-21");   // 1 session warm-up before the window
  const anEntries = an.entries.filter((e) => e.d >= "2026-08-10");
  const anExits = an.trades.filter((x) => x.d >= "2026-08-10");
  const bySym = (arr) => arr.reduce((a, e) => ((a[e.sym] = (a[e.sym] || 0) + 1), a), {});
  console.log(`  entries: live ${live.entries.length}  analog ${anEntries.length}`);
  console.log(`    live   by symbol: ${JSON.stringify(bySym(live.entries))}`);
  console.log(`    analog by symbol: ${JSON.stringify(bySym(anEntries))}`);
  const liveDays = new Set(live.entries.map((e) => e.sym + "@" + e.d)), anDays = new Set(anEntries.map((e) => e.sym + "@" + e.d));
  const overlap = [...liveDays].filter((k) => anDays.has(k));
  console.log(`  symbol-days: live ${liveDays.size}, analog ${anDays.size}, overlap ${overlap.length} (${liveDays.size ? Math.round(100 * overlap.length / liveDays.size) : 0}% of live days also fired in the analog)`);
  const deltas = [];
  for (const k of overlap) {
    const [sym, d] = k.split("@");
    const le = live.entries.find((e) => e.sym === sym && e.d === d && e.px), ae = anEntries.find((e) => e.sym === sym && e.d === d);
    if (le && ae) deltas.push((le.px - ae.px) / ae.px);
  }
  if (deltas.length) console.log(`  matched entries: live filled ${(deltas.reduce((a, x) => a + x, 0) / deltas.length * 100).toFixed(2)}% vs the analog's hourly-close entry (n=${deltas.length}; negative = live got in lower)`);
  const mix = (arr) => JSON.stringify(arr.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {}));
  console.log(`  exit mix: live ${mix(live.exits)}  analog ${mix(anExits)}`);
  const livePnl = live.exits.reduce((a, x) => a + x.pnl, 0);
  const EQ = Number(process.env.LAB_LIVE_EQUITY || 970000);
  console.log(`  P&L: live realized ${livePnl >= 0 ? "+" : ""}$${livePnl.toFixed(0)} (${(livePnl / EQ * 100).toFixed(2)}% of $${(EQ / 1000).toFixed(0)}k)   analog ${((an.finalEquity - 100)).toFixed(2)}% of equity ≈ ${(an.finalEquity - 100) >= 0 ? "+" : ""}$${((an.finalEquity - 100) / 100 * EQ).toFixed(0)} (mark-to-market, ${an.openAtEnd.length} still open)\n`);

  // ── B. UNIVERSE ───────────────────────────────────────────────────────────
  console.log("B. UNIVERSE EXPANSION — config now live (0.30 / morning 0.08 / 3% stop / trail / floor +1%), cap 5");
  const b9 = run(BASE9, LIVE_NOW), b18 = run(ALL, LIVE_NOW);
  console.log("  base 9:");
  for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: ${fmt(b9.s[i])}`);
  console.log("  all 18:");
  for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: ${fmt(b18.s[i])}   ${verdict(b9.s[i], b18.s[i])}`);
  const tr9 = b9.dd.trades.filter((x) => x.d >= "2015-01-01").length, tr18 = b18.dd.trades.filter((x) => x.d >= "2015-01-01").length;
  console.log(`  holdout trades: ${tr9} → ${tr18} (${((tr18 / tr9 - 1) * 100).toFixed(0)}% more fills at the same cap)`);
  console.log("  per-symbol, daily holdout 2015– (all 18 running): n / avg ret / total / share of fills");
  const ps = {};
  for (const x of b18.dd.trades) { if (x.d < "2015-01-01") continue; const p = ps[x.sym] = ps[x.sym] || { n: 0, tot: 0 }; p.n++; p.tot += x.ret; }
  const allN = Object.values(ps).reduce((a, p) => a + p.n, 0);
  for (const [sym, p] of Object.entries(ps).sort((a, z) => z[1].tot - a[1].tot))
    console.log(`    ${sym.padEnd(5)} ${String(p.n).padStart(5)}  ${(p.tot / p.n * 100).toFixed(2).padStart(6)}%  ${(p.tot * 100).toFixed(1).padStart(7)}%  ${(p.n / allN * 100).toFixed(0).padStart(3)}%${BASE9.includes(sym) ? "" : "   (new)"}`);
  console.log("");

  // ── C. MORNING GATE ───────────────────────────────────────────────────────
  console.log("C. MORNING GATE — 0.08 before 11:00 ET (live) vs OFF (base threshold all day), hourly halves");
  const gOn = run(BASE9, LIVE_NOW), gOff = run(BASE9, { ...LIVE_NOW, morningThr: 0.30 });
  for (let i = 0; i < 2; i++) console.log(`  ${LABELS[i]}: gate ON  ${fmt(gOn.s[i])}`);
  for (let i = 0; i < 2; i++) console.log(`  ${LABELS[i]}: gate OFF ${fmt(gOff.s[i])}   ${verdict(gOn.s[i], gOff.s[i])}`);
  const n = (r, from, to) => r.h.trades.filter((x) => x.d >= from && x.d < to).length;
  console.log(`  trades: ON ${n(gOn, H_START, H_END)} vs OFF ${n(gOff, H_START, H_END)}`);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
