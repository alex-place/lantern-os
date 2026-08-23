/**
 * payoff_lab.js — PAYOFF RATIO research (round 6, 2026-08-22). The live stack
 * wins 63% of trades but the average win (0.94%) is smaller than the average
 * loss (1.22%): payoff b = 0.77. The operator's bar: bring b to at least 1.00
 * WITHOUT giving back return/DD. This lab first decomposes the loss side by
 * exit reason, then sweeps the five levers that move b, each chosen on the FIT
 * surfaces (hourly 1st half + daily 2000-14) and scored once on holdout
 * (hourly 2nd half + daily 2015-):
 *
 *   A. RATCHET TRAIL — after the +1% floor engages, the stop follows the peak
 *      (peak - x%) instead of sitting at entry+1%. Raises the average WIN by
 *      letting runners be sold near their peak instead of at the floor.
 *   B. HOLD UNDERWATER BOUNCES — the IBS>=0.6 bounce exit sells only at or
 *      above a floor; below it the position waits for stop / timeout / a
 *      better bounce. Removes the small losing bounces from the loss side.
 *   C. CLOSE-BASED STOP — fire on a bar close through the level rather than
 *      an intrabar touch (wick protection); gaps still fill at the open.
 *   D. TIME-STOP ON LOSERS — a position still down x% at the close of session
 *      entry+n exits (the operator's "at -2% it goes to -3% or flat" rule,
 *      conditioned on time instead of a tighter static stop, which #3415
 *      rejected).
 *   E. SCALE-OUT — sell part at the floor, run the rest.
 *   F. Combinations of the per-lever candidates.
 *
 * Baseline: the LIVE stack as armed 2026-08-22 (Monday + symbol tilt #3434).
 * Usage: node experiments/payoff_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (g, base) => (g >= 25 ? Math.min(base, 1.25) : g >= 12 ? Math.min(base, 1.75) : g >= 6 ? Math.min(base, 2.25) : base);
const MONDAY = { thr: 0.30, morningThr: 0.08, stopPct: 0.03, trail: LIVE_TRAIL, be: 0.01, lock: 0.01, exitIbs: 0.6, sizeFrac: 0.12, maxConc: 5, timeoutS: 5, skipHours: new Set([14]), vixUp: 20, weights: null };

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
    b.hour = Math.floor(b.closeMin / 60);
    b.isLast = intraday ? (i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d) : true;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
function priorCloseMap(dailyBars) { const m = new Map(); for (let i = 0; i + 1 < dailyBars.length; i++) m.set(dailyBars[i + 1].d, dailyBars[i].c); return m; }


// ---- simulator: the stack-sweep engine + the PAYOFF levers under test ----
//   o.rt            {arm, pct}   ratchet trail: once gain >= arm%, stop = max(stop, peak*(1-pct/100)); never lowers (broker-side TRAIL analog)
//   o.holdUnder     number       bounce exit only when close >= entry*(1+holdUnder); underwater bounces are HELD (stop/timeout still rule)
//   o.closeStop     bool         stop fires on bar CLOSE <= stop (no intrabar wick fills; gaps still fill at the open)
//   o.loserTime     {n, lvl}     at the last bar of session entry+n, if close <= entry*(1+lvl) -> exit at close (time-stop on losers)
//   o.scaleOut      {at, frac}   sell `frac` of the position at entry*(1+at) (limit, no slip); remainder runs under the same rules
function simulate(barsBySym, syms, cfg, intraday, vix, from, to) {
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
          if (o.rt) { const g = (pos.peak / pos.entry - 1) * 100; if (g >= o.rt.arm) { const want = pos.peak * (1 - o.rt.pct / 100); if (pos.stopPx < want) { pos.stopPx = want; pos.rtArmed = true; } } }
          if (o.scaleOut && !pos.scaled) { const lvl = pos.entry * (1 + o.scaleOut.at); if (b.h >= lvl) { const part = pos.qtyVal * o.scaleOut.frac; cash += part * (lvl / pos.entry); pos.realized += part * (lvl / pos.entry - 1); pos.qtyVal -= part; pos.scaled = true; } }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        const stopLeg = o.closeStop ? leg === "C" : true;
        if (stopLeg && px <= pos.stopPx) {
          reason = pos.rtArmed && pos.stopPx >= pos.entry ? "rt_stop" : pos.stopPx >= pos.entry ? "be_stop" : "stop";
          exitPx = o.closeStop ? (b.o <= pos.stopPx ? gapFill(pos.stopPx, b) : b.c * (1 - SLIP)) : fill(pos.stopPx);
          break;
        }
        if (o.trail) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const v = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        const bounceOk = o.holdUnder == null || b.c >= pos.entry * (1 + o.holdUnder);
        if (v >= o.exitIbs && bounceOk) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (v >= o.exitIbs && !bounceOk) pos.heldBounces = (pos.heldBounces || 0) + 1;
        if (exitPx == null && o.loserTime && b.isLast && b.si >= pos.entrySi + o.loserTime.n && b.c <= pos.entry * (1 + o.loserTime.lvl)) { exitPx = b.c * (1 - SLIP); reason = "time_stop"; }
        if (exitPx == null && b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        const pnlEq = pos.realized + pos.qtyVal * (exitPx / pos.entry - 1);
        trades.push({ sym, d, ret: pnlEq / pos.qty0, pnlEq, reason, heldBounces: pos.heldBounces || 0, sessions: b.si - pos.entrySi });
        if (reason === "be_stop" || reason === "rt_stop") beBlock.set(sym, b.si + 1);
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
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 && o.morningThr != null ? o.morningThr : o.thr;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac * (o.weights ? (o.weights[c.sym] || 1) : 1);
        if (o.vixUp != null && vix && vix.get(c.b.d) >= o.vixUp) frac *= 1.5;
        const size = equity * frac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, qtyVal: size, qty0: size, realized: 0, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx });
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
const rat = (s) => (s && s.dd < 0 ? s.tot / -s.dd : 0);
const ratio = (s) => rat(s).toFixed(2).padStart(5);


// ---- trade statistics: the user's metric is PAYOFF = avg win / avg loss ----
function stats(trades, from, to) {
  const tr = trades.filter((x) => x.d >= from && x.d < to);
  const w = tr.filter((x) => x.ret > 0), l = tr.filter((x) => x.ret <= 0);
  const aw = w.length ? w.reduce((a, x) => a + x.ret, 0) / w.length : 0, al = l.length ? -l.reduce((a, x) => a + x.ret, 0) / l.length : 0;
  return { n: tr.length, wr: tr.length ? w.length / tr.length : 0, aw, al, b: al > 0 ? aw / al : 0, exp: tr.length ? tr.reduce((a, x) => a + x.ret, 0) / tr.length : 0 };
}
function anatomy(trades, from, to, title) {
  const tr = trades.filter((x) => x.d >= from && x.d < to);
  const grossL = -tr.filter((x) => x.ret <= 0).reduce((a, x) => a + x.ret, 0), grossW = tr.filter((x) => x.ret > 0).reduce((a, x) => a + x.ret, 0);
  console.log(`  ${title}: ${tr.length} trades, gross win ${(grossW * 100).toFixed(0)}% vs gross loss ${(grossL * 100).toFixed(0)}%`);
  const by = new Map();
  for (const x of tr) { const k = x.reason + (x.ret > 0 ? " (win)" : " (loss)"); if (!by.has(k)) by.set(k, []); by.get(k).push(x.ret); }
  for (const [k, v] of [...by].sort((a, z) => z[1].length - a[1].length)) {
    const sum = v.reduce((a, x) => a + x, 0), mean = sum / v.length;
    const share = mean > 0 ? sum / grossW : -sum / grossL;
    console.log(`    ${k.padEnd(16)} n ${String(v.length).padStart(4)}  mean ${(mean * 100).toFixed(2).padStart(6)}%  share of gross ${mean > 0 ? "wins  " : "losses"} ${(share * 100).toFixed(0).padStart(3)}%`);
  }
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
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false));
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];
  const WEIGHTS = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };   // armed 2026-08-22 (#3434)
  const LIVE = { ...MONDAY, weights: WEIGHTS };
  const SURF = [["h1", H_START, H_MID, "h"], ["d-fit", FIT[0], FIT[1], "d"], ["h2", H_MID, H_END, "h"], ["d-hold", HOLD[0], HOLD[1], "d"]];
  const run = (cfg) => {
    const h = simulate(hourly, SYMS, cfg, true, vix), d = simulate(daily, SYMS, cfg, false, vix);
    const r = { h, d, s: [], st: [] };
    for (const [, a, z, k] of SURF) { const x = k === "h" ? h : d; r.s.push(score(x.curve, a, z)); r.st.push(stats(x.trades, a, z)); }
    return r;
  };
  const cell = (r, i) => `b ${r.st[i].b.toFixed(2)} wr ${(r.st[i].wr * 100).toFixed(0)}% ${pct(r.s[i].tot, 6)} ÷${ratio(r.s[i])}`;
  const line = (name, r) => `  ${name.padEnd(30)} FIT  h1 ${cell(r, 0)} | d ${cell(r, 1)}   HOLD  h2 ${cell(r, 2)} | d ${cell(r, 3)}`;
  const base = run(LIVE);
  console.log("BASELINE — live stack (Monday + tilt).  b = avg win / avg loss (target >= 1.00)");
  console.log(line("live", base));
  console.log("\nANATOMY — where the loss side comes from (recent hourly year, then daily holdout)");
  anatomy(base.h.trades, H_MID, H_END, "hourly h2");
  anatomy(base.d.trades, HOLD[0], HOLD[1], "daily 2015-2026");
  const aw = base.st[2].aw, al = base.st[2].al;
  console.log(`  h2: avg win ${(aw * 100).toFixed(2)}%  avg loss ${(al * 100).toFixed(2)}%  -> to reach 1:1 the avg loss must fall to ${(aw * 100).toFixed(2)}% or the avg win rise to ${(al * 100).toFixed(2)}%`);

  const fitScore = (r) => rat(r.s[0]) / rat(base.s[0]) + rat(r.s[1]) / rat(base.s[1]);
  const sweep = (title, variants) => {
    console.log(`\n${title}`);
    const rows = variants.map(([name, cfg]) => ({ name, r: run(cfg) }));
    for (const x of rows) console.log(line(x.name, x.r));
    const w = rows.slice().sort((a, z) => fitScore(z.r) - fitScore(a.r))[0];
    const hOk = rat(w.r.s[2]) >= rat(base.s[2]) * 0.98 && rat(w.r.s[3]) >= rat(base.s[3]) * 0.98;
    const oneToOne = rows.filter((x) => x.r.st[2].b >= 1 && x.r.st[3].b >= 1);
    console.log(`  → fit winner (return/DD): ${w.name}${/\(live\)/.test(w.name) || w.name === "live" ? " — the live setting" : ` — holdout ${hOk ? "CONFIRMS" : "REJECTS"} (h2 ÷${ratio(w.r.s[2])} vs ${ratio(base.s[2])}, d ÷${ratio(w.r.s[3])} vs ${ratio(base.s[3])})`}`);
    console.log(`  → payoff >= 1.00 on BOTH holdout surfaces: ${oneToOne.length ? oneToOne.map((x) => `${x.name} [h2 ÷${ratio(x.r.s[2])}, d ÷${ratio(x.r.s[3])}]`).join("; ") : "none"}`);
    return rows;
  };
  sweep("A. RATCHET TRAIL — after the +1% floor, the stop follows the peak (arm% / distance from peak)", [
    ["live (floor only)", LIVE],
    ["rt arm1.5 / 0.75%", { ...LIVE, rt: { arm: 1.5, pct: 0.75 } }], ["rt arm1.5 / 1.0%", { ...LIVE, rt: { arm: 1.5, pct: 1.0 } }], ["rt arm1.5 / 1.5%", { ...LIVE, rt: { arm: 1.5, pct: 1.5 } }],
    ["rt arm1.0 / 0.5%", { ...LIVE, rt: { arm: 1.0, pct: 0.5 } }], ["rt arm1.0 / 0.75%", { ...LIVE, rt: { arm: 1.0, pct: 0.75 } }], ["rt arm2.0 / 1.0%", { ...LIVE, rt: { arm: 2.0, pct: 1.0 } }], ["rt arm2.5 / 1.5%", { ...LIVE, rt: { arm: 2.5, pct: 1.5 } }],
  ]);
  sweep("B. HOLD UNDERWATER BOUNCES — the bounce exit only sells at or above a floor; below it the position waits for stop/timeout/better bounce", [
    ["live (sell any bounce)", LIVE],
    ["hold if below entry", { ...LIVE, holdUnder: 0 }], ["hold if below -0.5%", { ...LIVE, holdUnder: -0.005 }], ["hold if below -1%", { ...LIVE, holdUnder: -0.01 }], ["hold if below +0.5%", { ...LIVE, holdUnder: 0.005 }],
  ]);
  sweep("C. CLOSE-BASED STOP — stop fires on a bar close through the level, not an intrabar touch", [
    ["live (intrabar 3%)", LIVE], ["close-stop 3%", { ...LIVE, closeStop: true }], ["close-stop 2.5%", { ...LIVE, closeStop: true, stopPct: 0.025 }], ["close-stop 2%", { ...LIVE, closeStop: true, stopPct: 0.02 }],
  ]);
  sweep("D. TIME-STOP ON LOSERS — at the close of session entry+n, a position still down <= lvl exits", [
    ["live (5-session timeout)", LIVE],
    ["n1 / -1%", { ...LIVE, loserTime: { n: 1, lvl: -0.01 } }], ["n1 / -2%", { ...LIVE, loserTime: { n: 1, lvl: -0.02 } }], ["n2 / -1%", { ...LIVE, loserTime: { n: 2, lvl: -0.01 } }], ["n2 / -2%", { ...LIVE, loserTime: { n: 2, lvl: -0.02 } }], ["n3 / -1%", { ...LIVE, loserTime: { n: 3, lvl: -0.01 } }], ["n2 / 0% (flat-or-worse)", { ...LIVE, loserTime: { n: 2, lvl: 0 } }],
  ]);
  sweep("E. SCALE-OUT — sell part at the +1% floor, run the rest", [
    ["live (all-or-nothing)", LIVE], ["half at +1%", { ...LIVE, scaleOut: { at: 0.01, frac: 0.5 } }], ["half at +1% + rt 1.5/1.0", { ...LIVE, scaleOut: { at: 0.01, frac: 0.5 }, rt: { arm: 1.5, pct: 1.0 } }], ["third at +1.5%", { ...LIVE, scaleOut: { at: 0.015, frac: 0.34 } }],
  ]);
  sweep("F. COMBINATIONS of the per-lever candidates", [
    ["live", LIVE],
    ["rt 1.5/1.0 + hold<entry", { ...LIVE, rt: { arm: 1.5, pct: 1.0 }, holdUnder: 0 }],
    ["rt 1.5/1.0 + time n2/-1%", { ...LIVE, rt: { arm: 1.5, pct: 1.0 }, loserTime: { n: 2, lvl: -0.01 } }],
    ["hold<entry + time n2/-1%", { ...LIVE, holdUnder: 0, loserTime: { n: 2, lvl: -0.01 } }],
    ["rt + hold + time", { ...LIVE, rt: { arm: 1.5, pct: 1.0 }, holdUnder: 0, loserTime: { n: 2, lvl: -0.01 } }],
  ]);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
