"use strict";
/**
 * Favorite–longshot bias: the CORRECTED backtest (#2954). Single-event markets only.
 *
 * Every correction the review demanded, implemented and asserted:
 *   C1 DECISION POINTS — price at a fraction of the market's TRADE LIFE, not "ever traded in
 *      bucket". The original whole-life bucketing conditions on ever-touching a price, and
 *      eventual winners nearly always pass through cheap prices, so it is biased FOR longshots
 *      (it reported low-bucket +5.56c and a wrong-sign Spearman). Decision-point conditioning is
 *      the only decision-relevant view — and it was the analysis whose code was never committed.
 *   C2 EVENT-LEVEL CLUSTERING — one Kalshi event has many bracket markets sharing ONE outcome
 *      (KXHIGHNY-T85/T86/T87...). Clustering by market double-counts mirrors and inflates t.
 *   C3 SELLER-SIDE, MAKER-REALISTIC ACCOUNTING — the trade is to SELL the cheap YES. We can only
 *      be filled as a maker when a TAKER BUYS yes (taker_side='yes'), so only those trades are
 *      executable evidence. Maker fee ~0 at these sizes (2026-07 schedule); taker fee shown for
 *      contrast. net_maker_seller = p - V.
 *   C4 NO PARLAYS — single-event series only, asserted per market.
 *   C5 ADVERSE SELECTION — the load-bearing unknown. If takers who buy cheap YES are informed,
 *      P(settle YES | taker bought at p) exceeds p. Measured directly here.
 *
 * Read-only. Run: node experiments/kalshi_flb_corrected.js
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "kalshi", "settled-single");
const OUT = path.join(__dirname, "results", "kalshi_flb_corrected.json");
const PARLAY = /^KXMVE/i;
const BUCKETS = [[1, 5], [5, 10], [10, 15], [15, 25], [25, 40], [40, 60], [60, 75], [75, 85], [85, 95], [95, 99]];
const POINTS = [0.25, 0.40, 0.50, 0.60, 0.75];

const feeC = (p) => 0.07 * p * (100 - p) / 100;           // taker fee, cents/contract
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** Wilson 95% CI for a rate — the HONEST statistic when a bucket's outcomes are near-degenerate.
 *  A t-test on P&L explodes (t>30) when every market in a bucket settled the same way, because
 *  the only variance left is price jitter. That is an artifact, not significance. Report this. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, 100 * (c - h)), Math.min(100, 100 * (c + h))];
}
function tstat(a) {
  const n = a.length; if (n < 2) return { n, m: mean(a), t: 0, p: 1 };
  const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const t = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
  const z = Math.abs(t), p = 2 * (1 - (1 - 0.5 * Math.exp(-0.717 * z - 0.416 * z * z)));  // normal approx
  return { n, m, t, p: Math.max(0, Math.min(1, p)) };
}

function load() {
  if (!fs.existsSync(DIR)) { console.error("no data — run experiments/kalshi_collect_single_event.js first"); process.exit(1); }
  const markets = new Map();   // ticker -> {V, event, series}
  const trades = new Map();    // ticker -> [{t, p, c, takerYes}]
  let parlaySeen = 0;
  for (const fn of fs.readdirSync(DIR)) {
    if (fn.endsWith(".markets.jsonl")) {
      const series = fn.replace(".markets.jsonl", "");
      for (const line of fs.readFileSync(path.join(DIR, fn), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (PARLAY.test(m.ticker || "")) { parlaySeen++; continue; }              // C4
        const r = (m.result || "").toLowerCase();
        if (r !== "yes" && r !== "no") continue;
        markets.set(m.ticker, { V: r === "yes" ? 100 : 0, event: m.event_ticker || m.ticker, series });
      }
    }
  }
  for (const fn of fs.readdirSync(DIR)) {
    if (!fn.endsWith(".trades.jsonl")) continue;
    for (const line of fs.readFileSync(path.join(DIR, fn), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const t = JSON.parse(line);
      if (!markets.has(t.ticker)) continue;
      const p = Math.round(parseFloat(t.yes_price_dollars) * 100);
      const c = parseFloat(t.count_fp || 0) || 0;
      const ts = Date.parse(t.created_time);
      if (!Number.isFinite(p) || p <= 0 || p >= 100 || !Number.isFinite(ts) || c <= 0) continue;
      if (!trades.has(t.ticker)) trades.set(t.ticker, []);
      trades.get(t.ticker).push({ ts, p, c, takerYes: String(t.taker_side || t.taker_outcome_side || "").toLowerCase() === "yes" });
    }
  }
  for (const arr of trades.values()) arr.sort((a, b) => a.ts - b.ts);
  return { markets, trades, parlaySeen };
}

function main() {
  const { markets, trades, parlaySeen } = load();
  const nMkt = [...trades.keys()].filter((k) => markets.has(k)).length;
  const nTrades = [...trades.values()].reduce((s, a) => s + a.length, 0);
  console.log(`single-event markets with trades: ${nMkt}   trades: ${nTrades}   parlays excluded: ${parlaySeen}`);

  const report = { date: new Date().toISOString().slice(0, 10), corrections: ["C1 decision-point", "C2 event-cluster", "C3 maker-seller", "C4 no parlays", "C5 adverse-selection"],
                   product_type: "single_event_only", markets: nMkt, trades: nTrades, decision_points: {}, adverse_selection: {}, all_trade_maker_seller: {} };

  // ── C1 + C2 + C3: decision-point, event-clustered, maker-seller ──────────────
  console.log(`\n=== SELL cheap YES as MAKER, hold to settlement (event-clustered) ===`);
  console.log(`${"point".padStart(6)} ${"bucket".padStart(8)} ${"events".padStart(7)} ${"net c/ct".padStart(9)} ${"t".padStart(7)} ${"impliedP".padStart(9)} ${"actualP".padStart(8)}`);
  for (const d of POINTS) {
    report.decision_points[d] = {};
    for (const [lo, hi] of BUCKETS.slice(0, 3)) {          // the longshot band, split fine
      const byEvent = new Map();
      let winners = 0, tot = 0, impSum = 0;
      for (const [tk, arr] of trades) {
        const m = markets.get(tk); if (!m || arr.length < 4) continue;
        const idx = Math.min(arr.length - 1, Math.floor(d * arr.length));
        const tr = arr[idx];
        if (tr.p < lo || tr.p >= hi) continue;
        const net = tr.p - m.V;                              // C3 maker-seller, maker fee ~0
        if (!byEvent.has(m.event)) byEvent.set(m.event, []);
        byEvent.get(m.event).push(net);
        tot++; impSum += tr.p; if (m.V === 100) winners++;
      }
      if (byEvent.size < 5) continue;
      const perEvent = [...byEvent.values()].map(mean);      // C2
      const st = tstat(perEvent);
      const impliedP = tot ? impSum / tot : 0, actualP = tot ? 100 * winners / tot : 0;
      const ci = wilson(winners, tot);
      // A bucket where every market settled the same way has degenerate P&L variance -> the
      // t-stat is an artifact. Flag it and lean on the Wilson CI instead.
      const degenerate = winners === 0 || winners === tot;
      report.decision_points[d][`${lo}-${hi}`] = { events: st.n, markets: tot, net_c: +st.m.toFixed(3),
        t: +st.t.toFixed(2), t_degenerate: degenerate, implied_pct: +impliedP.toFixed(2),
        actual_pct: +actualP.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)],
        overpriced: ci[1] < impliedP };
      console.log(`${String(d).padStart(6)} ${`${lo}-${hi}c`.padStart(8)} ${String(st.n).padStart(7)} ${st.m.toFixed(3).padStart(9)} ${(degenerate ? "deg" : st.t.toFixed(2)).padStart(7)} ${impliedP.toFixed(1).padStart(8)}% ${actualP.toFixed(1).padStart(7)}% [${ci[0].toFixed(1)},${ci[1].toFixed(1)}]${ci[1] < impliedP ? " OVERPRICED" : ""}`);
    }
  }

  // ── C5: adverse selection — do TAKER-BUYS of cheap YES settle above their price? ──
  console.log(`\n=== ADVERSE SELECTION: outcome by who initiated (band 1-15c, all trades) ===`);
  for (const side of ["takerBuysYes", "takerSellsYes"]) {
    const byEvent = new Map(); let n = 0, win = 0, impSum = 0;
    for (const [tk, arr] of trades) {
      const m = markets.get(tk); if (!m) continue;
      for (const tr of arr) {
        if (tr.p < 1 || tr.p > 15) continue;
        if (side === "takerBuysYes" ? !tr.takerYes : tr.takerYes) continue;
        const net = tr.p - m.V;                               // we are the maker on the other side
        if (!byEvent.has(m.event)) byEvent.set(m.event, []);
        byEvent.get(m.event).push(net);
        n++; impSum += tr.p; if (m.V === 100) win++;
      }
    }
    if (!n) { console.log(`  ${side}: none`); continue; }
    const st = tstat([...byEvent.values()].map(mean));
    const implied = impSum / n, actual = 100 * win / n;
    report.adverse_selection[side] = { trades: n, events: st.n, maker_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), implied_pct: +implied.toFixed(2), actual_pct: +actual.toFixed(2) };
    console.log(`  ${side.padEnd(14)} trades=${String(n).padStart(6)} events=${String(st.n).padStart(4)} maker net=${st.m.toFixed(3)}c t=${st.t.toFixed(2)}  implied=${implied.toFixed(1)}% actual=${actual.toFixed(1)}%`);
  }

  // ── full curve for the FLB signature (all trades, event-clustered, BUYER side) ──
  console.log(`\n=== FLB signature: BUYER net by price bucket (event-clustered, taker fee) ===`);
  const curve = [];
  for (const [lo, hi] of BUCKETS) {
    const byEvent = new Map(); let n = 0, win = 0;
    for (const [tk, arr] of trades) {
      const m = markets.get(tk); if (!m) continue;
      for (const tr of arr) {
        if (tr.p < lo || tr.p >= hi) continue;
        const net = m.V - tr.p - feeC(tr.p);
        if (!byEvent.has(m.event)) byEvent.set(m.event, []);
        byEvent.get(m.event).push(net);
        n++; if (m.V === 100) win++;
      }
    }
    if (byEvent.size < 5) continue;
    const st = tstat([...byEvent.values()].map(mean));
    curve.push({ bucket: `${lo}-${hi}`, lo, events: st.n, trades: n, buyer_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), actual_yes_pct: +(100 * win / n).toFixed(2) });
    console.log(`  ${`${lo}-${hi}c`.padStart(8)}  events=${String(st.n).padStart(4)} trades=${String(n).padStart(6)} buyer net=${st.m.toFixed(2).padStart(8)}c  t=${st.t.toFixed(2).padStart(7)}  yes=${(100 * win / n).toFixed(1)}%`);
  }
  report.flb_curve = curve;

  // ── Sample composition + per-series maker-seller result. The pooled number is dominated by
  //    weather series; a result that only exists in one family is a family finding, not an edge.
  console.log(`\n=== COMPOSITION + per-series maker-seller (band 1-15c, taker-buys-yes only) ===`);
  const bySeries = new Map();
  for (const [tk, arr] of trades) {
    const m = markets.get(tk); if (!m) continue;
    if (!bySeries.has(m.series)) bySeries.set(m.series, { mkts: new Set(), ev: new Map(), n: 0, win: 0, imp: 0 });
    const b = bySeries.get(m.series); b.mkts.add(tk);
    for (const tr of arr) {
      if (tr.p < 1 || tr.p > 15 || !tr.takerYes) continue;
      if (!b.ev.has(m.event)) b.ev.set(m.event, []);
      b.ev.get(m.event).push(tr.p - m.V);
      b.n++; b.imp += tr.p; if (m.V === 100) b.win++;
    }
  }
  report.per_series = {};
  console.log(`${"series".padEnd(16)} ${"mkts".padStart(5)} ${"events".padStart(6)} ${"trades".padStart(7)} ${"maker net".padStart(10)} ${"t".padStart(7)} ${"implied".padStart(8)} ${"actual".padStart(7)}`);
  for (const [s, b] of [...bySeries].sort((a, c) => c[1].n - a[1].n)) {
    if (!b.n) { console.log(`${s.padEnd(16)} ${String(b.mkts.size).padStart(5)}      -       0          -       -        -       -`); continue; }
    const st = tstat([...b.ev.values()].map(mean));
    const imp = b.imp / b.n, act = 100 * b.win / b.n, ci = wilson(b.win, b.n);
    report.per_series[s] = { markets: b.mkts.size, events: st.n, trades: b.n, maker_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), implied_pct: +imp.toFixed(2), actual_pct: +act.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)] };
    console.log(`${s.padEnd(16)} ${String(b.mkts.size).padStart(5)} ${String(st.n).padStart(6)} ${String(b.n).padStart(7)} ${st.m.toFixed(3).padStart(10)} ${st.t.toFixed(2).padStart(7)} ${imp.toFixed(1).padStart(7)}% ${act.toFixed(1).padStart(6)}%`);
  }
  const fams = [...bySeries.keys()];
  const weather = fams.filter((s) => /^KXHIGH/.test(s));
  report.composition_warning = `${weather.length}/${fams.length} series are weather (KXHIGH*); pooled results are weather-dominated — treat cross-family generality as UNPROVEN until macro series have comparable n.`;
  console.log(`\n! ${report.composition_warning}`);
  const lows = curve.filter((r) => r.lo < 15), highs = curve.filter((r) => r.lo >= 85);
  report.gates = {
    F_longshots_negative_for_buyer: lows.length > 0 && lows.every((r) => r.buyer_net_c < 0),
    F_favorites_positive_for_buyer: highs.length > 0 && highs.every((r) => r.buyer_net_c > 0),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\ngates: ${JSON.stringify(report.gates)}`);
  console.log("->", OUT);
}
main();
