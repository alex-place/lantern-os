/**
 * current_config_lab.js — "how does THIS version of the trader perform on the
 * backtest?" (operator, 2026-08-22)
 *
 * Three configurations through the live-faithful portfolio analog (real long
 * tradelist, 12% positions, cap 5, gap-aware fills, 5bp entry + exit slippage,
 * within-bar ordering heuristic, the live trail schedule):
 *
 *   LAST WEEK   — IBS 0.15, no floor, early signal-exit (sell as soon as the
 *                 session IBS reads back above the entry threshold): the trader
 *                 that earned the 8/10–8/21 ledger.
 *   MONDAY, gate OFF — IBS 0.30 + morning 0.08 + floor +1% (armed), but still
 *                 the early signal-exit (#3418's TRADER_IBS_EXIT not armed).
 *   MONDAY, gate ON  — the same with the exit held to session IBS ≥ 0.6.
 *
 * The early exit is modelled as: exit at the first bar close (after the entry
 * bar) whose session IBS > entry threshold — the live `!bullish` flip in IBS
 * mode — instead of ≥ 0.6. Hourly bars cannot express the 20-minute min-hold;
 * the next bar close is ≥ 1h later, which is conservative in the same direction.
 *
 * Surfaces: hourly 2y halves + daily 26y two-window, plus the month-by-month
 * table of the last ~2 years for the two Monday configs.
 * Usage: node experiments/current_config_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const POS_FRAC = 0.12, MAX_CONC = 5;
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);

const CONFIGS = [
  ["LAST WEEK (0.15, no floor, early exit)", { thr: 0.15, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: null, lock: 0, exitIbs: 0.15, exitStrict: true }],
  ["MONDAY gate OFF (0.30, floor +1%, early exit)", { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.30, exitStrict: true }],
  ["MONDAY gate ON (0.30, floor +1%, exit at IBS>=0.6)", { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, exitStrict: false }],
];

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

function simulate(barsBySym, syms, cfg, intraday) {
  const o = { timeoutS: 5, ...cfg };
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
        const bounced = o.exitStrict ? ibsV > o.exitIbs : ibsV >= o.exitIbs;
        if (bounced) { exitPx = b.c * (1 - SLIP); reason = o.exitStrict ? "early_signal_exit" : "bounce"; }
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
        open.set(c.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx });
      }
    }
    curve.push({ t, d, equity });
  }
  return { curve, trades, finalEquity: curve[curve.length - 1].equity };
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
  const rows = [];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) { const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last; const r = byMonth.get(ms[i]).last / start - 1; rows.push({ m: ms[i], r }); if (r < worst) worst = r; if (r < 0) neg++; }
  return { tot, dd, worst, neg, months: ms.length, geoM: Math.pow(1 + tot, 1 / months) - 1, rows };
}
const fmt = (s) => s ? `tot ${(s.tot * 100).toFixed(1).padStart(7)}%  ${(s.geoM * 100).toFixed(2).padStart(5)}%/mo  DD ${(s.dd * 100).toFixed(1).padStart(6)}%  worstMo ${(s.worst * 100).toFixed(1).padStart(5)}%  negMo ${String(s.neg).padStart(2)}/${s.months}` : "n/a";

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  }
  const H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_START = hourly.SPY[0].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "hourly FULL 2y ", "daily  fit 00-14", "daily  holdout  "];
  for (const [name, cfg] of CONFIGS) {
    const h = simulate(hourly, SYMS, cfg, true), dd = simulate(daily, SYMS, cfg, false);
    const s = [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(h.curve, H_START, H_END), score(dd.curve, ...FIT), score(dd.curve, ...HOLD)];
    console.log(`=== ${name} ===`);
    for (let i = 0; i < 5; i++) console.log(`  ${LABELS[i]}: ${fmt(s[i])}`);
    const mix = h.trades.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {});
    const wr = h.trades.filter((x) => x.ret > 0).length / h.trades.length;
    const avg = h.trades.reduce((a, x) => a + x.ret, 0) / h.trades.length;
    console.log(`  hourly 2y trades ${h.trades.length}  WR ${(wr * 100).toFixed(0)}%  avg ${(avg * 100).toFixed(2)}%/trade  exits ${JSON.stringify(mix)}`);
    if (/MONDAY/.test(name)) {
      let line = "  by month:";
      for (const r of s[2].rows) { line += ` ${r.m.slice(2)}:${(r.r * 100).toFixed(1).padStart(5)}%`; if (line.length > 110) { console.log(line); line = "           "; } }
      if (line.trim()) console.log(line);
    }
    console.log("");
  }
  console.log("Caveats: unadjusted prices, no commissions, ~2y hourly = one regime, 26y daily cannot see the");
  console.log("morning gate or intraday sequencing. The analog reproduced entries on the live ledger but not the");
  console.log("exits (#3419) — the gate-OFF row is what the engine does today, the gate-ON row is what it was validated to do.");
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
