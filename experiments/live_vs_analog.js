/**
 * live_vs_analog.js — the periodic check: what the live trader did vs what the
 * ARMED stack does on the same bars (round 8, 2026-08-23).
 *
 * Reads the autopilot ledger(s) for a window, reports the live week (entries,
 * exits by reason, P&L, WR, avg win/loss, payoff) and audits the fingerprints
 * of the armed configuration (entries inside the hourly decision windows, no
 * ladder/TP/momentum/de-carry exits, no config_warning rows, same-minute
 * entries ordered by tilt weight). Then replays the armed stack on the window's
 * own 5-minute bars (entries confirmed on hourly :00 closes, exit on the
 * stream, tilt, stress, floor, trail, 3% stop) and prints both side by side.
 *
 * Usage: node experiments/live_vs_analog.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--ledger <path> ...]   (default: both boxes' ledgers if present)
 *        [--json]                (machine-readable summary on the last line)
 * Exit code 0 always; the fingerprint audit prints ALERT lines when something
 * the labs did not validate is running.
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
      if (o.slotOrder === "expectancy") cands.sort((a, z) => ((o.weights || {})[z.sym] || 1) - ((o.weights || {})[a.sym] || 1) || a.v - z.v);
      else cands.sort((a, z) => a.v - z.v);
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


const fsx = require("fs");
const LEDGERS_DEFAULT = ["C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl", "C:/dev/lantern-race/data/lantern-garage/trading/autopilot-trades.jsonl"];
const WEIGHTS = { SOXL: 1.5, SMH: 1.5, QQQ: 1.5, IWM: 1.02, XLK: 1.0, SPY: 0.83, DIA: 0.71, GLD: 0.5, TLT: 0.5 };
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const ledgers = argv.includes("--ledger") ? argv.flatMap((a, i) => (a === "--ledger" ? [argv[i + 1]] : [])) : LEDGERS_DEFAULT.filter((p) => fsx.existsSync(p));
const etMinOf = (iso) => ET_HM(new Date(iso).getTime());
const etDayOf = (iso) => ET_DAY(new Date(iso).getTime());
const mondayOf = (d) => { const x = new Date(d + "T12:00:00Z"); const dow = x.getUTCDay(); x.setUTCDate(x.getUTCDate() - ((dow + 6) % 7)); return x.toISOString().slice(0, 10); };
const today = ET_DAY(Date.now());
const FROM = arg("--from", mondayOf(today)), TO = arg("--to", "2099-01-01");
const CADENCE = Number(process.env.TRADER_ENTRY_CADENCE_MIN || 60), PHASE = Number(process.env.TRADER_ENTRY_CADENCE_PHASE || 0), WINDOW = Number(process.env.TRADER_ENTRY_CADENCE_WINDOW || 3);
const inWindow = (m) => ((((m - PHASE) % CADENCE) + CADENCE) % CADENCE) < WINDOW;
const NOT_VALIDATED = /zone_r1|zone_r2|r2_trail|peak_giveback|take_profit|momentum_died|eod_decarry/;

function liveReport(path) {
  const all = fsx.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.ts);
  const rows = all.filter((r) => etDayOf(r.ts) >= FROM && etDayOf(r.ts) < TO);
  // ENGINE-ORIGINATED only: a shared broker account (race = Alpaca PA3KZEWVVZTP with the core book / Sigma) makes the
  // engine "reconstruct" exits for positions it never opened (SPMO, XMMO, options, fractional lots). Count an exit
  // only when this ledger holds an engine entry row for the symbol in the 15 days before it.
  const entryTs = {};
  for (const r of all) if (r.event === "entry") (entryTs[String(r.symbol).toUpperCase()] = entryTs[String(r.symbol).toUpperCase()] || []).push(new Date(r.ts).getTime());
  const engineOwned = (r) => (entryTs[String(r.symbol).toUpperCase()] || []).some((t) => t <= new Date(r.ts).getTime() && t >= new Date(r.ts).getTime() - 15 * 86400e3);
  const entries = rows.filter((r) => r.event === "entry");
  const exitsAll = rows.filter((r) => r.event === "exit" && Number.isFinite(Number(r.pnl_pct)));
  const foreign = exitsAll.filter((r) => !engineOwned(r)), exits = exitsAll.filter(engineOwned);
  const warns = rows.filter((r) => r.event === "config_warning"), skips = rows.filter((r) => r.event === "skip");
  const w = exits.filter((r) => r.pnl_pct > 0), l = exits.filter((r) => r.pnl_pct <= 0);
  const mean = (a, k) => (a.length ? a.reduce((s, x) => s + Number(x[k]), 0) / a.length : 0);
  const aw = mean(w, "pnl_pct"), al = -mean(l, "pnl_pct");
  const byReason = {};
  for (const r of exits) { const k = String(r.reason || "").split(" ")[0].slice(0, 22); byReason[k] = (byReason[k] || 0) + 1; }
  const alerts = [];
  const outside = entries.filter((r) => !inWindow(etMinOf(r.ts)));
  if (outside.length) alerts.push(`${outside.length}/${entries.length} entries OUTSIDE the ${CADENCE}m/:${String(PHASE).padStart(2, "0")} decision windows: ${outside.map((r) => `${r.symbol}@${String(Math.floor(etMinOf(r.ts) / 60)).padStart(2, "0")}:${String(etMinOf(r.ts) % 60).padStart(2, "0")}`).join(" ")}`);
  const bad = exits.filter((r) => NOT_VALIDATED.test(String(r.reason || "")));
  if (bad.length) alerts.push(`${bad.length} exits by NON-validated paths: ${bad.map((r) => `${r.symbol}:${String(r.reason).split(" ")[0]}`).join(" ")}`);
  if (warns.length) alerts.push(`${warns.length} config_warning row(s): ${String(warns[0].reason).slice(0, 140)}`);
  const ladderSkips = skips.filter((r) => /ladder owns/.test(String(r.reason || r.why || ""))).length;
  if (ladderSkips) alerts.push(`${ladderSkips} 'ladder owns this exit' skips — the bounce exit is being pre-empted`);
  // slot order: same-minute entries should be in non-increasing tilt weight
  const byMinute = {};
  for (const r of entries) { const k = r.ts.slice(0, 16); (byMinute[k] = byMinute[k] || []).push(r); }
  for (const [k, g] of Object.entries(byMinute)) {
    if (g.length < 2) continue;
    const ws = g.map((r) => WEIGHTS[String(r.symbol).toUpperCase()] || 1);
    if (ws.some((x, i) => i > 0 && x > ws[i - 1] + 1e-9)) alerts.push(`same-minute entries at ${k} not in tilt order: ${g.map((r) => r.symbol).join(">")}`);
  }
  // COSTS the labs assume (5 bp each way): entry = decision quote -> broker average cost (the exit row's `entry`),
  // exit = intent mark -> fill (exit rows with source 'fill' within 15 min of the intent). Positive entry bp = paid above quote.
  const ms = (r) => new Date(r.ts).getTime();
  const entrySlip = [], exitSlip = [];
  for (const e of entries) {
    const x = exits.filter((r) => r.symbol === e.symbol && ms(r) > ms(e) && r.qty === e.qty && Number(r.entry) > 0).sort((a, b) => ms(a) - ms(b))[0];
    if (x && Number(e.entry) > 0) entrySlip.push((Number(x.entry) / Number(e.entry) - 1) * 1e4);
  }
  for (const i of rows.filter((r) => r.event === "exit_intent" && Number(r.mark) > 0)) {
    const x = exits.filter((r) => r.symbol === i.symbol && r.source === "fill" && Number(r.exit) > 0 && ms(r) >= ms(i) && ms(r) - ms(i) <= 15 * 60e3).sort((a, b) => ms(a) - ms(b))[0];
    if (x) exitSlip.push((Number(x.exit) / Number(i.mark) - 1) * 1e4);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const costs = { entryBp: avg(entrySlip), entryN: entrySlip.length, exitBp: avg(exitSlip), exitN: exitSlip.length };
  const stress = entries.filter((r) => r.stress_mult > 1).length, symMult = entries.filter((r) => r.sym_mult != null).length;
  if (foreign.length) alerts.push(`${foreign.length} reconstructed exit(s) for positions this engine never opened (ignored): ${[...new Set(foreign.map((r) => r.symbol))].join(" ")}`);
  return { path, costs, rows: rows.length, entries: entries.length, exits: exits.length, pnl: exits.reduce((s, r) => s + Number(r.pnl || 0), 0), wr: exits.length ? w.length / exits.length : 0, aw, al, b: al > 0 ? aw / al : 0, byReason, alerts, stress, symMult,
    entryList: entries.map((r) => `${etDayOf(r.ts)} ${String(Math.floor(etMinOf(r.ts) / 60)).padStart(2, "0")}:${String(etMinOf(r.ts) % 60).padStart(2, "0")} ${r.symbol}${r.sym_mult ? " x" + r.sym_mult : ""}${r.stress_mult > 1 ? " stress" : ""}`) };
}

(async () => {
  console.log(`LIVE vs ANALOG — window ${FROM} .. ${TO === "2099-01-01" ? "now" : TO}  (cadence ${CADENCE}m/:${String(PHASE).padStart(2, "0")}, window ${WINDOW} min)`);
  const live = ledgers.map(liveReport);
  for (const r of live) {
    console.log(`\nLIVE ${r.path.includes("race") ? "race " : "stable"}: ${r.entries} entries, ${r.exits} exits, P&L $${r.pnl.toFixed(0)}, WR ${(r.wr * 100).toFixed(0)}%, avg win ${r.aw.toFixed(2)}%, avg loss ${r.al.toFixed(2)}%, payoff ${r.b.toFixed(2)}; exits by reason ${JSON.stringify(r.byReason)}; entries journaling sym_mult ${r.symMult}/${r.entries}, stress ${r.stress}`);
    if (r.entryList.length) console.log("  entries: " + r.entryList.join(" | "));
    if (r.costs.entryN || r.costs.exitN) console.log(`  costs: entry ${r.costs.entryBp == null ? "n/a" : r.costs.entryBp.toFixed(1) + " bp above quote"} (n${r.costs.entryN}), exit ${r.costs.exitBp == null ? "n/a" : r.costs.exitBp.toFixed(1) + " bp vs mark"} (n${r.costs.exitN}) — labs charge 5 bp each way`);
    for (const a of r.alerts) console.log("  ALERT: " + a);
    if (!r.alerts.length) console.log("  fingerprints: clean (all entries inside decision windows, only validated exit paths, no config warnings)");
  }
  // ---- the analog: armed stack on the window's own 5m bars ----
  const nowSec = Math.floor(Date.now() / 1000);
  const five = {};
  for (const s of SYMS) five[s] = annotate(await chart(s, "5m", nowSec - 58 * 86400), true, 5 * 60 * 1000);
  const vix = priorCloseMap(annotate(await chart("^VIX", "1d", nowSec - 120 * 86400), false));
  for (const s of SYMS) for (const b of five[s]) b.dec = (((b.closeMin - PHASE) % CADENCE) + CADENCE) % CADENCE === 0 || b.isLast;
  const LIVE = { ...MONDAY, weights: WEIGHTS, skipHours: null, skipWindow: [810, 870], entryMode: "close", exitMode: "close", entryDecisionFlag: "dec", slotOrder: "expectancy" };
  const first5 = five.SPY[0] ? five.SPY[0].d : FROM;
  const from = FROM < first5 ? first5 : FROM;
  const r = simulate(five, SYMS, LIVE, true, vix, from, TO);
  const st = stats(r.trades, from, TO), sc = score(r.curve, from, TO);
  const byReason = {}; for (const t of r.trades.filter((t) => t.d >= from && t.d < TO)) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  console.log(`\nANALOG (armed stack on 5m bars, ${from}..): ${st.n} trades, return ${sc ? (sc.tot * 100).toFixed(2) : "n/a"}%, DD ${sc ? (sc.dd * 100).toFixed(2) : "n/a"}%, WR ${(st.wr * 100).toFixed(0)}%, avg win ${(st.aw * 100).toFixed(2)}%, avg loss ${(st.al * 100).toFixed(2)}%, payoff ${st.b.toFixed(2)}; exits ${JSON.stringify(byReason)}`);
  if (FROM < first5) console.log(`  (5m history starts ${first5}; the analog covers from there)`);
  const summary = { from, to: TO, live: live.map((x) => ({ box: x.path.includes("race") ? "race" : "stable", entries: x.entries, exits: x.exits, pnl: +x.pnl.toFixed(0), wr: +x.wr.toFixed(3), aw: +x.aw.toFixed(3), al: +x.al.toFixed(3), b: +x.b.toFixed(2), alerts: x.alerts })), analog: { n: st.n, tot: sc ? +sc.tot.toFixed(4) : null, dd: sc ? +sc.dd.toFixed(4) : null, wr: +st.wr.toFixed(3), aw: +st.aw.toFixed(4), al: +st.al.toFixed(4), b: +st.b.toFixed(2) } };
  if (argv.includes("--json")) console.log(JSON.stringify(summary));
})().catch((e) => { console.error("live_vs_analog failed:", e.message); process.exit(1); });
