/**
 * rotation_lab.js — does nightly walk-forward strategy rotation beat a static
 * config? (#3410 — the one transferable idea from Trade Ideas' Holly/Money
 * Machine research, 2026-08-22.)
 *
 * THEIR ARCHITECTURE, distilled: ~60-70 rule strategies, re-backtested nightly,
 * only the recently-performing subset trades tomorrow. No forecasting — the
 * regime is never predicted, only measured after the fact and used to SELECT.
 * That sidesteps everything our labs rejected (prediction: carry brake, inverse
 * holds, day-rides — all dead on the two-window bar) while attacking the same
 * pain: a static config bleeding through a regime flip (week of 2026-08-17).
 *
 * THE HONEST RISK: rotation is institutionalized recency — its failure mode is
 * fitting the last M sessions' noise. Which is precisely what this bar exists
 * to catch: fit 2000–2014 chooses (M, policy); holdout 2015–2026 is scored
 * once, with the fit's winner, and reported either way.
 *
 * DESIGN
 *   variants — K simple daily analogs of the live system's own knobs, all
 *              long-only washout mean-reversion (the system's identity):
 *                ibs10  : enter close when dayIBS ≤ 0.10
 *                ibs15  : enter close when dayIBS ≤ 0.15   (≈ live default)
 *                ibs25  : enter close when dayIBS ≤ 0.25
 *                ibs15g : ibs15 AND day fell ≥ 0.5% (deeper washout)
 *                ibs15u : ibs15 AND close > 200d SMA (uptrend-only)
 *                ibs15b : ibs15 AND prior day also red (2-day washout)
 *              exit for all: first day with dayIBS ≥ 0.6 → out at that close,
 *              else 5-session timeout; stop at −3% underlying (floor lab
 *              settled stops — identical across variants so only SELECTION
 *              differs).
 *   static   — each variant traded every day it signals; the best on FIT is
 *              the baseline rotation must beat.
 *   rotation — each night, score every variant on its trades over the trailing
 *              M sessions (sum of per-trade returns). Tomorrow, trade only the
 *              top variant; policy 'posOnly' goes FLAT when even the best
 *              trailing score is ≤ 0. M and policy are chosen on fit alone.
 *   metric   — total summed per-trade return (income), plus trades/WR. No
 *              look-ahead anywhere: selection at close T uses trades resolved
 *              by T; the selected variant trades T+1's signal.
 *
 * Usage: node experiments/rotation_lab.js [--sym SPY] [--from 2000]
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
async function dailyBars(sym, fromYear) {
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no chart data for " + sym);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}
const ibs = (b) => (b.h - b.l > 0 ? (b.c - b.l) / (b.h - b.l) : 0.5);
const FIT = (d) => d < "2015-01-01";

// ── the variant set ─────────────────────────────────────────────────────────
function makeSignals(bars) {
  const sma200 = [];
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    acc += bars[i].c;
    if (i >= 200) acc -= bars[i - 200].c;
    sma200.push(i >= 199 ? acc / 200 : null);
  }
  const V = {
    ibs10: (i) => ibs(bars[i]) <= 0.10,
    ibs15: (i) => ibs(bars[i]) <= 0.15,
    ibs25: (i) => ibs(bars[i]) <= 0.25,
    ibs15g: (i) => ibs(bars[i]) <= 0.15 && bars[i].c / bars[i].o - 1 <= -0.005,
    ibs15u: (i) => ibs(bars[i]) <= 0.15 && sma200[i] != null && bars[i].c > sma200[i],
    ibs15b: (i) => i >= 1 && ibs(bars[i]) <= 0.15 && bars[i].c < bars[i - 1].c,
  };
  return V;
}

/**
 * Resolve every trade for one variant: enter at signal-day close, exit at the
 * first day with dayIBS ≥ 0.6 (that close), −3% underlying stop (pessimistic:
 * checked before the bounce), else 5-session timeout close. Non-overlapping.
 * Each trade records the ENTRY day (selection joins on it) and the EXIT index
 * (a trade only informs selection after it has resolved).
 */
function resolveTrades(bars, sig) {
  const out = [];
  let i = 0;
  while (i < bars.length - 1) {
    if (!sig(i)) { i++; continue; }
    const entry = bars[i].c;
    const stop = entry * 0.97;
    let ret = null, j = i + 1;
    for (; j < Math.min(i + 6, bars.length); j++) {
      if (bars[j].l <= stop) { ret = -0.03; break; }
      if (ibs(bars[j]) >= 0.6) { ret = bars[j].c / entry - 1; break; }
    }
    if (ret == null) { j = Math.min(i + 5, bars.length - 1); ret = bars[j].c / entry - 1; }
    out.push({ entryIdx: i, exitIdx: j, d: bars[i].d, ret });
    i = j;                                          // non-overlapping episodes
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const SYM = args.includes("--sym") ? args[args.indexOf("--sym") + 1] : "SPY";
  const FROM = args.includes("--from") ? Number(args[args.indexOf("--from") + 1]) : 2000;
  const bars = await dailyBars(SYM, FROM);
  console.log(`${SYM}: ${bars.length} bars ${bars[0].d} → ${bars[bars.length - 1].d}\n`);
  const V = makeSignals(bars);
  const names = Object.keys(V);
  const trades = {};
  for (const n of names) trades[n] = resolveTrades(bars, V[n]);

  // ── static baselines ──────────────────────────────────────────────────────
  const winTot = (ts, sel) => {
    const g = ts.filter((t) => sel(t.d));
    return { n: g.length, tot: g.reduce((s, t) => s + t.ret, 0),
      wr: g.length ? g.filter((t) => t.ret > 0).length / g.length : 0 };
  };
  console.log("STATIC VARIANTS (each traded always)");
  console.log("  variant   fit: n / total / WR          holdout: n / total / WR");
  let bestStatic = null;
  for (const n of names) {
    const f = winTot(trades[n], FIT), h = winTot(trades[n], (d) => !FIT(d));
    console.log(`  ${n.padEnd(8)} ${String(f.n).padStart(4)} ${(f.tot * 100).toFixed(1).padStart(8)}% ${(f.wr * 100).toFixed(0).padStart(4)}%        ${String(h.n).padStart(4)} ${(h.tot * 100).toFixed(1).padStart(8)}% ${(h.wr * 100).toFixed(0).padStart(4)}%`);
    if (!bestStatic || f.tot > bestStatic.f.tot) bestStatic = { name: n, f, h };
  }
  console.log(`  → best static on FIT: ${bestStatic.name} (its holdout: ${(bestStatic.h.tot * 100).toFixed(1)}%)\n`);

  // ── rotation ──────────────────────────────────────────────────────────────
  // For selection speed, index resolved trades by exit day per variant.
  const byExit = {};
  for (const n of names) {
    byExit[n] = new Map();
    for (const t of trades[n]) {
      const d = bars[t.exitIdx].d;
      byExit[n].set(d, (byExit[n].get(d) || 0) + t.ret);
    }
  }
  // trailing score of variant n over the M sessions ENDING at index i (inclusive)
  const trailing = (n, i, M) => {
    let s = 0;
    for (let k = Math.max(0, i - M + 1); k <= i; k++) s += byExit[n].get(bars[k].d) || 0;
    return s;
  };
  const rotate = (M, posOnly, sel) => {
    // walk the calendar: at each day i (close), pick tomorrow's variant from
    // trailing scores; if tomorrow (i+1) fires that variant's signal, take its
    // resolved trade. Entry-day join keeps one trade max per day.
    const tradeByEntry = {};
    for (const n of names) {
      tradeByEntry[n] = new Map();
      for (const t of trades[n]) tradeByEntry[n].set(t.d, t);
    }
    let tot = 0, ntr = 0, wins = 0;
    for (let i = 220; i < bars.length - 1; i++) {           // SMA warmup + M
      if (!sel(bars[i + 1].d)) continue;
      let best = null, bestScore = -Infinity;
      for (const n of names) {
        const s = trailing(n, i, M);
        if (s > bestScore) { bestScore = s; best = n; }
      }
      if (posOnly && bestScore <= 0) continue;              // nothing recently fit → flat
      const t = tradeByEntry[best].get(bars[i + 1].d);
      if (!t) continue;
      tot += t.ret; ntr++; if (t.ret > 0) wins++;
    }
    return { tot, n: ntr, wr: ntr ? wins / ntr : 0 };
  };

  console.log("ROTATION (pick tomorrow's variant from trailing-M performance; chosen on FIT only)");
  console.log("  M     policy    fit: n / total / WR");
  let bestRot = null;
  for (const M of [10, 20, 40]) {
    for (const posOnly of [false, true]) {
      const f = rotate(M, posOnly, FIT);
      console.log(`  ${String(M).padEnd(4)}  ${(posOnly ? "posOnly" : "always ").padEnd(8)} ${String(f.n).padStart(4)} ${(f.tot * 100).toFixed(1).padStart(8)}% ${(f.wr * 100).toFixed(0).padStart(4)}%`);
      if (!bestRot || f.tot > bestRot.f.tot) bestRot = { M, posOnly, f };
    }
  }
  const hRot = rotate(bestRot.M, bestRot.posOnly, (d) => !FIT(d));
  console.log(`\n  fit's winner: M=${bestRot.M} ${bestRot.posOnly ? "posOnly" : "always"}`);
  console.log(`  HOLDOUT — rotation: ${String(hRot.n).padStart(4)} trades  ${(hRot.tot * 100).toFixed(1)}%  WR ${(hRot.wr * 100).toFixed(0)}%`);
  console.log(`  HOLDOUT — best static (${bestStatic.name}): ${String(bestStatic.h.n).padStart(4)} trades  ${(bestStatic.h.tot * 100).toFixed(1)}%  WR ${(bestStatic.h.wr * 100).toFixed(0)}%`);
  console.log(`\n  VERDICT RULE: rotation ships toward a live shadow only if it beats the best`);
  console.log(`  static variant on total income in BOTH windows.`);
})();
