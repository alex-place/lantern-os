/**
 * payoff2_lab.js — toward 2:1 at WR >= 60% (round 11, 2026-08-23). Operator:
 * "the goal is the 2:1 ratio, as close as we can while maintaining a 60%+ win
 * rate; account for news / market sentiment; losses are still too big."
 *   A. RUNNER — let big winners run past the bounce (bigger average win).
 *   B. STRUCTURAL STOP — the washout is invalidated when the session low breaks:
 *      stop just under the session low instead of a flat 3% (smaller average
 *      loss); with and without a 2R target.
 *   C. EVENT CALENDAR — the measurable form of "news": FOMC statement days
 *      (scraped from federalreserve.gov, data/research/fomc-statement-days.json),
 *      payrolls Fridays, OPEX; skip or half-size entries on/around them.
 *   D. MARKET STREAK — SPY consecutive down closes at entry: panic vs dip.
 *   E. Combinations. Every row prints payoff b, WR, return, return/DD on the four
 *      surfaces; each sweep names the best payoff among variants that keep
 *      WR >= 60% on BOTH holdouts, beside the usual fit-winner / holdout verdict.
 * Built on round7_lab.js (armed stack: tilt, slot order, floor, trail, 3% stop, bounce exit 0.6).
 * Usage: node experiments/payoff2_lab.js
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

// ---- simulator: payoff_lab engine + ladder / stop / overnight / market-wide levers ----
//   o.noBounce      bool          the IBS>=exitIbs bounce exit is suppressed (ladder-owned exit)
//   o.tp            pct           sell at entry*(1+tp) (R1 fallback +3%); o.giveback {arm, frac}: once peak >= entry*(1+arm), exit when price <= entry + (1-frac)*(peak-entry)
//   o.stopPct       null          no stop at all
//   o.minSessions   n             the bounce exit may fire only from session entry+n on (1 = hold at least overnight)
//   o.nextClose     bool          exit at the close of session entry+1 regardless (Pagonidis), stop/floor still rule
//   o.spyGate       x             enter only if SPY's session IBS <= x on the same bar; o.spyHalf x: size x0.5 when SPY IBS > x
function simulate(barsBySym, syms, cfg, intraday, vix, from, to) {
  const o = { ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if ((!from || b.d >= from) && (!to || b.d < to)) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  const spyIdx = barsBySym.SPY ? new Map(barsBySym.SPY.map((b) => [b.t, b])) : null;
  const spyStreakOf = (d) => (o.spyStreakMap ? (o.spyStreakMap.get(d) ?? null) : null);
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
      if (o.scaleIn && !pos.added && b.si <= pos.entrySi + (o.scaleIn.sessions || 0)) {
        const lim = pos.entry0 * (1 - o.scaleIn.depth);
        if (b.l <= lim && pos.stopPx != null && lim > pos.stopPx) {
          const addPx = Math.min(lim, b.o), addVal = pos.qtyVal0 * o.scaleIn.addFrac;
          if (addVal <= cash) {
            cash -= addVal;
            // blended entry: weight by value-at-entry
            const sh0 = pos.qtyVal / pos.entry, sh1 = addVal / addPx;
            pos.entry = (pos.qtyVal + addVal) / (sh0 + sh1);
            pos.qtyVal += addVal; pos.added = true; pos.peak = Math.max(pos.peak, pos.entry);
          }
        }
      }
      for (const leg of legs) {
        if (leg === "H") {
          pos.peak = Math.max(pos.peak, b.h);
          if (o.be != null && b.h >= pos.entry * (1 + o.be)) { const want = pos.entry * (1 + o.lock); if (pos.stopPx != null && pos.stopPx < want) pos.stopPx = want; else if (pos.stopPx == null) pos.stopPx = want; }
          if (o.tp != null && b.h >= pos.entry * (1 + o.tp)) { reason = "tp"; exitPx = Math.max(pos.entry * (1 + o.tp), b.o) * (1 - SLIP); break; }
          if (pos.tpPx != null && b.h >= pos.tpPx) { reason = "tp"; exitPx = Math.max(pos.tpPx, b.o) * (1 - SLIP); break; }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (pos.stopPx != null && px <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.giveback && pos.peak >= pos.entry * (1 + o.giveback.arm)) {
          const lvl = pos.entry + (1 - o.giveback.frac) * (pos.peak - pos.entry);
          if (px <= lvl) { reason = "giveback"; exitPx = fill(lvl); break; }
        }
        if (o.trail) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const v = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        const sessOk = o.minSessions == null || b.si >= pos.entrySi + o.minSessions;
        const runnerHold = o.runner != null && (b.c / pos.entry - 1) >= o.runner;
        if (!o.noBounce && sessOk && v >= o.exitIbs && !runnerHold) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (o.nextClose && b.isLast && b.si >= pos.entrySi + 1) { exitPx = b.c * (1 - SLIP); reason = "next_close"; }
        else if (o.decarry && o.decarry.has(sym) && b.isLast) { exitPx = b.c * (1 - SLIP); reason = "decarry"; }
        else if (b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, pnlEq: pos.qtyVal * (exitPx / pos.entry - 1), reason, sessions: b.si - pos.entrySi });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) { const b = idx[sym].get(t); equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry); }
    if (open.size < o.maxConc) {
      const cands = [];
      const spyB = spyIdx ? spyIdx.get(t) : null;
      const spyV = spyB ? (intraday ? rIbs(spyB) : dIbs(spyB)) : null;
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        if (intraday && o.skipHours && o.skipHours.has(b.hour)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 && o.morningThr != null ? o.morningThr : o.thr;
        if (v > thr) continue;
        if (o.spyGate != null && spyV != null && spyV > o.spyGate) continue;
        if (o.skipDay && o.skipDay(b.d)) continue;
        if (o.spyStreak) { const k = spyStreakOf(b.d); if (k == null || k < o.spyStreak[0] || k > o.spyStreak[1]) continue; }
        cands.push({ sym, b, v, idio: o.spyHalf != null && spyV != null && spyV > o.spyHalf });
      }
      if (o.slotOrder === "expectancy") cands.sort((a, z) => ((o.weights || {})[z.sym] || 1) - ((o.weights || {})[a.sym] || 1) || a.v - z.v);
      else if (o.slotOrder === "shallow") cands.sort((a, z) => z.v - a.v);
      else if (o.slotOrder === "alpha") cands.sort((a, z) => (a.sym < z.sym ? -1 : 1));
      else cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac * (o.weights ? (o.weights[c.sym] || 1) : 1);
        if (o.vixUp != null && vix && vix.get(c.b.d) >= o.vixUp) frac *= 1.5;
        if (c.idio) frac *= 0.5;
        if (o.halfDay && o.halfDay(c.b.d)) frac *= 0.5;
        if (o.streakMult) { const k = spyStreakOf(c.b.d); if (k != null && k >= o.streakMult.min) frac *= o.streakMult.mult; }
        const full = equity * frac;
        const size = o.scaleIn ? full * o.scaleIn.firstFrac : full;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        let stopPx = o.stopPct == null ? null : entryPx * (1 - o.stopPct);
        if (o.structBuf != null && c.b.runL > 0) { const sl = c.b.runL * (1 - o.structBuf); if (stopPx == null || sl > stopPx) stopPx = sl; }
        const pos = { entry: entryPx, entry0: entryPx, qtyVal: size, qtyVal0: full, stopPx, entrySi: c.b.si, entryT: c.b.t, peak: entryPx };
        if (o.rTarget != null && stopPx != null) pos.tpPx = entryPx + o.rTarget * (entryPx - stopPx);
        open.set(c.sym, pos);
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



const FOMC = new Set(require("fs").readFileSync(require("path").join(__dirname, "..", "data", "research", "fomc-statement-days.json"), "utf8") ? JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "data", "research", "fomc-statement-days.json"), "utf8")) : []);
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const nthFriday = (d, n) => { const x = new Date(d + "T12:00:00Z"); if (x.getUTCDay() !== 5) return false; const day = x.getUTCDate(); return Math.ceil(day / 7) === n; };
const isNFP = (d) => nthFriday(d, 1);
const isOPEX = (d) => nthFriday(d, 3);
const nextDay = (set) => { const out = new Set(); for (const d of set) { const x = new Date(d + "T12:00:00Z"); do { x.setUTCDate(x.getUTCDate() + 1); } while (x.getUTCDay() === 0 || x.getUTCDay() === 6); out.add(x.toISOString().slice(0, 10)); } return out; };
const prevDay = (set) => { const out = new Set(); for (const d of set) { const x = new Date(d + "T12:00:00Z"); do { x.setUTCDate(x.getUTCDate() - 1); } while (x.getUTCDay() === 0 || x.getUTCDay() === 6); out.add(x.toISOString().slice(0, 10)); } return out; };
const FOMC_NEXT = nextDay(FOMC), FOMC_PREV = prevDay(FOMC);

(async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) { hourly[s] = annotate(await chart(s, "1h", nowSec - 720 * 86400), true); daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false); }
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false));
  // SPY consecutive down-close streak ending the prior session, keyed by the session date
  const spyStreakMap = new Map();
  { const ds = daily.SPY; let k = 0; for (let i = 1; i < ds.length; i++) { spyStreakMap.set(ds[i].d, k); k = ds[i].c < ds[i - 1].c ? k + 1 : 0; } }
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", END];
  const W = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };
  const ARMED = { ...MONDAY, weights: W, slotOrder: "expectancy", spyStreakMap };
  const SURF = [["h1", H_START, H_MID, "h"], ["d-fit", FIT[0], FIT[1], "d"], ["h2", H_MID, END, "h"], ["d-hold", HOLD[0], HOLD[1], "d"]];
  const run = (cfg) => { const h = simulate(hourly, SYMS, cfg, true, vix), d = simulate(daily, SYMS, cfg, false, vix); const r = { h, d, s: [], st: [] }; for (const [, a, z, k] of SURF) { const x = k === "h" ? h : d; r.s.push(score(x.curve, a, z)); r.st.push(stats(x.trades, a, z)); } return r; };
  const cell = (r, i) => `b ${r.st[i].b.toFixed(2)} wr ${(r.st[i].wr * 100).toFixed(0)}% ${pct(r.s[i].tot, 6)} ÷${ratio(r.s[i])}`;
  const line = (n, r) => `  ${n.padEnd(36)} h1 ${cell(r, 0)} | d-fit ${cell(r, 1)} | h2 ${cell(r, 2)} | d-hold ${cell(r, 3)}`;
  const base = run(ARMED);
  const fitScore = (r) => rat(r.s[0]) / rat(base.s[0]) + rat(r.s[1]) / rat(base.s[1]);
  const sweep = (title, variants) => {
    console.log(`\n${title}`);
    const rows = variants.map(([name, cfg]) => ({ name, r: run(cfg) }));
    for (const x of rows) console.log(line(x.name, x.r));
    const w = rows.slice().sort((a, z) => fitScore(z.r) - fitScore(a.r))[0];
    const hOk = rat(w.r.s[2]) >= rat(base.s[2]) * 0.98 && rat(w.r.s[3]) >= rat(base.s[3]) * 0.98;
    const goal = rows.filter((x) => x.r.st[2].wr >= 0.6 && x.r.st[3].wr >= 0.6).sort((a, z) => (z.r.st[2].b + z.r.st[3].b) - (a.r.st[2].b + a.r.st[3].b))[0];
    console.log(`  → fit winner (return/DD): ${w.name}${/armed/.test(w.name) ? " — the armed setting" : ` — holdout ${hOk ? "CONFIRMS" : "REJECTS"} (h2 ÷${ratio(w.r.s[2])} vs ${ratio(base.s[2])}, d ÷${ratio(w.r.s[3])} vs ${ratio(base.s[3])})`}`);
    if (goal) console.log(`  → best payoff with WR >= 60% on both holdouts: ${goal.name} (h2 b ${goal.r.st[2].b.toFixed(2)} wr ${(goal.r.st[2].wr * 100).toFixed(0)}%, d-hold b ${goal.r.st[3].b.toFixed(2)} wr ${(goal.r.st[3].wr * 100).toFixed(0)}%)`);
    return rows;
  };
  console.log("TARGET: payoff (avg win / avg loss) toward 2:1 with WR >= 60%.  Armed stack:");
  console.log(line("armed", base));
  sweep("A. RUNNER — skip the bounce exit while the position is up >= x (trail 1.5/2.5% tightening, floor, stop and timeout own the exit)", [
    ["armed (bounce always sells)", ARMED], ["runner >= 1%", { ...ARMED, runner: 0.01 }], ["runner >= 2%", { ...ARMED, runner: 0.02 }], ["runner >= 3%", { ...ARMED, runner: 0.03 }], ["runner >= 2% + tight trail 1.0% after 1.5%", { ...ARMED, runner: 0.02, trail: { arm: 1.5, pct: 1.0 } }],
  ]);
  sweep("B. STRUCTURAL STOP — stop = max(entry-3%, session low - buf): the washout is invalidated when its low breaks; ± a 2R target", [
    ["armed (3% stop)", ARMED], ["struct buf 1.0%", { ...ARMED, structBuf: 0.01 }], ["struct buf 0.5%", { ...ARMED, structBuf: 0.005 }], ["struct buf 0.25%", { ...ARMED, structBuf: 0.0025 }],
    ["struct 0.5% + 2R target", { ...ARMED, structBuf: 0.005, rTarget: 2 }], ["struct 1.0% + 2R target", { ...ARMED, structBuf: 0.01, rTarget: 2 }], ["3% stop + 2R target (6%)", { ...ARMED, rTarget: 2 }],
  ]);
  sweep("C. EVENT CALENDAR — scheduled news: FOMC statement days (215, scraped), payrolls Fridays, OPEX; skip or half-size entries", [
    ["armed (no calendar)", ARMED],
    ["skip FOMC day", { ...ARMED, skipDay: (d) => FOMC.has(d) }], ["skip day BEFORE FOMC", { ...ARMED, skipDay: (d) => FOMC_PREV.has(d) }], ["skip day AFTER FOMC", { ...ARMED, skipDay: (d) => FOMC_NEXT.has(d) }],
    ["skip payrolls Friday", { ...ARMED, skipDay: isNFP }], ["skip OPEX Friday", { ...ARMED, skipDay: isOPEX }], ["skip all event days", { ...ARMED, skipDay: (d) => FOMC.has(d) || isNFP(d) || isOPEX(d) }],
    ["half size on event days", { ...ARMED, halfDay: (d) => FOMC.has(d) || isNFP(d) || isOPEX(d) }],
  ]);
  sweep("D. MARKET STREAK at entry — SPY consecutive down closes ending the prior session (panic vs dip)", [
    ["armed (any streak)", ARMED], ["streak 0 only (SPY up yesterday)", { ...ARMED, spyStreak: [0, 0] }], ["streak 1-2", { ...ARMED, spyStreak: [1, 2] }], ["streak >= 3 only (panic)", { ...ARMED, spyStreak: [3, 99] }], ["skip streak >= 3", { ...ARMED, spyStreak: [0, 2] }], ["skip streak >= 5", { ...ARMED, spyStreak: [0, 4] }],
  ]);
  sweep("E. TOWARD 2:1 — combinations", [
    ["armed", ARMED],
    ["runner 2% + struct 1.0%", { ...ARMED, runner: 0.02, structBuf: 0.01 }],
    ["runner 2% + struct 0.5%", { ...ARMED, runner: 0.02, structBuf: 0.005 }],
    ["runner 1% + struct 1.0% + 2R", { ...ARMED, runner: 0.01, structBuf: 0.01, rTarget: 2 }],
    ["runner 2% + skip FOMC day", { ...ARMED, runner: 0.02, skipDay: (d) => FOMC.has(d) }],
  ]);
  sweep("F. SENTIMENT TILT — size UP after SPY down-close streaks (the panic days win 78%); stacks with the VIX stress multiplier", [
    ["armed", ARMED], ["streak >= 3: x1.5", { ...ARMED, streakMult: { min: 3, mult: 1.5 } }], ["streak >= 3: x2", { ...ARMED, streakMult: { min: 3, mult: 2 } }], ["streak >= 2: x1.5", { ...ARMED, streakMult: { min: 2, mult: 1.5 } }], ["streak >= 4: x2", { ...ARMED, streakMult: { min: 4, mult: 2 } }],
    ["streak >= 3: x1.5, no VIX stress", { ...ARMED, vixUp: null, streakMult: { min: 3, mult: 1.5 } }],
  ]);
  console.log("\nEXIT ANATOMY (hourly h2) — armed vs runner 2% vs struct 1.0%");
  for (const [name, cfg] of [["armed", ARMED], ["runner 2%", { ...ARMED, runner: 0.02 }], ["struct 1.0%", { ...ARMED, structBuf: 0.01 }]]) anatomy(run(cfg).h.trades, H_MID, END, name);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
