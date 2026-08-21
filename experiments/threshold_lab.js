/**
 * threshold_lab.js — the entry-threshold question, done properly (#3410 follow-up)
 *
 * The rotation lab's byproduct table showed the LOOSER IBS 0.25 variant beating
 * the live-analog 0.15 in the HOLDOUT window on both symbols. Acting on that
 * observation directly would be fitting on holdout — noticing it there was
 * itself a peek. This lab asks the question the legitimate way, and also tests
 * the operator's 2026-08-22 proposal head-on: "instead of backtesting on 20+
 * years, backtest on 5 years to get smaller candles / make it more accurate."
 *
 * That proposal contains two separate ideas, and they get separate parts:
 *   - SHORTER WINDOW (5y): a claim about edge ESTIMATION — that recent data is
 *     more representative than 26 years. Testable: walk history re-choosing the
 *     threshold each year from only the trailing 5 years, and see whether that
 *     path beats a threshold chosen once on the long fit window. (Part 2)
 *   - SMALLER CANDLES: a claim about mechanics SIMULATION — daily bars cannot
 *     sequence intraday events (a stop touched at 11:00 vs a wash that bounces
 *     into the close), while the live engine trades intraday. True in principle;
 *     measurable on the span where fine bars exist. Free hourly data reaches
 *     back ~2 years (Yahoo caps 1h at 730d; minute bars at 60d) — so "5 years
 *     of small candles" is not obtainable; ~2 years of hourly is. (Part 3)
 *
 * PART 1 — the sweep on the standing bar. Thresholds 0.05..0.35 step 0.05,
 *   identical resolution machinery for all (enter at signal-day close; exit at
 *   the first close with dayIBS ≥ 0.6; −3% stop checked pessimistically before
 *   the bounce; 5-session timeout; non-overlapping — exactly rotation_lab.js).
 *   Fit 2000–2014 chooses; holdout 2015–2026 is scored once with the fit's
 *   winner. A threshold CHANGE ships only if the fit winner beats the live
 *   0.15 on total income in BOTH windows (operator standing rule).
 *
 * PART 2 — the 5-year window, tested as a POLICY rather than argued about.
 *   For each year Y: choose the best threshold using only trades RESOLVED
 *   before Jan 1 of Y with entries in the prior 5 calendar years, then trade
 *   year Y with that choice. No look-ahead anywhere. Report the chosen
 *   sequence (churn is the tell), and the cumulative income of the re-chosen
 *   path vs every static. The clean head-to-head of the two METHODS is the
 *   2015+ span, where the long-fit winner is also out of sample; 2005–2014
 *   overlaps the fit window and is labelled as such.
 *
 * PART 3 — smaller candles, where they exist. Hourly bars (~720d), day-anchored
 *   running IBS exactly as the live engine sees it: enter at the first bar
 *   (from the day's 2nd bar on) whose running dayIBS ≤ thr, at that bar's
 *   close. Exits sequenced bar-by-bar: stop first touch of −3% (priority,
 *   pessimistic), else first bar close with running dayIBS ≥ 0.6, else the
 *   close of the 5th session after entry. Fit = first half of the span,
 *   holdout = second half. A DAILY-analog run restricted to the SAME span and
 *   split isolates the pure granularity effect. This part is a MECHANICS
 *   check on thin modern data (2y), not an edge test — labelled as such.
 *
 * HONESTY NOTES: Yahoo chart closes are unadjusted (dividends missed equally
 * by every variant — within-lab comparisons hold, absolute levels understate
 * total return). Leveraged symbols run the same −3% floor as the index ETFs
 * for comparability (it is the live floor), though live distance is
 * vol-scaled above the floor.
 *
 * Usage:
 *   node experiments/threshold_lab.js [--sym SPY] [--from 2000]
 *   node experiments/threshold_lab.js --sym SOXL --intraday-only
 */
"use strict";

const https = require("https");

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

function parseChart(j, sym) {
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data for " + sym + (j.chart && j.chart.error ? ": " + JSON.stringify(j.chart.error) : ""));
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}

async function dailyBars(sym, fromYear) {
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const bars = parseChart(await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${p1}&period2=${p2}`), sym);
  for (const b of bars) b.d = new Date(b.t * 1000).toISOString().slice(0, 10);
  return bars;
}

const ET_DAY = (t) => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function hourlySessions(sym, days) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - days * 86400;
  const bars = parseChart(await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&period1=${p1}&period2=${p2}`), sym);
  const sessions = [];
  let cur = null;
  for (const b of bars) {
    const d = ET_DAY(b.t);
    if (!cur || cur.d !== d) { cur = { d, bars: [] }; sessions.push(cur); }
    cur.bars.push(b);
  }
  // drop degenerate sessions (holiday half-day glitches with a single bar)
  return sessions.filter((s) => s.bars.length >= 2);
}

const ibs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
const GRID = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35];
const LIVE = 0.15;
const FIT_END = "2015-01-01";
const pctf = (x) => (x * 100).toFixed(1).padStart(8) + "%";
const wrf = (x) => (x * 100).toFixed(0).padStart(4) + "%";

/** Daily resolution — identical to rotation_lab.js so results are comparable. */
function resolveTrades(bars, thr) {
  const out = [];
  let i = 0;
  while (i < bars.length - 1) {
    if (ibs(bars[i]) > thr) { i++; continue; }
    const entry = bars[i].c;
    const stop = entry * 0.97;
    let ret = null, j = i + 1;
    for (; j < Math.min(i + 6, bars.length); j++) {
      if (bars[j].l <= stop) { ret = -0.03; break; }
      if (ibs(bars[j]) >= 0.6) { ret = bars[j].c / entry - 1; break; }
    }
    if (ret == null) { j = Math.min(i + 5, bars.length - 1); ret = bars[j].c / entry - 1; }
    out.push({ d: bars[i].d, exitD: bars[j].d, entryPx: entry, ret });
    i = j;
  }
  return out;
}

const agg = (ts) => ({ n: ts.length, tot: ts.reduce((s, t) => s + t.ret, 0),
  wr: ts.length ? ts.filter((t) => t.ret > 0).length / ts.length : 0 });

// ── PART 1: the sweep, fit chooses, holdout scores ──────────────────────────
function part1(tradesByThr) {
  console.log("PART 1 — THRESHOLD SWEEP (fit 2000–2014 chooses; holdout 2015– scored once)");
  console.log("  thr     fit: n / total / WR          holdout: n / total / WR");
  let winner = null;
  for (const thr of GRID) {
    const ts = tradesByThr.get(thr);
    const f = agg(ts.filter((t) => t.d < FIT_END));
    const h = agg(ts.filter((t) => t.d >= FIT_END));
    const tag = thr === LIVE ? "  ← live" : "";
    console.log(`  ${thr.toFixed(2)}  ${String(f.n).padStart(5)} ${pctf(f.tot)} ${wrf(f.wr)}        ${String(h.n).padStart(5)} ${pctf(h.tot)} ${wrf(h.wr)}${tag}`);
    if (!winner || f.tot > winner.f.tot) winner = { thr, f, h };
  }
  const live = tradesByThr.get(LIVE);
  const liveF = agg(live.filter((t) => t.d < FIT_END));
  const liveH = agg(live.filter((t) => t.d >= FIT_END));
  console.log(`\n  fit's winner: ${winner.thr.toFixed(2)} — holdout ${(winner.h.tot * 100).toFixed(1)}% vs live 0.15 holdout ${(liveH.tot * 100).toFixed(1)}%`);
  const ships = winner.thr !== LIVE && winner.f.tot > liveF.tot && winner.h.tot > liveH.tot;
  console.log(`  VERDICT RULE: a change ships only if the fit winner beats live 0.15 in BOTH windows.`);
  console.log(`  → ${ships ? `CANDIDATE: ${winner.thr.toFixed(2)} beats 0.15 in both windows` : `NO CHANGE: ${winner.thr === LIVE ? "fit chose the live threshold" : "fit's winner does not beat 0.15 in both windows"}`}\n`);
  return winner;
}

// ── PART 2: choose annually from the trailing 5 years, walk forward ─────────
function part2(tradesByThr, fitWinnerThr) {
  const lastYear = Number(new Date().toISOString().slice(0, 4));
  const rows = [];
  for (let Y = 2005; Y <= lastYear; Y++) {
    const lo = `${Y - 5}-01-01`, hi = `${Y}-01-01`;
    let choice = null, best = -Infinity;
    for (const thr of GRID) {                       // ascending → ties go tighter
      const s = tradesByThr.get(thr)
        .filter((t) => t.d >= lo && t.exitD < hi)   // resolved before Y begins
        .reduce((a, t) => a + t.ret, 0);
      if (s > best) { best = s; choice = thr; }
    }
    const fwd = agg(tradesByThr.get(choice).filter((t) => t.d >= `${Y}-01-01` && t.d < `${Y + 1}-01-01`));
    rows.push({ Y, choice, fwd });
  }
  const churn = rows.filter((r, i) => i > 0 && r.choice !== rows[i - 1].choice).length;
  console.log("PART 2 — THE 5-YEAR PROPOSAL AS A POLICY (re-choose each Jan 1 from trailing 5y)");
  console.log("  " + rows.map((r) => `${r.Y}:${r.choice.toFixed(2)}`).join("  "));
  console.log(`  choice changed ${churn}× in ${rows.length - 1} transitions\n`);
  const span = (sel) => {
    const path = rows.filter((r) => sel(r.Y)).reduce((a, r) => a + r.fwd.tot, 0);
    const stat = (thr) => agg(tradesByThr.get(thr)
      .filter((t) => sel(Number(t.d.slice(0, 4))))).tot;
    return { path, stat };
  };
  const full = span(() => true);
  const hold = span((y) => y >= 2015);
  console.log("  span         5y-rechosen   static 0.15   long-fit winner (" + fitWinnerThr.toFixed(2) + ")");
  console.log(`  2005–now   ${pctf(full.path)}    ${pctf(full.stat(LIVE))}    ${pctf(full.stat(fitWinnerThr))}  (winner in-sample pre-2015 — caveat)`);
  console.log(`  2015–now   ${pctf(hold.path)}    ${pctf(hold.stat(LIVE))}    ${pctf(hold.stat(fitWinnerThr))}  (all three out of sample — the fair head-to-head)`);
  console.log(`  VERDICT RULE: the 5y window replaces the long bar only if the re-chosen path`);
  console.log(`  beats BOTH statics on the 2015+ span.\n`);
}

// ── PART 3: hourly candles on the span where they exist ─────────────────────
function resolveIntraday(sessions, thr) {
  const flat = [];
  for (let si = 0; si < sessions.length; si++) {
    let runH = -Infinity, runL = Infinity;
    const last = sessions[si].bars.length - 1;
    for (let bi = 0; bi <= last; bi++) {
      const b = sessions[si].bars[bi];
      runH = Math.max(runH, b.h); runL = Math.min(runL, b.l);
      flat.push({ si, bi, isLast: bi === last, l: b.l, c: b.c, runH, runL });
    }
  }
  const rIbs = (f) => (f.runH - f.runL > 0 ? (f.c - f.runL) / (f.runH - f.runL) : 0.5);
  const out = [];
  let k = 0;
  while (k < flat.length) {
    const f = flat[k];
    if (f.bi === 0 || rIbs(f) > thr) { k++; continue; }
    const entry = f.c, stop = entry * 0.97, s0 = f.si;
    let ret = null, exitJ = null;
    for (let j = k + 1; j < flat.length; j++) {
      const b = flat[j];
      if (b.l <= stop) { ret = -0.03; exitJ = j; break; }
      if (rIbs(b) >= 0.6) { ret = b.c / entry - 1; exitJ = j; break; }
      if (b.si === s0 + 5 && b.isLast) { ret = b.c / entry - 1; exitJ = j; break; }
    }
    if (ret == null) { exitJ = flat.length - 1; ret = flat[exitJ].c / entry - 1; }
    out.push({ d: sessions[s0].d, entryPx: entry, ret });
    k = exitJ + 1;
  }
  return out;
}

async function part3(sym) {
  const sessions = await hourlySessions(sym, 720);
  if (sessions.length < 100) { console.log(`PART 3 — ${sym}: only ${sessions.length} hourly sessions, skipping`); return; }
  const mid = sessions[Math.floor(sessions.length / 2)].d;
  const first = sessions[0].d, lastD = sessions[sessions.length - 1].d;
  console.log(`PART 3 — SMALLER CANDLES, ${sym} hourly ${first} → ${lastD} (${sessions.length} sessions; fit < ${mid} ≤ holdout)`);
  console.log("  MECHANICS CHECK on ~2y of data — not an edge test; differences of a few % are noise.");

  const daily = (await dailyBars(sym, Number(first.slice(0, 4)))).filter((b) => b.d >= first && b.d <= lastD);
  const closeByDay = new Map(daily.map((b) => [b.d, b.c]));

  console.log("  thr    hourly fit: n/tot/WR   hourly hold: n/tot/WR   daily fit: n/tot   daily hold: n/tot");
  let win = null;
  for (const thr of GRID) {
    const hts = resolveIntraday(sessions, thr);
    const hf = agg(hts.filter((t) => t.d < mid)), hh = agg(hts.filter((t) => t.d >= mid));
    const dts = resolveTrades(daily, thr);
    const df = agg(dts.filter((t) => t.d < mid)), dh = agg(dts.filter((t) => t.d >= mid));
    const tag = thr === LIVE ? " ← live" : "";
    console.log(`  ${thr.toFixed(2)} ${String(hf.n).padStart(5)} ${pctf(hf.tot)} ${wrf(hf.wr)}   ${String(hh.n).padStart(5)} ${pctf(hh.tot)} ${wrf(hh.wr)}   ${String(df.n).padStart(4)} ${pctf(df.tot)}   ${String(dh.n).padStart(4)} ${pctf(dh.tot)}${tag}`);
    if (!win || hf.tot > win.hf.tot) win = { thr, hf, hh };
  }
  // what the daily lab cannot see: intraday fills land below the day's close
  const live15 = resolveIntraday(sessions, LIVE);
  const edges = live15.map((t) => (closeByDay.get(t.d) || t.entryPx) / t.entryPx - 1);
  const meanEdge = edges.length ? edges.reduce((a, x) => a + x, 0) / edges.length : 0;
  console.log(`\n  hourly fit winner: ${win.thr.toFixed(2)} (holdout ${(win.hh.tot * 100).toFixed(1)}%)`);
  console.log(`  fill-vs-close at 0.15: intraday entries average ${(meanEdge * 100).toFixed(2)}% below that day's close (n=${edges.length}) — the entry timing daily bars cannot model.\n`);
}

(async () => {
  const args = process.argv.slice(2);
  const SYM = args.includes("--sym") ? args[args.indexOf("--sym") + 1] : "SPY";
  const FROM = args.includes("--from") ? Number(args[args.indexOf("--from") + 1]) : 2000;
  const intradayOnly = args.includes("--intraday-only");
  console.log(`=== threshold_lab ${SYM} ===\n`);
  if (!intradayOnly) {
    const bars = await dailyBars(SYM, FROM);
    console.log(`daily: ${bars.length} bars ${bars[0].d} → ${bars[bars.length - 1].d}\n`);
    const tradesByThr = new Map(GRID.map((thr) => [thr, resolveTrades(bars, thr)]));
    const winner = part1(tradesByThr);
    part2(tradesByThr, winner.thr);
  }
  await part3(SYM);
})().catch((e) => { console.error("lab failed:", e.message); process.exit(1); });
