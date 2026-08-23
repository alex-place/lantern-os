"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const LEV = ["TQQQ", "TNA", "SPXL", "UPRO"];
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
        if (!o.noBounce && sessOk && v >= o.exitIbs) { exitPx = b.c * (1 - SLIP); reason = "bounce"; }
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
        const full = equity * frac;
        const size = o.scaleIn ? full * o.scaleIn.firstFrac : full;
        if (size > cash) continue;
        if (o.grossCap != null && (equity - cash + size) > equity * o.grossCap) continue;   // engine: TRADER_MAX_GROSS_PCT skips entries past the cap
        cash -= size;
        const entryPx = c.b.c * (1 + ENTRY_SLIP);
        open.set(c.sym, { entry: entryPx, entry0: entryPx, qtyVal: size, qtyVal0: full, stopPx: o.stopPct == null ? null : entryPx * (1 - o.stopPct), entrySi: c.b.si, entryT: c.b.t, peak: entryPx });
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



(async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const ALL = [...SYMS, ...LEV];
  const hourly = {}, daily = {};
  for (const s of ALL) { hourly[s] = annotate(await chart(s, "1h", nowSec - 720 * 86400), true); daily[s] = annotate(await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false); }
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000)), false));
  const H_START = hourly.SPY[0].d, H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", END];
  const W = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };
  const ARMED = { ...MONDAY, weights: W, slotOrder: "expectancy" };
  const SURF = [["h1", H_START, H_MID, "h"], ["d-fit", FIT[0], FIT[1], "d"], ["h2", H_MID, END, "h"], ["d-hold", HOLD[0], HOLD[1], "d"]];
  const run = (cfg, syms) => { const h = simulate(hourly, syms, cfg, true, vix), d = simulate(daily, syms, cfg, false, vix); const r = { h, d, s: [], st: [] }; for (const [, a, z, k] of SURF) { const x = k === "h" ? h : d; r.s.push(score(x.curve, a, z)); r.st.push(stats(x.trades, a, z)); } return r; };
  const cell = (r, i) => `b ${r.st[i].b.toFixed(2)} ${pct(r.s[i].tot, 6)} ÷${ratio(r.s[i])} dd ${pct(r.s[i].dd, 5)}`;
  const line = (n, r) => `  ${n.padEnd(30)} h1 ${cell(r, 0)} | d-fit ${cell(r, 1)} | h2 ${cell(r, 2)} | d-hold ${cell(r, 3)}`;
  console.log("SOXL UNDER THE ARMED STACK — PR #3396 would block 3x entries by default");
  const base = run(ARMED, SYMS);
  const noSoxl = run(ARMED, SYMS.filter((s) => s !== "SOXL"));
  line; console.log(line("armed (SOXL 1.5x)", base)); console.log(line("SOXL at 1.0x", run({ ...ARMED, weights: { ...W, SOXL: 1.0 } }, SYMS))); console.log(line("NO SOXL (#3396 default)", noSoxl));
  // SOXL alone: per-trade statistics under the armed exits
  for (const [label, from, to, k] of SURF) { const tr = (k === "h" ? base.h : base.d).trades.filter((x) => x.sym === "SOXL" && x.d >= from && x.d < to); if (!tr.length) continue; const w = tr.filter((x) => x.ret > 0); const gw = w.reduce((a, x) => a + x.ret, 0), gl = -tr.filter((x) => x.ret <= 0).reduce((a, x) => a + x.ret, 0); console.log(`    SOXL alone ${label.padEnd(7)} n ${String(tr.length).padStart(4)}  WR ${(w.length / tr.length * 100).toFixed(0)}%  mean ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2)}%/t  PF ${(gw / gl).toFixed(2)}  median hold ${tr.map((x) => x.sessions).sort((a, b) => a - b)[Math.floor(tr.length / 2)]} sessions`); }
  console.log("\nLEVERAGED FAMILY — adding TQQQ/TNA/SPXL/UPRO at 1.0x, then at SOXL's weight (the forward-watch from #3421)");
  console.log(line("armed 9", base));
  console.log(line("+ TQQQ TNA SPXL UPRO at 1.0x", run({ ...ARMED }, ALL)));
  console.log(line("+ family at 1.5x", run({ ...ARMED, weights: { ...W, TQQQ: 1.5, TNA: 1.5, SPXL: 1.5, UPRO: 1.5 } }, ALL)));
  console.log(line("+ TQQQ only at 1.5x", run({ ...ARMED, weights: { ...W, TQQQ: 1.5 } }, [...SYMS, "TQQQ"])));
  console.log("\nCOMPOSITION — which members carry it (all at 1.0x)");
  for (const add of [["TNA"], ["SPXL"], ["TQQQ"], ["UPRO"], ["TNA", "SPXL"], ["TNA", "SPXL", "TQQQ"], ["TNA", "UPRO", "TQQQ"], ["TNA", "SPXL", "UPRO"]]) console.log(line("+ " + add.join(" "), run(ARMED, [...SYMS, ...add])));
  console.log("\nSLOT CAP with the family (13 names compete for the slots)");
  for (const cap of [5, 6, 7]) console.log(line(`family 1.0x, cap ${cap}`, run({ ...ARMED, maxConc: cap }, ALL)));
  console.log("\nGROSS CAP — the engine skips entries past TRADER_MAX_GROSS_PCT (default 80); every lab allowed 100");
  for (const [label, syms] of [["armed 9", SYMS], ["family 13", ALL]]) for (const cap of [0.8, 0.9, 1.0]) console.log(line(`${label}, gross cap ${Math.round(cap * 100)}%`, run({ ...ARMED, grossCap: cap }, syms)));
  for (const s of LEV) { const tr = run(ARMED, [...SYMS, s]).h.trades.filter((x) => x.sym === s); const w = tr.filter((x) => x.ret > 0); const gw = w.reduce((a, x) => a + x.ret, 0), gl = -tr.filter((x) => x.ret <= 0).reduce((a, x) => a + x.ret, 0); console.log(`    ${s} alone (hourly 2y) n ${String(tr.length).padStart(4)}  WR ${(w.length / tr.length * 100).toFixed(0)}%  mean ${(tr.reduce((a, x) => a + x.ret, 0) / tr.length * 100).toFixed(2)}%/t  PF ${(gw / gl).toFixed(2)}`); }
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
