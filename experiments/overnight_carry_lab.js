/**
 * overnight_carry_lab.js — what should the book do at 16:00? (#3384 follow-up)
 *
 * Motivated by the week of 2026-08-17: −$7,185, of which 80% was not entries —
 * it was the carried long book marking down through four consecutive sessions
 * that closed at their lows (SPY day-IBS 0.04/0.19/0.23/0.10). Two proposals:
 *
 *   ARM A — carry brake: when the day closes at its lows, don't hold longs
 *           overnight (the operator's carried book bled −$5.8k that way).
 *   ARM B — inverse trend-hold (operator idea 2026-08-20): "when the market is
 *           just drifting down for days, hold the inverse ETF until momentum
 *           death/reversal."
 *
 * THE BAR (operator standing rule): fit on 2000–2014, hold out 2015–2026, and
 * a change ships only if it wins BOTH windows on total income. Parameters are
 * chosen on the fit window alone; the holdout is scored once, with the fit's
 * winner, and reported whether it flatters or embarrasses.
 *
 * WHAT THIS MEASURES HONESTLY:
 *   - Arm A conditions the overnight (close→next-open) and full next-day
 *     (close→close) return on today's day-IBS. That is exactly the decision the
 *     live system faces at 16:00 with a carried book. No entry modelling, no
 *     exit modelling — pure carry policy.
 *   - Arm B simulates a synthetic daily-rebalanced inverse (−1x and −3x of the
 *     index's close-to-close return, compounded daily — which is how the real
 *     funds work, so path decay emerges naturally instead of being assumed
 *     away). Real SOXS/SQQQ did not exist in 2000; the synthetic is the only
 *     honest way to test the idea across both windows, and it is labelled such.
 *   - Fund expense (~0.95%/yr for the 3x) and borrow are NOT modelled: they
 *     would only make Arm B slightly worse, so a rejection is conservative and
 *     an acceptance would need them revisited.
 *
 * Usage: node experiments/overnight_carry_lab.js [--sym SPY] [--from 2000]
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
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${p2}`;
  const j = await fetchJson(u);
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
const pct = (x) => (x * 100).toFixed(2) + "%";
const FIT = (d) => d < "2015-01-01";
const HOLD = (d) => d >= "2015-01-01";

/** Compound a series of per-day simple returns into total return. */
function compound(rets) { let e = 1; for (const r of rets) e *= 1 + r; return e - 1; }

// ── ARM A: the carry decision, conditioned on how the day closed ─────────────
function armA(bars) {
  // For each day i (except the last): overnight gap = open[i+1]/close[i]−1;
  // full carry day = close[i+1]/close[i]−1. Bucket by day-IBS of day i.
  const rows = [];
  for (let i = 0; i < bars.length - 1; i++) {
    rows.push({ d: bars[i].d, ibs: ibs(bars[i]),
      gap: bars[i + 1].o / bars[i].c - 1, cc: bars[i + 1].c / bars[i].c - 1 });
  }
  const buckets = [[0, 0.15], [0.15, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.001]];
  const table = (rs) => buckets.map(([lo, hi]) => {
    const g = rs.filter((r) => r.ibs >= lo && r.ibs < hi);
    return { bucket: `${lo}-${hi === 1.001 ? 1 : hi}`, n: g.length,
      avgGap: g.length ? g.reduce((t, r) => t + r.gap, 0) / g.length : null,
      avgCC: g.length ? g.reduce((t, r) => t + r.cc, 0) / g.length : null };
  });
  // Policy comparison at a threshold: baseline = carry every night; brake =
  // skip the overnight (gap) whenever day-IBS < thr. Difference = the summed
  // gap return on braked nights (what the brake dodges or forfeits).
  const policy = (rs, thr) => {
    const braked = rs.filter((r) => r.ibs < thr);
    return { thr, nights: braked.length,
      gapAvoided: braked.reduce((t, r) => t + r.gap, 0),          // sum of overnight moves not held
      ccAvoided: braked.reduce((t, r) => t + r.cc, 0) };          // if the de-carry also skips next day
  };
  return { rows, table, policy };
}

// ── ARM B: hold the inverse through a down-drift until reversal ─────────────
/**
 * Regime entry variants (decided on FIT only):
 *   drift2  — two consecutive days with day-IBS ≤ 0.25
 *   drift3  — three consecutive down closes
 *   below5  — close < 5-day SMA AND day-IBS ≤ 0.25
 * Exit ("momentum death of the DOWN move" — the operator's reversal): first day
 * with day-IBS ≥ 0.6 (dip-buyers won the day), exit at the NEXT open. Entries
 * also at the next open after the signal day. No look-ahead anywhere.
 * P&L: synthetic daily-rebalanced inverse = −L × index close-to-close return
 * per day held, compounded (L = 1 or 3). First held day uses open→close.
 */
function armB(bars, variant, L) {
  const sma5 = (i) => (i >= 4 ? (bars[i].c + bars[i - 1].c + bars[i - 2].c + bars[i - 3].c + bars[i - 4].c) / 5 : null);
  const entrySignal = (i) => {
    if (variant === "drift2") return i >= 1 && ibs(bars[i]) <= 0.25 && ibs(bars[i - 1]) <= 0.25;
    if (variant === "drift3") return i >= 2 && bars[i].c < bars[i - 1].c && bars[i - 1].c < bars[i - 2].c && bars[i - 2].c < bars[i - 3 < 0 ? 0 : i - 3].c;
    if (variant === "below5") return sma5(i) != null && bars[i].c < sma5(i) && ibs(bars[i]) <= 0.25;
    throw new Error("unknown variant " + variant);
  };
  const episodes = [];
  let i = 0;
  while (i < bars.length - 2) {
    if (!entrySignal(i)) { i++; continue; }
    // enter at next open; hold until the first day with IBS>=0.6, exit the open after it
    const entryIdx = i + 1;
    let j = entryIdx;
    while (j < bars.length - 1 && ibs(bars[j]) < 0.6) j++;
    const exitIdx = Math.min(j + 1, bars.length - 1);           // exit at next open after reversal day
    const rets = [];
    // day of entry: open→close on the inverse
    rets.push(-L * (bars[entryIdx].c / bars[entryIdx].o - 1));
    for (let k = entryIdx + 1; k < exitIdx; k++) rets.push(-L * (bars[k].c / bars[k - 1].c - 1));
    // exit morning: close[exit-1] → open[exit]
    rets.push(-L * (bars[exitIdx].o / bars[exitIdx - 1].c - 1));
    episodes.push({ enter: bars[entryIdx].d, exit: bars[exitIdx].d,
      days: exitIdx - entryIdx + 1, ret: compound(rets) });
    i = exitIdx;                                                 // no overlapping episodes
  }
  return episodes;
}

function epStats(eps) {
  if (!eps.length) return { n: 0 };
  const tot = compound(eps.map((e) => e.ret));
  const wins = eps.filter((e) => e.ret > 0).length;
  const avgDays = eps.reduce((t, e) => t + e.days, 0) / eps.length;
  const worst = Math.min(...eps.map((e) => e.ret));
  const best = Math.max(...eps.map((e) => e.ret));
  return { n: eps.length, totalCompounded: tot, winRate: wins / eps.length,
    avgHoldDays: avgDays, worst, best,
    perYear: eps.length / ((Date.parse(eps[eps.length - 1].exit) - Date.parse(eps[0].enter)) / 3.156e10) };
}

(async () => {
  const args = process.argv.slice(2);
  const SYM = args[args.indexOf("--sym") + 1] && args.includes("--sym") ? args[args.indexOf("--sym") + 1] : "SPY";
  const FROM = args.includes("--from") ? Number(args[args.indexOf("--from") + 1]) : 2000;
  const bars = await dailyBars(SYM, FROM);
  console.log(`${SYM}: ${bars.length} daily bars  ${bars[0].d} → ${bars[bars.length - 1].d}`);
  const fitBars = bars.filter((b) => FIT(b.d));
  const holdBars = bars.filter((b) => HOLD(b.d));
  console.log(`fit 2000–2014: ${fitBars.length} bars | holdout 2015–2026: ${holdBars.length} bars\n`);

  // ═══ ARM A ═══
  console.log("════ ARM A — overnight carry, conditioned on how the day closed ════");
  const A = armA(bars);
  for (const [name, rs] of [["FIT 2000–2014", A.rows.filter((r) => FIT(r.d))], ["HOLDOUT 2015–2026", A.rows.filter((r) => HOLD(r.d))]]) {
    console.log(`  ${name}`);
    console.log("  day-IBS bucket      n     avg overnight gap   avg next close-to-close");
    for (const t of A.table(rs)) {
      console.log(`  ${t.bucket.padEnd(12)} ${String(t.n).padStart(6)}   ${t.avgGap == null ? "—" : (t.avgGap * 1e4).toFixed(1).padStart(8) + " bp"}          ${t.avgCC == null ? "—" : (t.avgCC * 1e4).toFixed(1).padStart(8) + " bp"}`);
    }
  }
  console.log("\n  BRAKE POLICY (skip the overnight when day-IBS < thr) — summed return the brake AVOIDS holding");
  console.log("  (negative avoided = the brake dodged losses = brake EARNS; positive = it forfeited gains)");
  console.log("  thr     window              nights   overnight avoided   full-next-day avoided");
  for (const thr of [0.15, 0.2, 0.25, 0.3]) {
    for (const [name, rs] of [["fit", A.rows.filter((r) => FIT(r.d))], ["holdout", A.rows.filter((r) => HOLD(r.d))]]) {
      const p = A.policy(rs, thr);
      console.log(`  ${String(thr).padEnd(6)} ${name.padEnd(18)} ${String(p.nights).padStart(6)}   ${pct(p.gapAvoided).padStart(12)}        ${pct(p.ccAvoided).padStart(12)}`);
    }
  }

  // ═══ ARM B ═══
  console.log("\n════ ARM B — hold the inverse through the drift until reversal (operator idea) ════");
  console.log("  synthetic daily-rebalanced inverse of " + SYM + " (real 3x funds did not exist in 2000; decay emerges from compounding)");
  console.log("  exit rule for all variants: first day with day-IBS ≥ 0.6, out at the next open\n");
  console.log("  variant  lev   window     episodes  /yr   winRate   avgHold   total(compounded)   worst ep");
  const fmt = (s) => s.n === 0 ? "        —" : `${String(s.n).padStart(6)}  ${s.perYear.toFixed(1).padStart(4)}   ${(s.winRate * 100).toFixed(0).padStart(4)}%   ${s.avgHoldDays.toFixed(1).padStart(5)}d   ${pct(s.totalCompounded).padStart(12)}   ${pct(s.worst).padStart(8)}`;
  for (const variant of ["drift2", "drift3", "below5"]) {
    for (const L of [1, 3]) {
      const fit = epStats(armB(fitBars, variant, L));
      const hold = epStats(armB(holdBars, variant, L));
      console.log(`  ${variant.padEnd(8)} -${L}x   fit        ${fmt(fit)}`);
      console.log(`  ${" ".repeat(8)}       holdout    ${fmt(hold)}`);
    }
  }
  console.log("\n  VERDICT RULE: an arm ships only if its chosen variant is positive in BOTH windows.");
})();
