"use strict";
/**
 * BUY-FAVOURITES as a TAKER — the retail-accessible side of the favourite–longshot bias (#2954).
 *
 * WHY THIS AND NOT THE LONGSHOT FADE. The academic synthesis of prediction-market edges
 * (QuantPedia, over ~20 studies) concludes that of the documented systematic edges — inter-exchange
 * arbitrage, intra-exchange arbitrage, longshot bias — only **longshot bias** is genuinely
 * accessible to a retail trader: no latency advantage, no multi-venue infrastructure. And the
 * tradeable expression of it is BUYING FAVOURITES, not selling longshots.
 *
 * That distinction is decisive here, because the two sides differ in the thing that actually
 * killed our last candidate:
 *   - Selling longshots = posting a resting offer = MAKER = you only trade if someone lifts you.
 *     Measured: ~50% of offers never filled, and the only profitable decision point was degenerate.
 *   - Buying favourites = crossing the spread = TAKER = you fill immediately, always, at the ask.
 *     Fill risk is structurally absent. You pay the taker fee for that certainty.
 *
 * Our own corrected backtest independently found the favourite side positive (75–85c bucket:
 * +5.10c/contract net of taker fee, t=2.58) — it was measured and then not pursued.
 *
 * METHOD: at each decision point in a market's quote history, if the yes_ask sits in the favourite
 * band, BUY at that ask (immediate fill, taker fee charged), hold to settlement.
 *   net = V - ask - fee(ask),   fee = 0.07 * P * (100-P) / 100 cents
 * Event-clustered (bracket markets in one event share one outcome). Wilson CIs; degenerate buckets
 * flagged. Reports every decision point so "works only at the latest point" cannot hide.
 *
 * Read-only. Run: node experiments/kalshi_favorites_taker.js [--band 75,85]
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DIR = path.join(__dirname, "..", "data", "kalshi", "candles-1m");
const OUT = path.join(__dirname, "results", "kalshi_favorites_taker.json");
const POINTS = [0.10, 0.25, 0.40, 0.50, 0.60, 0.75, 0.90];
const BANDS = [[60, 75], [75, 85], [85, 95], [95, 99]];

const feeC = (p) => 0.07 * p * (100 - p) / 100;
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function tstat(a) {
  const n = a.length; if (n < 2) return { n, m: mean(a), t: 0 };
  const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0 };
}
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, 100 * (c - h)), Math.min(100, 100 * (c + h))];
}

(async () => {
  const bIdx = process.argv.indexOf("--band");
  const only = bIdx > 0 && process.argv[bIdx + 1] ? process.argv[bIdx + 1].split(",").map(Number) : null;
  const bands = only ? [only] : BANDS;
  if (!fs.existsSync(DIR)) { console.error("no candles — run experiments/kalshi_collect_candles.js first"); process.exit(1); }

  const cell = new Map();   // `${d}|${lo}-${hi}` -> {n, wins, sumAsk, ev:Map}
  let markets = 0;
  for (const fn of fs.readdirSync(DIR).filter((f) => f.endsWith(".candles.jsonl"))) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, fn)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const cs = (m.candles || []).filter((c) => Number.isFinite(c.ac) && c.ac > 0);
      if (cs.length < 10) continue;
      markets++;
      const V = m.result === "yes" ? 100 : 0;
      for (const d of POINTS) {
        const ask = cs[Math.min(cs.length - 1, Math.floor(d * cs.length))].ac;
        for (const [lo, hi] of bands) {
          if (ask < lo || ask >= hi) continue;
          const k = `${d}|${lo}-${hi}`;
          const b = cell.get(k) || { n: 0, wins: 0, sumAsk: 0, ev: new Map() };
          const net = V - ask - feeC(ask);                       // taker: immediate fill at the ask
          b.n++; b.sumAsk += ask; if (V === 100) b.wins++;
          const arr = b.ev.get(m.event) || []; arr.push(net); b.ev.set(m.event, arr);
          cell.set(k, b);
          break;
        }
      }
    }
  }

  const rep = { date: new Date().toISOString().slice(0, 10), strategy: "buy favourites at the ask (taker, immediate fill), hold to settlement",
    markets, execution: "TAKER — fills structurally certain; taker fee 0.07*P*(1-P) charged", cells: {} };
  console.log(`markets=${markets}   strategy: BUY favourites at ask (taker), hold to settlement\n`);
  console.log(`${"point".padStart(6)} ${"band".padStart(8)} ${"trades".padStart(7)} ${"events".padStart(7)} ${"avgAsk".padStart(7)} ${"net/ct".padStart(8)} ${"t".padStart(7)} ${"implied".padStart(8)} ${"actual".padStart(7)}  CI95`);
  for (const d of POINTS) {
    for (const [lo, hi] of bands) {
      const b = cell.get(`${d}|${lo}-${hi}`); if (!b || b.ev.size < 5) continue;
      const st = tstat([...b.ev.values()].map(mean));
      const avgAsk = b.sumAsk / b.n, actual = 100 * b.wins / b.n, ci = wilson(b.wins, b.n);
      const deg = b.wins === 0 || b.wins === b.n;
      rep.cells[`${d}|${lo}-${hi}`] = { trades: b.n, events: st.n, avg_ask: +avgAsk.toFixed(2), net_c: +st.m.toFixed(3),
        t: +st.t.toFixed(2), degenerate: deg, implied_pct: +avgAsk.toFixed(2), actual_pct: +actual.toFixed(2),
        actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)], underpriced: ci[0] > avgAsk };
      console.log(`${String(d).padStart(6)} ${`${lo}-${hi}c`.padStart(8)} ${String(b.n).padStart(7)} ${String(st.n).padStart(7)} ${avgAsk.toFixed(1).padStart(7)} ${st.m.toFixed(3).padStart(8)} ${(deg ? "deg" : st.t.toFixed(2)).padStart(7)} ${avgAsk.toFixed(1).padStart(7)}% ${actual.toFixed(1).padStart(6)}%  [${ci[0].toFixed(1)},${ci[1].toFixed(1)}]${ci[0] > avgAsk ? " UNDERPRICED" : ""}`);
    }
  }
  const cells = Object.entries(rep.cells);
  const good = cells.filter(([, v]) => v.net_c > 0 && v.t > 2 && !v.degenerate);
  const pts = new Set(good.map(([k]) => k.split("|")[0]));
  rep.summary = { cells: cells.length, positive_significant: good.length, distinct_decision_points: pts.size,
    verdict: good.length === 0 ? "NO EDGE — no non-degenerate cell is positive at t>2"
      : pts.size === 1 ? "FRAGILE — significant at only ONE decision point (the pattern that disqualified prior candidates)"
      : `ROBUST across ${pts.size} decision points — ${good.length} significant cells` };
  console.log(`\n${rep.summary.verdict}`);
  if (good.length) console.log(`  significant cells: ${good.map(([k, v]) => `${k} ${v.net_c > 0 ? "+" : ""}${v.net_c}c(t=${v.t})`).join("  ")}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log("->", OUT);
})();
