/**
 * stop_floor_lab.js — is a flat 3% floor the wrong stop for 3x wrappers? (#3390)
 *
 * The flaw, from the week of 2026-08-17: a 3% instrument floor on a 3x wrapper
 * is a 1% underlying move — inside ordinary daily noise. A Monday SOXS entry
 * would have been floored out −4.55% intraday and missed Tuesday's +15.2%; the
 * same geometry stalks every SOXL/TQQQ long. The live book's own excursion
 * ledger is too thin to decide (32 exits with MFE/MAE, only 2 leveraged, the
 * big stop-outs recorded as reconstructions with null excursions), so this goes
 * to the standing two-window bar: fit 2000–2014, holdout 2015–2026, a floor
 * variant ships only if it beats the 3% baseline in BOTH windows.
 *
 * DESIGN
 *   entry    — the system's washout trigger at daily scale: day-IBS ≤ 0.15,
 *              enter at that day's close (pessimistic vs the live intraday fill)
 *   vehicle  — synthetic daily-rebalanced 3x LONG of the underlying (decay
 *              emerges from compounding; SOXL/TQQQ did not exist in 2000)
 *   exits    — identical for every variant except the floor F:
 *                stop   : underlying low ≤ entry_u × (1 − F/(100·L))  [3x: F/3]
 *                bounce : first day with day-IBS ≥ 0.6 → exit at that close
 *                timeout: 5 sessions → exit at close
 *   sizing   — CONSTANT DOLLAR RISK, exactly like the live engine (qty comes
 *              from risk$/stopDist): P&L per episode = riskUnit × (ret / F).
 *              A wide floor is NOT "more risk per trade" — it is fewer shares
 *              with the same risk, which is the whole point of testing it.
 *
 * Usage: node experiments/stop_floor_lab.js [--sym SMH] [--from 2000]
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

/**
 * One pass for floor F (instrument %) and leverage L.
 * Returns risk-normalized episode results: retR = instrument return / F,
 * i.e. R-multiples at constant dollar risk (stop-out = −1R by construction).
 */
function run(bars, F, L) {
  const eps = [];
  let i = 0;
  while (i < bars.length - 2) {
    if (ibs(bars[i]) > 0.15) { i++; continue; }
    const entryU = bars[i].c;                      // enter at the washout close
    const stopU = entryU * (1 - F / (100 * L));    // instrument floor mapped to the underlying
    let instRet = 0;                                // compounded 3x instrument return
    let ref = entryU;                               // prior close for daily 3x rebalance
    let exited = false;
    let j = i + 1;
    for (; j < Math.min(i + 6, bars.length); j++) {
      const b = bars[j];
      if (b.l <= stopU) {                           // pessimistic: stop before bounce
        // instrument return at the stop print: rebalance days so far, then today to the stop
        instRet = (1 + instRet) * (1 + L * (stopU / ref - 1)) - 1;
        eps.push({ d: bars[i].d, exit: 'stop', retR: instRet / (F / 100) });
        exited = true; break;
      }
      instRet = (1 + instRet) * (1 + L * (b.c / ref - 1)) - 1;
      ref = b.c;
      if (ibs(b) >= 0.6) {                          // the bounce the strategy sells
        eps.push({ d: bars[i].d, exit: 'bounce', retR: instRet / (F / 100) });
        exited = true; j++; break;
      }
    }
    if (!exited) eps.push({ d: bars[i].d, exit: 'timeout', retR: instRet / (F / 100) });
    i = Math.max(j, i + 1);
  }
  return eps;
}

function stats(eps) {
  if (!eps.length) return null;
  const tot = eps.reduce((t, e) => t + e.retR, 0);
  return { n: eps.length, totR: tot, avgR: tot / eps.length,
    wr: eps.filter((e) => e.retR > 0).length / eps.length,
    stopped: eps.filter((e) => e.exit === 'stop').length / eps.length };
}

(async () => {
  const args = process.argv.slice(2);
  const SYM = args.includes("--sym") ? args[args.indexOf("--sym") + 1] : "SMH";
  const FROM = args.includes("--from") ? Number(args[args.indexOf("--from") + 1]) : 2000;
  const bars = await dailyBars(SYM, FROM);
  console.log(`${SYM}: ${bars.length} bars ${bars[0].d} → ${bars[bars.length - 1].d}`);
  console.log(`vehicle: synthetic 3x long ${SYM} | entry: day-IBS ≤ 0.15 at close | exits: floor / IBS≥0.6 bounce / 5d timeout`);
  console.log(`P&L in R at CONSTANT dollar risk (stop = −1R for every floor — wider floor = fewer shares, same $)\n`);
  console.log("floor  window     episodes   winRate   stopped   totalR    avgR");
  const L = 3;
  for (const F of [3, 4.5, 6, 9, 12]) {
    for (const [name, sel] of [["fit    ", (d) => FIT(d)], ["holdout", (d) => !FIT(d)]]) {
      const eps = run(bars.filter(() => true), F, L).filter((e) => sel(e.d));
      const s = stats(eps);
      console.log(`${String(F).padEnd(5)}  ${name}   ${String(s.n).padStart(6)}    ${(s.wr * 100).toFixed(0).padStart(4)}%    ${(s.stopped * 100).toFixed(0).padStart(4)}%   ${s.totR.toFixed(1).padStart(7)}  ${s.avgR.toFixed(3).padStart(7)}`);
    }
  }
  console.log("\nVERDICT RULE: a floor ships only if it beats floor=3 on totalR in BOTH windows.");
})();
