/**
 * stop_trail_lab.js — two operator claims about the exit stack (2026-08-22)
 *
 *   CLAIM 1 — "make the stop tighter: once a position is at -2% it either reaches
 *     -3% or goes flat; it was obviously bad at -1%; exiting at -3% loses money
 *     for no reason."  → testable as (a) the stop sweep 1.0..3.0% at the LIVE
 *     12% size (the position cap binds, so a tighter stop does NOT buy a bigger
 *     position unless the cap is raised — the constant-size framing IS the live
 *     framing; one risk-matched row is shown for contrast), and (b) the direct
 *     conditional: among trades whose adverse excursion touched -1% / -2%, what
 *     fraction still ended profitable, and what did HOLDING from that point on
 *     earn versus exiting right there.
 *
 *   CLAIM 2 — "a +2% position should never break even or go negative — do the
 *     R-based trails not prevent that?"  → the LIVE trail (auto-trader DEFAULTS,
 *     not overridden on either box) arms at +1.5% and fires 2.5% below the PEAK,
 *     tightening to 2.25/1.75/1.25% at +6/+12/+25%. A position that peaks at
 *     +2.0% therefore trail-exits at -0.5%; at +2.5% it exits flat. So today the
 *     claim is NOT guaranteed. Variants: tighter trails, earlier arms, the
 *     breakeven ratchet (#3414) on top of the real trail, and profit LOCKS
 *     (once up +2%, floor at entry+0.5% / +1.0%).
 *
 * BASELINE IS LIVE-FAITHFUL THIS TIME: 3% stop + the real trail schedule. The
 * loss-reduction lab (#3413) scored the ratchet against a no-trail baseline,
 * which overstates its marginal value; this lab re-measures it honestly.
 *
 * Fills: stops and trails are GAP-AWARE (fill at the bar open when the bar
 * opens through the level) and pay SLIP (5bp default, LAB_SLIP_BP). Entries,
 * sizing (12% of equity, max 5), morning gate, bounce and timeout exits are
 * the #3412 portfolio analog. Four surfaces: hourly 2y halves + daily 26y
 * two-window (2000-2014 fit / 2015- holdout); ship rule as #3413 — a variant
 * must improve the LOSS metrics with >=90% of the baseline total kept on every
 * surface.
 *
 * Usage: node experiments/stop_trail_lab.js [--days 720]
 */
"use strict";

const https = require("https");

const SYMS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL"];
const POS_FRAC = 0.12;
const MAX_CONC = 5;
const MORNING_THR = 0.08;
const BASE_THR = 0.30;
const SLIP = Number(process.env.LAB_SLIP_BP || 5) / 10000;
// ENTRY slippage (LAB_ENTRY_SLIP_BP, default 5): every prior lab filled entries
// at the exact bar close. Irrelevant for a 3%-stop / bounce-exit strategy; it
// is 10-20% of the target once the exit is a +0.5% floor — the cost that keeps
// a take-profit ladder from "improving" all the way to zero.
const ENTRY_SLIP = Number(process.env.LAB_ENTRY_SLIP_BP || 5) / 10000;
// live trail schedule (auto-trader trailTriggerPct)
const LIVE_TRAIL = { arm: 1.5, pct: 2.5 };
const trailTrig = (peakGainPct, base) => (peakGainPct >= 25 ? Math.min(base, 1.25)
  : peakGainPct >= 12 ? Math.min(base, 1.75) : peakGainPct >= 6 ? Math.min(base, 2.25) : base);

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
function annotateHourly(bars) {
  let day = null, si = -1, runH = 0, runL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = ET_DAY(b.t);
    if (d !== day) { day = d; si++; runH = -Infinity; runL = Infinity; }
    runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
    b.si = si; b.runH = runH; b.runL = runL; b.d = d;
    b.closeMin = ET_HM(b.t + 3600 * 1000);
    b.isLast = i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== d;
  }
  return bars;
}
const rIbs = (b) => (b.runH - b.runL > 0 ? (b.c - b.runL) / (b.runH - b.runL) : 0.5);
const dIbs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);

/**
 * opts: { stopPct (0.03), trail: {arm, pct}|null, be: frac|null, lock: frac (0),
 *         sizeFrac (0.12) }
 * Exit order within a bar (pessimistic): stop → trail → bounce → timeout; then
 * the ratchet raise is applied at bar close.
 */
function simulate(barsBySym, syms, opts, intraday) {
  const o = { stopPct: 0.03, trail: LIVE_TRAIL, be: null, lock: 0, sizeFrac: POS_FRAC, timeoutS: 5, ...opts };
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
      // Within-bar ORDERING (the bug the first run exposed): an OHLC bar does not
      // say whether the high or the low came first. Assuming high-then-low on
      // every bar turned the trail into "sell at the low of any wide day" and
      // produced a -81% "live baseline" no ledger has ever shown. Standard
      // heuristic: up bar (C >= O) runs O -> L -> H -> C; down bar O -> H -> L -> C.
      pos.mae = Math.min(pos.mae, b.l / pos.entry - 1);
      // What a stop AT -1% / -2% would actually have filled at on the bar that
      // first touched it: the level, or the open if the bar gapped through it.
      for (const thr of [-0.01, -0.02]) {
        const lvl = pos.entry * (1 + thr);
        if (pos.touch[thr] === undefined && b.l <= lvl) pos.touch[thr] = Math.min(lvl, b.o) / pos.entry - 1 - SLIP;
      }
      const legs = b.c >= b.o ? ["L", "H", "C"] : ["H", "L", "C"];
      let exitPx = null, reason = null;
      for (const leg of legs) {
        if (leg === "H") {
          pos.peak = Math.max(pos.peak, b.h);
          if (o.be != null && b.h >= pos.entry * (1 + o.be)) {
            const want = pos.entry * (1 + o.lock);
            if (pos.stopPx < want) pos.stopPx = want;      // continuous-resize engine: raises at the touch
          }
          continue;
        }
        const px = leg === "L" ? b.l : b.c;
        const fill = (level) => (leg === "L" ? gapFill(level, b) : level * (1 - SLIP));
        if (px <= pos.stopPx) { reason = pos.stopPx >= pos.entry ? "be_stop" : "stop"; exitPx = fill(pos.stopPx); break; }
        if (o.trail) {
          const peakGain = (pos.peak / pos.entry - 1) * 100;
          if (peakGain >= o.trail.arm) {
            const lvl = pos.peak * (1 - trailTrig(peakGain, o.trail.pct) / 100);
            if (px <= lvl) { reason = "trail"; exitPx = fill(lvl); break; }
          }
        }
      }
      const ibsV = intraday ? rIbs(b) : dIbs(b);
      if (exitPx == null) {
        if (ibsV >= 0.6) { exitPx = b.c; reason = "bounce"; }
        else if (b.si >= pos.entrySi + o.timeoutS && (intraday ? b.isLast : true)) { exitPx = b.c; reason = "timeout"; }
      }
      if (exitPx != null) {
        cash += pos.qtyVal * (exitPx / pos.entry);
        trades.push({ sym, d, ret: exitPx / pos.entry - 1, reason, mae: pos.mae, touch: pos.touch });
        if (reason === "be_stop") beBlock.set(sym, b.si + 1);
        open.delete(sym);
      }
    }
    let equity = cash;
    for (const [sym, pos] of open) {
      const b = idx[sym].get(t);
      equity += pos.qtyVal * ((b ? b.c : pos.entry) / pos.entry);
    }
    if (open.size < MAX_CONC) {
      const cands = [];
      for (const sym of syms) {
        if (open.has(sym)) continue;
        const b = idx[sym].get(t);
        if (!b || b.si === 0) continue;
        if (beBlock.has(sym) && b.si < beBlock.get(sym)) continue;
        const v = intraday ? rIbs(b) : dIbs(b);
        const thr = intraday && b.closeMin < 660 ? MORNING_THR : BASE_THR;
        if (v <= thr) cands.push({ sym, b, v });
      }
      cands.sort((a, z) => a.v - z.v);
      for (const cnd of cands) {
        if (open.size >= MAX_CONC) break;
        const size = equity * o.sizeFrac;
        if (size > cash) continue;
        cash -= size;
        const entryPx = cnd.b.c * (1 + ENTRY_SLIP);
        open.set(cnd.sym, { entry: entryPx, qtyVal: size, stopPx: entryPx * (1 - o.stopPct),
          entrySi: cnd.b.si, entryT: cnd.b.t, peak: entryPx, mae: 0, touch: {} });
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
  let peak = -Infinity, dd = 0;
  const byMonth = new Map();
  for (const p of seg) {
    peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1);
    const m = p.d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, {});
    byMonth.get(m).last = p.equity;
  }
  const ms = [...byMonth.keys()];
  let worst = 0, neg = 0;
  for (let i = 0; i < ms.length; i++) {
    const start = i === 0 ? seg[0].equity : byMonth.get(ms[i - 1]).last;
    const r = byMonth.get(ms[i]).last / start - 1;
    if (r < worst) worst = r;
    if (r < 0) neg++;
  }
  return { tot, dd, worst, neg, months: ms.length };
}
const fmt = (s) => s ? `tot ${(s.tot * 100).toFixed(1).padStart(6)}%  DD ${(s.dd * 100).toFixed(1).padStart(6)}%  worstMo ${(s.worst * 100).toFixed(1).padStart(5)}%  negMo ${String(s.neg).padStart(2)}/${s.months}` : "n/a";
function verdict(base, v) {
  if (!base || !v) return "n/a";
  const lossBetter = (v.worst >= base.worst) + (v.dd >= base.dd) + (v.neg <= base.neg);
  const keeps = base.tot >= 0 ? v.tot >= base.tot * 0.9 : v.tot >= base.tot;
  return `${lossBetter}/3 loss metrics better, total ${keeps ? "kept" : "SACRIFICED"}${lossBetter >= 2 && keeps ? "  << PASS" : ""}`;
}

/** CLAIM 1 direct test: what does holding past an adverse excursion earn? */
function conditional(trades, thr, label) {
  const g = trades.filter((x) => x.touch[thr] !== undefined);
  if (!g.length) return;
  const profitable = g.filter((x) => x.ret > 0).length / g.length;
  const meanHold = g.reduce((a, x) => a + x.ret, 0) / g.length;
  const exitHere = g.reduce((a, x) => a + x.touch[thr], 0) / g.length;   // gap-aware, slipped
  console.log(`  ${label}: touched ${(thr * 100).toFixed(0)}%  n=${String(g.length).padStart(5)}  still ended profitable ${(profitable * 100).toFixed(0)}%  mean if HELD ${(meanHold * 100).toFixed(2)}%  vs a stop there (real fills) ${(exitHere * 100).toFixed(2)}%  → holding ${meanHold > exitHere ? "EARNS" : "COSTS"} ${(Math.abs(meanHold - exitHere) * 100).toFixed(2)}%/trade`);
}

(async () => {
  const args = process.argv.slice(2);
  const DAYS = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 720;
  const nowSec = Math.floor(Date.now() / 1000);
  const hourly = {}, daily = {};
  for (const s of SYMS) hourly[s] = annotateHourly(await chart(s, "1h", nowSec - DAYS * 86400));
  for (const s of SYMS) {
    const bars = await chart(s, "1d", Math.floor(Date.UTC(1999, 0, 1) / 1000));
    let si = 0;
    for (const b of bars) { b.d = new Date(b.t).toISOString().slice(0, 10); b.si = si++; b.isLast = true; }
    daily[s] = bars;
  }
  const H_MID = hourly.SPY[Math.floor(hourly.SPY.length / 2)].d, H_START = hourly.SPY[0].d, H_END = "2099-01-01";
  const FIT = ["2000-01-01", "2015-01-01"], HOLD = ["2015-01-01", "2099-01-01"];

  const run = (opts) => {
    const h = simulate(hourly, SYMS, opts, true), dd = simulate(daily, SYMS, opts, false);
    return { h, dd, s: [score(h.curve, H_START, H_MID), score(h.curve, H_MID, H_END), score(dd.curve, ...FIT), score(dd.curve, ...HOLD)] };
  };
  const LABELS = ["hourly 1st half", "hourly 2nd half", "daily  fit     ", "daily  holdout "];
  const base = run({});
  console.log("BASELINE — LIVE-FAITHFUL: 3% stop + real trail (arm 1.5%, 2.5% from peak, tightening)");
  for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: ${fmt(base.s[i])}`);
  const reasons = (tr) => Object.entries(tr.reduce((a, x) => ((a[x.reason] = (a[x.reason] || 0) + 1), a), {})).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  daily exits by reason: ${reasons(base.dd.trades)}\n`);

  console.log("CLAIM 1 — what does HOLDING past an adverse excursion earn? (baseline trades)");
  for (const thr of [-0.01, -0.02]) {
    conditional(base.h.trades, thr, "hourly 2y ");
    conditional(base.dd.trades, thr, "daily 26y ");
  }
  console.log("");

  const meanStop = (tr) => { const g = tr.filter((x) => x.reason === "stop"); return g.length ? g.reduce((a, x) => a + x.ret, 0) / g.length : 0; };
  const show = (key, opts) => {
    const r = run(opts);
    console.log(key);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: ${fmt(r.s[i])}   ${verdict(base.s[i], r.s[i])}`);
    if (opts.stopPct) console.log(`  real stop fills averaged: hourly ${(meanStop(r.h.trades) * 100).toFixed(2)}%  daily ${(meanStop(r.dd.trades) * 100).toFixed(2)}%  (level ${(-opts.stopPct * 100).toFixed(1)}%)`);
    console.log("");
    return r;
  };
  console.log("CLAIM 1 — STOP SWEEP at the live 12% size (trail on)");
  for (const sp of [0.010, 0.015, 0.020, 0.025]) show(`stop ${(sp * 100).toFixed(1)}%`, { stopPct: sp });
  show("stop 1.5% RISK-MATCHED (24% positions — needs the cap raised)", { stopPct: 0.015, sizeFrac: 0.24 });

  console.log("CLAIM 2 — TRAIL / LOCK variants (3% stop)");
  show("trail 2.0% from peak (arm 1.5%)", { trail: { arm: 1.5, pct: 2.0 } });
  show("trail 1.5% from peak (arm 1.5%)", { trail: { arm: 1.5, pct: 1.5 } });
  show("trail 1.0% from peak (arm 1.5%)", { trail: { arm: 1.5, pct: 1.0 } });
  show("trail 2.5% but arm at 1.0%", { trail: { arm: 1.0, pct: 2.5 } });
  show("ratchet +2% -> entry (#3414) ON TOP of the live trail", { be: 0.02, lock: 0 });
  show("ratchet +2% -> entry+0.5% (profit lock)", { be: 0.02, lock: 0.005 });
  show("ratchet +2% -> entry+1.0% (profit lock)", { be: 0.02, lock: 0.010 });
  show("ratchet +1.5% -> entry", { be: 0.015, lock: 0 });
  console.log("CLAIM 2 — bracketing the trigger/lock plane (live trail 2.5%)");
  show("SHIP CANDIDATE: ratchet +1.5% -> entry+1.0%", { be: 0.015, lock: 0.01 });
  show("ratchet +1.5% -> entry+1.25% (band 0.25%)", { be: 0.015, lock: 0.0125 });
  show("ratchet +1.0% -> entry+0.5%", { be: 0.01, lock: 0.005 });
  show("ratchet +1.0% -> entry+1.0% (= take-profit at +1%)", { be: 0.01, lock: 0.01 });
  show("ratchet +2.0% -> entry+1.5%", { be: 0.02, lock: 0.015 });
  show("ratchet +0.75% -> entry+0.75% (TP floor +0.75%)", { be: 0.0075, lock: 0.0075 });
  show("ratchet +0.5% -> entry+0.5% (TP floor +0.5%)", { be: 0.005, lock: 0.005 });
  show("ratchet +0.25% -> entry+0.25% (TP floor +0.25%)", { be: 0.0025, lock: 0.0025 });
  show("ratchet +1.5% -> entry+1.5% (TP floor +1.5%)", { be: 0.015, lock: 0.015 });
  show("ratchet +2.0% -> entry+2.0% (TP floor +2.0%)", { be: 0.02, lock: 0.02 });
  show("NO trail at all (what #3413 scored against)", { trail: null });
  // ── FACTORIAL over the profit-lock family, chosen on FIT surfaces only ──────
  // trail tightness, ratchet trigger and lock level are one knob family ("how
  // fast do we lock gains"); stacking individually-passing variants is fishing.
  // Choose ONE configuration on the fit surfaces (hourly 1st half + daily fit),
  // then score it once on the holdout surfaces.
  console.log("FACTORIAL — trail x ratchet x lock, chosen on FIT surfaces only");
  const passes = (bi, si) => { const v = verdict(base.s[bi], si); return /PASS/.test(v); };
  const grid = [];
  // CREDIBILITY LIMIT: a trail tighter than the intrabar wiggle the bars hide
  // cannot be modelled on OHLC data — the sim under-counts its triggers and
  // flatters it (the first factorial pass put trail 0.5% on top for exactly
  // that reason). Daily bars cannot resolve trails below ~2%; hourly bars
  // ~1%. The default grid keeps only trails both granularities can honour.
  const TRAILS = String(process.env.LAB_TRAILS || "1.5,2.5").split(",").map(Number);
  for (const tp of TRAILS) for (const be of [null, 0.015, 0.02]) for (const lock of (be == null ? [0] : [0, 0.005, 0.01])) {
    const opts = { trail: { arm: 1.5, pct: tp }, be, lock };
    const r = run(opts);
    const fitOk = passes(0, r.s[0]) && passes(2, r.s[2]);
    grid.push({ key: `trail ${tp}% / be ${be == null ? "off" : (be * 100).toFixed(1) + "%"} / lock ${(lock * 100).toFixed(1)}%`, r, fitOk });
  }
  const ok = grid.filter((g) => g.fitOk).sort((a, z) => z.r.s[2].tot - a.r.s[2].tot);
  console.log(`  ${ok.length} of ${grid.length} configs pass BOTH fit surfaces; all, by daily-fit total:`);
  for (const g of ok) console.log(`    ${g.key.padEnd(36)} fit ${(g.r.s[2].tot * 100).toFixed(1).padStart(6)}%  hourly1 ${(g.r.s[0].tot * 100).toFixed(1).padStart(5)}%`);
  if (ok.length) {
    const w = ok[0];
    console.log(`\n  FIT WINNER: ${w.key}`);
    for (let i = 0; i < 4; i++) console.log(`  ${LABELS[i]}: ${fmt(w.r.s[i])}   ${verdict(base.s[i], w.r.s[i])}`);
    const hOk = passes(1, w.r.s[1]) && passes(3, w.r.s[3]);
    console.log(`  → HOLDOUT ${hOk ? "CONFIRMS" : "REJECTS"} the fit winner`);
  }
  // ── GRANULARITY CHECK: does the ratchet-lock benefit survive finer bars? ──
  // The (trigger, lock) band is where OHLC coarseness flatters: a wiggle inside
  // the bar that would have hit the lock goes unseen. Yahoo serves 15m bars for
  // ~60 days; run the candidates on 15m AND on hourly over the SAME span and
  // compare each one's benefit over its own baseline. Thin data — this is a
  // model-bias check, not an edge test.
  console.log("GRANULARITY CHECK — last ~59 days, 15m bars vs hourly bars, same span");
  const fine = {};
  for (const s of SYMS) {
    const bars = await chart(s, "15m", nowSec - 59 * 86400);
    let day = null, si = -1, runH = 0, runL = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], dd = ET_DAY(b.t);
      if (dd !== day) { day = dd; si++; runH = -Infinity; runL = Infinity; }
      runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
      b.si = si; b.runH = runH; b.runL = runL; b.d = dd;
      b.closeMin = ET_HM(b.t + 15 * 60 * 1000);
      b.isLast = i + 1 >= bars.length || ET_DAY(bars[i + 1].t) !== dd;
    }
    fine[s] = bars;
  }
  const fineStart = fine.SPY[0].d;
  const coarse = {};
  for (const s of SYMS) {
    const sub = hourly[s].filter((b) => b.d >= fineStart);
    const s0 = sub.length ? sub[0].si : 0;
    coarse[s] = sub.map((b) => ({ ...b, si: b.si - s0 }));
  }
  const CANDS = [
    ["baseline (live)", {}],
    ["be 1.5% / lock 1.0%", { be: 0.015, lock: 0.01 }],
    ["be 2.0% / lock 1.0%", { be: 0.02, lock: 0.01 }],
    ["be 2.0% / lock 0.5%", { be: 0.02, lock: 0.005 }],
    ["be 2.0% / lock 0   (#3414)", { be: 0.02, lock: 0 }],
    ["TP floor +1.0% (be1/lock1)", { be: 0.01, lock: 0.01 }],
    ["TP floor +0.5% (be.5/lock.5)", { be: 0.005, lock: 0.005 }],
    ["TP floor +1.5%", { be: 0.015, lock: 0.015 }],
    ["trail 1.5% (no ratchet)", { trail: { arm: 1.5, pct: 1.5 } }],
  ];
  console.log(`  span ${fineStart} -> ${fine.SPY[fine.SPY.length - 1].d}`);
  console.log("  config                        15m: tot / DD / be_stops        1h: tot / DD / be_stops");
  let b15 = null, b1h = null;
  for (const [key, opts] of CANDS) {
    const f = simulate(fine, SYMS, opts, true), c = simulate(coarse, SYMS, opts, true);
    const sf = score(f.curve, "0000", "9999"), sc = score(c.curve, "0000", "9999");
    const nb = (tr) => tr.filter((x) => x.reason === "be_stop").length;
    if (!b15) { b15 = sf; b1h = sc; }
    const d15 = ((sf.tot - b15.tot) * 100).toFixed(1), d1h = ((sc.tot - b1h.tot) * 100).toFixed(1);
    console.log(`  ${key.padEnd(28)} ${(sf.tot * 100).toFixed(1).padStart(6)}% ${(sf.dd * 100).toFixed(1).padStart(6)}% ${String(nb(f.trades)).padStart(4)}  (d${d15.padStart(5)})   ${(sc.tot * 100).toFixed(1).padStart(6)}% ${(sc.dd * 100).toFixed(1).padStart(6)}% ${String(nb(c.trades)).padStart(4)}  (d${d1h.padStart(5)})`);
  }
  console.log("  Read the d columns: a benefit that holds at 15m is real; one that only exists at 1h is bar coarseness.");
  console.log("\nSHIP RULE: >=2/3 loss metrics better with total kept, on every surface; the");
  console.log("factorial winner is chosen on fit surfaces and must then pass both holdout surfaces.");
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
