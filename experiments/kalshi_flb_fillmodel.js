"use strict";
/**
 * Fade-the-longshot with a REAL FILL MODEL (#2954) — the last unaddressed caveat.
 *
 * Every prior version of this backtest counted trades that happened and ASSUMED we could have been
 * the resting maker on them. That is the single most common way a paper edge dies in production:
 * the fills you needed were never available to you. This version never assumes a fill.
 *
 * THE SIMULATION (1-minute yes_bid/yes_ask history, free public candlesticks endpoint):
 *   1. At a decision minute, if the market's yes_ask sits in the longshot band, post a resting
 *      offer to SELL 1 YES at that price P (equivalently buy NO at 100-P). We are the maker.
 *   2. The order fills ONLY if, in some LATER minute before close, a buyer was willing to pay P —
 *      i.e. that minute's yes_bid HIGH >= P. No buyer at our price, no fill, no position, no P&L.
 *      (`--strict` requires yes_bid HIGH > P, i.e. a genuine cross rather than a touch.)
 *   3. Filled positions are held to settlement. Maker economics: Kalshi maker fee ~0 at this size;
 *      ForecastEx charges a flat 1c/contract embedded in the spread. Both are reported.
 *   4. Unfilled offers are counted and reported — a strategy that only fills 5% of the time is a
 *      different business from one that fills 80%, even at identical per-fill edge.
 *
 * HONESTY LIMITS this still cannot cross: queue priority (we assume our 1 lot is served when the
 * bid reaches our price), partial fills, and the market-impact of our own resting size. All three
 * make real fills WORSE than simulated, never better — so this is an upper bound.
 *
 * Read-only. Run: node experiments/kalshi_flb_fillmodel.js [--strict] [--band 1,15]
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DIR = path.join(__dirname, "..", "data", "kalshi", "candles-1m");
const OUT = path.join(__dirname, "results", "kalshi_flb_fillmodel.json");
const POINTS = [0.25, 0.40, 0.50, 0.60, 0.75];
const FEE_KALSHI_MAKER = 0;      // ~0 at 1-lot after rounding (2026-07 schedule)
const FEE_FORECASTEX = 1;        // flat 1c/contract, embedded in the spread

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
  const strict = process.argv.includes("--strict");
  const bIdx = process.argv.indexOf("--band");
  const [LO, HI] = bIdx > 0 && process.argv[bIdx + 1] ? process.argv[bIdx + 1].split(",").map(Number) : [1, 15];
  if (!fs.existsSync(DIR)) { console.error("no candles — run experiments/kalshi_collect_candles.js first"); process.exit(1); }

  const perPoint = new Map();   // d -> {offers, fills, wins, evFill:Map(event->[net]), sumP}
  let markets = 0, thin = 0;

  for (const fn of fs.readdirSync(DIR).filter((f) => f.endsWith(".candles.jsonl"))) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, fn)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const cs = m.candles || [];
      if (cs.length < 10) continue;
      markets++;
      if ((m.quote_coverage || 0) < 0.05) thin++;
      const V = m.result === "yes" ? 100 : 0;
      for (const d of POINTS) {
        const i = Math.min(cs.length - 1, Math.floor(d * cs.length));
        const P = cs[i].ac;                                  // the ask we would join/undercut
        if (!Number.isFinite(P) || P < LO || P > HI) continue;
        const box = perPoint.get(d) || { offers: 0, fills: 0, wins: 0, ev: new Map(), sumP: 0, waitSum: 0 };
        box.offers++;
        // fill test: did any LATER minute show a buyer at our price?
        let filled = -1;
        for (let k = i + 1; k < cs.length; k++) {
          const bh = cs[k].bh;
          if (!Number.isFinite(bh)) continue;
          if (strict ? bh > P : bh >= P) { filled = k; break; }
        }
        if (filled >= 0) {
          box.fills++; box.sumP += P; box.waitSum += (filled - i);
          if (V === 100) box.wins++;
          const net = P - V;                                  // maker sells YES at P, pays V
          const arr = box.ev.get(m.event) || [];
          arr.push(net); box.ev.set(m.event, arr);
        }
        perPoint.set(d, box);
      }
    }
  }

  const rep = { date: new Date().toISOString().slice(0, 10), band: [LO, HI], fill_rule: strict ? "bid_high > P (cross)" : "bid_high >= P (touch)",
    markets, thin_markets: thin, points: {},
    limits: ["queue priority ignored (our lot assumed served)", "partial fills ignored", "own market impact ignored", "=> simulated fills are an UPPER bound"] };

  console.log(`markets=${markets}  thin(<5% quoted)=${thin}  band=${LO}-${HI}c  rule=${rep.fill_rule}\n`);
  console.log(`${"point".padStart(6)} ${"offers".padStart(7)} ${"fills".padStart(6)} ${"fill%".padStart(6)} ${"avgP".padStart(6)} ${"medWait".padStart(8)} ${"net/fill".padStart(9)} ${"t".padStart(7)} ${"actual%".padStart(8)} ${"net/offer".padStart(10)}`);
  for (const d of POINTS) {
    const b = perPoint.get(d); if (!b || !b.offers) continue;
    const st = tstat([...b.ev.values()].map(mean));
    const fillPct = 100 * b.fills / b.offers;
    const avgP = b.fills ? b.sumP / b.fills : 0;
    const actual = b.fills ? 100 * b.wins / b.fills : 0;
    const ci = wilson(b.wins, b.fills);
    const netPerOffer = b.fills ? st.m * (b.fills / b.offers) : 0;   // capital sits idle when unfilled
    const medWait = b.fills ? Math.round(b.waitSum / b.fills) : 0;
    rep.points[d] = { offers: b.offers, fills: b.fills, fill_pct: +fillPct.toFixed(1), avg_fill_price: +avgP.toFixed(2),
      mean_wait_minutes: medWait, events: st.n, net_c_per_fill: +st.m.toFixed(3), t: +st.t.toFixed(2),
      actual_yes_pct: +actual.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)],
      net_c_per_offer: +netPerOffer.toFixed(3),
      net_c_per_fill_forecastex: +(st.m - FEE_FORECASTEX).toFixed(3) };
    console.log(`${String(d).padStart(6)} ${String(b.offers).padStart(7)} ${String(b.fills).padStart(6)} ${fillPct.toFixed(1).padStart(5)}% ${avgP.toFixed(1).padStart(6)} ${String(medWait).padStart(7)}m ${st.m.toFixed(3).padStart(9)} ${st.t.toFixed(2).padStart(7)} ${actual.toFixed(1).padStart(7)}% ${netPerOffer.toFixed(3).padStart(10)}`);
  }
  // A point only counts if its statistic is NOT degenerate. With 0 winners the P&L variance
  // collapses and t explodes on price jitter alone (the same artifact as C6). With ~29 fills a
  // true 6% rate predicts ~1.7 winners, so observing 0 is unremarkable — not significance.
  const any = Object.values(rep.points);
  for (const p of any) p.degenerate = p.actual_yes_pct === 0 || p.actual_yes_pct === 100;
  const survivors = any.filter((p) => p.net_c_per_fill > 0 && p.t > 2 && p.fill_pct >= 20 && !p.degenerate);
  const lateOnly = survivors.length > 0 && survivors.every((p) => Number(Object.keys(rep.points).find((k) => rep.points[k] === p)) >= 0.7);
  rep.degenerate_points = any.filter((p) => p.degenerate).length;
  rep.verdict = !any.length ? "NO OFFERS — band never quoted"
    : any.every((p) => p.fill_pct < 20) ? "FILL-STARVED — per-fill edge is moot; offers rarely execute"
    : survivors.length === 0 ? "DOES NOT SURVIVE fill simulation (surviving points are degenerate: 0 winners => t is an artifact)"
    : lateOnly ? "FRAGILE — survives only at the LATEST decision point, the same pattern that disqualified buy-favourites"
    : `SURVIVES fill simulation at ${survivors.length} non-degenerate decision point(s)`;
  console.log(`\nVERDICT: ${rep.verdict}`);
  console.log(`(net/offer folds in unfilled attempts; ForecastEx column subtracts its flat 1c)`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log("->", OUT);
})();
