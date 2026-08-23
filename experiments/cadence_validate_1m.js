/**
 * cadence_validate_1m.js — does the touch model hold at 1-minute resolution?
 * cadence_lab.js prices the engine's 60s-scan behaviour as an intrabar crossing
 * on hourly bars and finds the strategy has no edge at that cadence. Before
 * acting on that, validate the MODEL: on the same ~20 sessions, run the engine
 * analog on true 1-minute closes (with the engine's 2-scan persistence) and the
 * touch/close models on 5m, 15m and 1h bars. If the 1m analog lands near the
 * touch rows the model is sound; if it lands near the close rows, touch mode
 * overstates the penalty. Usage: node experiments/cadence_validate_1m.js
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
function annotate(bars, intraday, intervalMs = 3600 * 1000) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = intraday ? ET_DAY(b.t) : new Date(b.t).toISOString().slice(0, 10);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    b.prevH = runH; b.prevL = runL; runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = intraday ? ET_HM(b.t + intervalMs) : 960;
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

// ---- simulator: payoff_lab engine + entry/exit cadence modes ----
//   o.entryMode  'close' | 'touch'    touch: buy at the first intrabar crossing of IBS<=thr (gap-down open below it fills at the open)
//   o.exitMode   'close' | 'touch'    touch: sell at the first intrabar crossing of IBS>=exitIbs (gap-up open above it fills at the open)
//   o.persistBars n                   touch entry requires the crossing to be confirmed n bars later? (no — engine persistence is ~2 min; ignored)
function simulate(barsBySym, syms, cfg, intraday, vix, from, to) {
  const o = { entryMode: "close", exitMode: "close", ...cfg };
  const tsSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) if ((!from || b.d >= from) && (!to || b.d < to)) tsSet.add(b.t);
  const timeline = [...tsSet].sort((a, b) => a - b);
  const idx = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b) => [b.t, b]))]));
  const posOf = Object.fromEntries(syms.map((s) => [s, new Map(barsBySym[s].map((b, i) => [b.t, i]))]));
  const prevIbs = (sym, b, n) => { const i = posOf[sym].get(b.t); const out = []; for (let k = 1; k <= n; k++) { const p = barsBySym[sym][i - k]; if (!p || p.d !== b.d) return [NaN]; out.push(rIbs(p)); } return out; };
  let cash = 100;
  const open = new Map(), trades = [], curve = [];
  const beBlock = new Map();
  const gapFill = (level, b) => Math.min(level, b.o) * (1 - SLIP);
  // price at which the session IBS first equals x inside bar b, given the within-bar leg order. null = never inside this bar.
  const crossUp = (b, x) => {   // rising through x: uses the running range before the rise
    const first = b.c >= b.o ? "L" : "H";
    const sL = first === "L" ? Math.min(b.prevL, b.l, b.o) : Math.min(b.prevL, b.o);
    const sH = Math.max(b.prevH, b.o);
    if (!(sH > sL)) return null;
    const lvl = sL + x * (sH - sL);
    if (b.o >= lvl && (b.o - sL) / (Math.max(b.prevH, b.o) - sL || 1) >= x) return b.o;   // already above at the open
    return b.h >= lvl ? Math.max(lvl, b.o) : null;
  };
  const crossDown = (b, x) => {  // falling through x: the session high may extend first on a down bar
    const first = b.c >= b.o ? "L" : "H";
    const sH = first === "H" ? Math.max(b.prevH, b.h, b.o) : Math.max(b.prevH, b.o);
    const sL = Math.min(b.prevL, b.o);
    if (!(sH > sL)) return null;
    const lvl = sL + x * (sH - sL);
    if (b.o <= lvl) return b.o;
    return b.l <= lvl ? Math.min(lvl, b.o) : null;
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
          if (o.rt) { const g = (pos.peak / pos.entry - 1) * 100; if (g >= o.rt.arm) { const want = pos.peak * (1 - o.rt.pct / 100); if (pos.stopPx < want) { pos.stopPx = want; pos.rtArmed = true; } } }
          // touch exit: the bounce crossing happens on the way up to H
          if (o.exitMode === "touch" && intraday && exitPx == null) {
            const px = crossUp(b, o.exitIbs);
            if (px != null) { exitPx = px * (1 - SLIP); reason = "bounce"; break; }
          }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (px <= pos.stopPx) { reason = pos.rtArmed && pos.stopPx >= pos.entry ? "rt_stop" : pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.trail) {
          const g = (pos.peak / pos.entry - 1) * 100;
          if (g >= o.trail.arm) { const lvl = pos.peak * (1 - trailTrig(g, o.trail.pct) / 100); if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; } }
        }
      }
      const v = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (o.exitMode === "close" && v >= o.exitIbs && (o.exitDecisionFlag ? b[o.exitDecisionFlag] : (!(o.persistBars > 1) || prevIbs(sym, b, o.persistBars - 1).every((x) => x >= o.exitIbs)))) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && b.isLast) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, pnlEq: pos.qtyVal * (exitPx / pos.entry - 1), reason, sessions: b.si - pos.entrySi });
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
        if (intraday && o.skipWindow && b.closeMin >= o.skipWindow[0] && b.closeMin < o.skipWindow[1]) continue;
        if (intraday && o.skipHours && o.skipHours.has(b.hour)) continue;
        const thr = intraday && b.closeMin < 660 && o.morningThr != null ? o.morningThr : o.thr;
        if (o.entryMode === "touch" && intraday) {
          const px = crossDown(b, thr);
          if (px != null) cands.push({ sym, b, v: (px - Math.min(b.prevL, b.l)) / ((Math.max(b.prevH, b.h) - Math.min(b.prevL, b.l)) || 1), px });
        } else {
          if (o.entryDecisionFlag && !b[o.entryDecisionFlag]) continue;
          const v = intraday ? rIbs(b) : dIbs(b);
          const pv = o.persistBars > 1 && !o.entryDecisionFlag ? prevIbs(sym, b, o.persistBars - 1) : null;
          if (v <= thr && (pv == null || pv.every((x) => x <= thr))) cands.push({ sym, b, v, px: b.c });
        }
      }
      cands.sort((a, z) => a.v - z.v);
      for (const c of cands) {
        if (open.size >= o.maxConc) break;
        let frac = o.sizeFrac * (o.weights ? (o.weights[c.sym] || 1) : 1);
        if (o.vixUp != null && vix && vix.get(c.b.d) >= o.vixUp) frac *= 1.5;
        const size = equity * frac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = c.px * (1 + ENTRY_SLIP);
        // a touch entry is filled INSIDE the bar: the same bar's later legs can already stop it out / bounce it. Model: entryT = bar start so the
        // next bar is the first managed one, but apply this bar's post-entry low to the stop (down bar: L comes after the crossing).
        const pos = { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx };
        if (o.entryMode === "touch" && intraday && c.b.l <= pos.stopPx && c.b.c < c.b.o) {
          const exitPx = gapFill(pos.stopPx, { o: c.px }); cash += size * (exitPx / entryPx);
          trades.push({ sym: c.sym, d, ret: exitPx / entryPx - 1, pnlEq: size * (exitPx / entryPx - 1), reason: "stop", sessions: 0 });
          continue;
        }
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



async function chart1m(sym, p1, p2) {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&period1=${p1}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error("no 1m data for " + sym);
  const q = r.indicators.quote[0], out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    const m = ET_HM(r.timestamp[i] * 1000);
    if (m < 570 || m >= 960) continue;   // regular session only (the engine's session IBS is RTH-only since #3430)
    out.push({ t: r.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}

(async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const one = {}, five = {}, fifteen = {}, hourly = {};
  for (const s of SYMS) {
    let bars = [];
    for (let back = 29; back > 0; back -= 7) {   // 8-day chunks, newest last
      const p1 = nowSec - back * 86400, p2 = Math.min(nowSec, nowSec - (back - 7) * 86400);
      try { bars = bars.concat(await chart1m(s, p1, p2)); } catch (e) { /* chunk unavailable */ }
    }
    const seen = new Set(); bars = bars.filter((b) => (seen.has(b.t) ? false : (seen.add(b.t), true))).sort((a, b) => a.t - b.t);
    one[s] = annotate(bars, true, 60 * 1000);
    five[s] = annotate(await chart(s, "5m", nowSec - 58 * 86400), true, 5 * 60 * 1000);
    fifteen[s] = annotate(await chart(s, "15m", nowSec - 58 * 86400), true, 15 * 60 * 1000);
    hourly[s] = annotate(await chart(s, "1h", nowSec - 120 * 86400), true);
  }
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", nowSec - 200 * 86400), false));
  const days = [...new Set(one.SPY.map((b) => b.d))].sort();
  const from = days[0], to = "2099-01-01";
  console.log(`1m window ${from}..${days[days.length - 1]} (${days.length} sessions, ${one.SPY.length} SPY bars); 5m/15m/1h clipped to the same window`);
  const WEIGHTS = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };
  const LIVE = { ...MONDAY, weights: WEIGHTS, skipHours: null, skipWindow: [810, 870] };
  const cellS = (r) => { const s = score(r.curve, from, to), st = stats(r.trades, from, to); return `n ${String(st.n).padStart(4)} wr ${(st.wr * 100).toFixed(0)}% aw ${(st.aw * 100).toFixed(2)}% al ${(st.al * 100).toFixed(2)}% b ${st.b.toFixed(2)}  ${pct(s ? s.tot : 0, 6)} dd ${pct(s ? s.dd : 0, 5)}`; };
  const row = (name, bars, cfg) => console.log(`  ${name.padEnd(44)} ${cellS(simulate(bars, SYMS, cfg, true, vix, from, to))}`);
  console.log("\nENGINE ANALOG — 1-minute closes");
  row("1m close/close, persist 1", one, { ...LIVE, entryMode: "close", exitMode: "close" });
  row("1m close/close, persist 2 (TRADER_PERSIST_SCANS)", one, { ...LIVE, entryMode: "close", exitMode: "close", persistBars: 2 });
  row("1m close/close, persist 5", one, { ...LIVE, entryMode: "close", exitMode: "close", persistBars: 5 });
  row("1m touch/touch", one, { ...LIVE, entryMode: "touch", exitMode: "touch" });
  console.log("\nTHE LAB'S MODELS on coarser bars, same days");
  for (const [iv, bars] of [["5m", five], ["15m", fifteen], ["1h", hourly]]) {
    row(`${iv} close/close`, bars, { ...LIVE, entryMode: "close", exitMode: "close" });
    row(`${iv} touch/touch`, bars, { ...LIVE, entryMode: "touch", exitMode: "touch" });
  }
  console.log("\nBAR-CLOSE CONFIRMATION on the 1m stream — the candidate engine change (signals sampled only at :k boundaries)");
  const sampled = (k, off, extra = {}) => { const conf = {}; for (const s of SYMS) conf[s] = one[s].filter((b) => (b.closeMin - off) % k === 0 || b.isLast); return conf; };
  for (const k of [5, 15, 30, 60]) row(`sample every ${k}m (1m data, ${k}m decisions)`, sampled(k, 0), { ...LIVE, entryMode: "close", exitMode: "close" });
  console.log("\nPHASE / CADENCE ROBUSTNESS — is hourly sampling a lucky phase?");
  for (const [k, off] of [[60, 0], [60, 15], [60, 30], [60, 45], [30, 0], [30, 15], [45, 0], [90, 0], [120, 0], [195, 0], [390, 0]]) {
    const lab = k === 390 ? "session close only (daily IBS)" : `every ${k}m at :${String(off).padStart(2, "0")}`;
    row(lab, sampled(k, off), { ...LIVE, entryMode: "close", exitMode: "close" });
  }
  console.log("\nSPLIT: entry cadence vs exit cadence (60m at :00 for the sampled side, 1m persist-2 for the other)");
  const hourlyOnly = sampled(60, 0);
  // entry on hourly closes, exit on the 1m stream: mark which 1m bars are decision bars and let the sim use them
  for (const s of SYMS) for (const b of one[s]) b.dec60 = b.closeMin % 60 === 0 || b.isLast;
  row("entry 60m / exit 1m persist 2", one, { ...LIVE, entryMode: "close", exitMode: "close", persistBars: 2, entryDecisionFlag: "dec60" });
  row("entry 1m persist 2 / exit 60m", one, { ...LIVE, entryMode: "close", exitMode: "close", persistBars: 2, exitDecisionFlag: "dec60" });
  console.log("\nENTRY CONFIRMATION ACROSS PHASES — entry only on a k-minute close, exit on the 1m stream (persist 2)");
  for (const [k, off] of [[60, 0], [60, 15], [60, 30], [60, 45], [30, 0], [30, 15], [90, 0], [90, 30], [120, 0]]) {
    const flag = `dec_${k}_${off}`;
    for (const s of SYMS) for (const b of one[s]) b[flag] = (b.closeMin - off) % k === 0 || b.isLast;
    row(`entry every ${k}m at :${String(off).padStart(2, "0")} / exit 1m`, one, { ...LIVE, entryMode: "close", exitMode: "close", persistBars: 2, entryDecisionFlag: flag });
  }
})().catch((e) => { console.error("validate failed:", e.message); process.exit(1); });
