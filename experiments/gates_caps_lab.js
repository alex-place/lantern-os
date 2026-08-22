/**
 * gates_caps_lab.js — round two of "deeper flaws" (operator, 2026-08-22):
 * the live rules the analog never modelled, and two constructive ideas from
 * the literature.
 *
 * LIVE RULES (each a stand-down or throttle; the #3413 lesson is that such
 * rules tend to cost return without buying drawdown):
 *   A. CONCURRENCY CAP — live 5 at 12%. The anatomy says 2.5 slots are used on
 *      average but the cap bound 58 times in two weeks — on the clustered
 *      washout days, the paydays. Test 5 / 7 / 9.
 *   B. POST-STOP COOLDOWN — live bars re-entry in a symbol through N trading
 *      days after a stop-out; the analog re-enters on the next signal. Test
 *      1 and 2 sessions.
 *   C. DAILY-LOSS HALT — live stops NEW entries once the session P&L is at or
 *      below -2% of equity. Test it in the analog.
 *
 * CONSTRUCTIVE (Nagel 2012 "Evaporating Liquidity": reversal returns rise
 * strongly with VIX; our own carry lab: the weakest closes are the best nights):
 *   D. VOL-UP SIZING — 12% -> 18% when the prior VIX close >= 20 (and >= 25),
 *      and the data-free twin: when the symbol's own ATR% is in the top 40% of
 *      its trailing year. Sizing DOWN in stress was rejected (#3413); this is
 *      the other direction.
 *   E. MARKET-WIDE WASHOUT — condition on SPY's running IBS at the entry bar:
 *      only market-driven washouts (SPY IBS <= 0.5), only idiosyncratic ones
 *      (SPY IBS > 0.5), or size 1.5x when the whole market is washed out
 *      (SPY IBS <= 0.3). Which side carries the edge?
 *
 * Four surfaces (hourly 2y halves + daily 26y two-window; VIX daily since
 * 1990), Monday config, costs charged. Parameters chosen on fit, scored on
 * holdout; verdict = loss metrics better with total kept.
 * Usage: node experiments/gates_caps_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5,
  cooldownS: 0, dailyHalt: null, vixUp: null, atrUp: null, spyCond: null };

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
/** date -> prior-session value maps (no look-ahead) */
function priorCloseMap(dailyBars) { const m = new Map(); for (let i = 0; i + 1 < dailyBars.length; i++) m.set(dailyBars[i + 1].d, dailyBars[i].c); return m; }
function atrPctileMap(dailyBars) {
  const m = new Map(); const tr = [], atr = [];
  for (let i = 0; i < dailyBars.length; i++) {
    const b = dailyBars[i], pc = i ? dailyBars[i - 1].c : b.c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    const a = i >= 13 ? tr.slice(i - 13, i + 1).reduce((x, y) => x + y, 0) / 14 / b.c : null;
    atr.push(a);
    if (a != null && i >= 260 && i + 1 < dailyBars.length) {
      const win = atr.slice(i - 250, i + 1).filter((x) => x != null);
      const rank = win.filter((x) => x <= a).length / win.length;
      m.set(dailyBars[i + 1].d, rank);
    }
  }
  return m;
}

function simulate(barsBySym, syms, cfg, intraday, aux) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  const spyIdx = new Map(barsBySym.SPY.map((b) => [b.t, b]));
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map(), stopBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  let curDay = null, dayStartEq = 100;
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
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        if (reason === "stop" && o.cooldownS > 0) stopBlock.set(sym, b.si + o.cooldownS + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (d !== curDay) { curDay = d; dayStartEq = equity; }
    const halted = o.dailyHalt != null && equity / dayStartEq - 1 <= -o.dailyHalt;
    if (open.size < o.maxConc && !halted) {
      const cands = [];
      const spyB = spyIdx.get(t);
      const spyIbs = spyB ? (intraday ? rIbs(spyB) : dIbs(spyB)) : null;
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        if (stopBlock.has(sym) && b.si < stopBlock.get(sym)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? o.morningThr : o.thr;
        if (v > thr) continue;
        if (o.spyCond === "marketOnly" && !(spyIbs != null && spyIbs <= 0.5)) continue;
        if (o.spyCond === "idioOnly" && !(spyIbs != null && spyIbs > 0.5)) continue;
        cands.push({ sym, b, v, spyIbs });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac;
        const m = o.stressMult || 1.5;
        const stressed = (o.vixUp != null && aux.vix.get(c.b.d) >= o.vixUp)
          || (o.atrUp != null && (aux.atrP[c.sym] ? aux.atrP[c.sym].get(c.b.d) : 0) >= o.atrUp)
          || (o.spyCond === "marketUp" && c.spyIbs != null && c.spyIbs <= (o.spyUpLvl || 0.3));
        if (stressed) frac *= m;
        const size = equity * frac;
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

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {}, atrP = {};
  for (const s of SYMS) {
    hourly[s] = annotate(await chart(s, "1h", nowSec - DAYS * 86400), true);
    daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
    atrP[s] = atrPctileMap(daily[s]);
  }
  const vixBars = annotate(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false);
  const vix = priorCloseMap(vixBars);
  const aux = { vix, atrP };
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const run = (cfg) => { const h = simulate(hourly, SYMS, cfg, true, aux), d = simulate(daily, SYMS, cfg, false, aux); return { h, d, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(d.curve, ...FIT), score(d.curve, ...HOLD)] }; };
  const base = run(MONDAY);
  console.log("BASELINE — Monday config");
  for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(base.s[i].tot, 7)}  DD ${pct(base.s[i].dd)}  tot÷DD ${ratio(base.s[i])}  worstMo ${pct(base.s[i].worst)}`);
  console.log("");
  const show = (name, cfg) => {
    const r = run(cfg);
    console.log(name);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: tot ${pct(r.s[i].tot, 7)}  DD ${pct(r.s[i].dd)}  tot÷DD ${ratio(r.s[i])}  worstMo ${pct(r.s[i].worst)}   ${verdict(base.s[i], r.s[i])}`);
    console.log(`  trades: hourly ${r.h.trades.length} (base ${base.h.trades.length}), daily ${r.d.trades.length} (base ${base.d.trades.length})`);
  };
  console.log("A. CONCURRENCY CAP");
  show("cap 7", { ...MONDAY, maxConc: 7 });
  show("cap 9", { ...MONDAY, maxConc: 9 });
  console.log("\nB. POST-STOP COOLDOWN (the live rule; the analog has none)");
  show("cooldown 1 session after a stop-out", { ...MONDAY, cooldownS: 1 });
  show("cooldown 2 sessions after a stop-out", { ...MONDAY, cooldownS: 2 });
  console.log("\nC. DAILY-LOSS HALT (live: no new entries once the session is -2% of equity)");
  show("halt new entries at -2% day P&L", { ...MONDAY, dailyHalt: 0.02 });
  console.log("\nD. VOL-UP SIZING (Nagel: reversal returns rise with VIX)");
  show("12% -> 18% when prior VIX close >= 20", { ...MONDAY, vixUp: 20 });
  show("12% -> 18% when prior VIX close >= 25", { ...MONDAY, vixUp: 25 });
  show("12% -> 18% when symbol ATR% in its top 40% of the trailing year", { ...MONDAY, atrUp: 0.6 });
  console.log("\nE. MARKET-WIDE WASHOUT (SPY running IBS at the entry bar)");
  show("only when SPY IBS <= 0.5 (market-driven washouts)", { ...MONDAY, spyCond: "marketOnly" });
  show("only when SPY IBS > 0.5 (idiosyncratic washouts)", { ...MONDAY, spyCond: "idioOnly" });
  show("size 1.5x when SPY IBS <= 0.3 (the whole market washed out)", { ...MONDAY, spyCond: "marketUp" });
  console.log("\nF. STRESS MULTIPLIER — chosen on the FIT surfaces (hourly 1st half + daily fit), scored on holdout");
  const GRID = [];
  for (const mult of [1.5, 2.0]) {
    GRID.push([`VIX>=20 x${mult}`, { vixUp: 20, stressMult: mult }]);
    GRID.push([`VIX>=25 x${mult}`, { vixUp: 25, stressMult: mult }]);
    GRID.push([`SPY IBS<=0.3 x${mult}`, { spyCond: "marketUp", stressMult: mult }]);
    GRID.push([`VIX>=20 or SPY IBS<=0.3 x${mult}`, { vixUp: 20, spyCond: "marketUp", stressMult: mult }]);
  }
  const rows = [];
  for (const [name, extra] of GRID) {
    const r = run({ ...MONDAY, ...extra });
    const rat = (s) => (s.dd < 0 ? s.tot / -s.dd : 0);
    // fit criterion: return/DD must improve on BOTH fit surfaces; rank by the fit ratio gain
    const fitOk = rat(r.s[0]) > rat(base.s[0]) && rat(r.s[2]) > rat(base.s[2]);
    rows.push({ name, r, fitOk, gain: rat(r.s[0]) / rat(base.s[0]) + rat(r.s[2]) / rat(base.s[2]) });
    console.log(`  ${name.padEnd(30)} fit: hourly1 ${pct(r.s[0].tot)} ÷DD ${ratio(r.s[0])} | daily ${pct(r.s[2].tot, 7)} ÷DD ${ratio(r.s[2])}  ${fitOk ? "fit OK" : "fit --"}`);
  }
  const ok = rows.filter((x) => x.fitOk).sort((a, z) => z.gain - a.gain);
  console.log(`  ${ok.length}/${rows.length} improve return/DD on both fit surfaces (baseline ${ratio(base.s[0])} / ${ratio(base.s[2])})`);
  if (ok.length) {
    const w = ok[0];
    console.log(`  FIT WINNER: ${w.name}`);
    for (let i = 0; i < 4; i++) console.log(`    ${LABELS[i]}: tot ${pct(w.r.s[i].tot, 7)}  DD ${pct(w.r.s[i].dd)}  tot÷DD ${ratio(w.r.s[i])}  worstMo ${pct(w.r.s[i].worst)}   (base ${pct(base.s[i].tot)} / ${pct(base.s[i].dd)} / ${ratio(base.s[i])})`);
    const rat = (s) => (s.dd < 0 ? s.tot / -s.dd : 0);
    const hOk = rat(w.r.s[1]) > rat(base.s[1]) && rat(w.r.s[3]) > rat(base.s[3]);
    console.log(`    → HOLDOUT ${hOk ? "CONFIRMS" : "REJECTS"} (return/DD on both holdout surfaces)`);
  }
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
