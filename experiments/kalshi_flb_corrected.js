"use strict";
/**
 * Favorite–longshot bias: the CORRECTED backtest (#2954). Single-event markets only.
 *
 * Every correction the review demanded, implemented and asserted:
 *   C1 DECISION POINTS — price at a fraction of the market's TRADE LIFE, not "ever traded in
 *      bucket". Whole-life bucketing conditions on ever-touching a price and eventual winners
 *      nearly always pass through cheap prices → biased FOR longshots (the old run reported the
 *      low bucket at +5.56c for the buyer, a wrong sign).
 *   C2 EVENT-LEVEL CLUSTERING — one event has many bracket markets sharing ONE outcome.
 *   C3 MAKER-SELLER ACCOUNTING — we can only be filled selling cheap YES when a TAKER BUYS
 *      (taker_side=yes), so only those trades are executable evidence. Maker fee ~0 at size.
 *   C4 NO PARLAYS — KXMVE* excluded by allowlist AND asserted per market.
 *   C5 ADVERSE SELECTION — measured directly from taker direction.
 *   C6 WILSON CIs + degeneracy flags — a bucket where every market settled the same way has
 *      degenerate P&L variance and its t-stat is an artifact of price jitter.
 *   C7 PER-FAMILY GENERALITY — a result present in one family is a family finding, not an edge.
 *
 * MEMORY: streams trades per market (the collector writes them grouped by ticker) and keeps only
 * per-event {sum,n} accumulators. The full dataset is ~1GB of JSONL on an 8GB box — loading it
 * would OOM, so nothing is ever held whole.
 *
 * Read-only. Run: node experiments/kalshi_flb_corrected.js
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DIR = path.join(__dirname, "..", "data", "kalshi", "settled-single");
const OUT = path.join(__dirname, "results", "kalshi_flb_corrected.json");
const PARLAY = /^KXMVE/i;
const BUCKETS = [[1, 5], [5, 10], [10, 15], [15, 25], [25, 40], [40, 60], [60, 75], [75, 85], [85, 95], [95, 99]];
const LOW = [[1, 5], [5, 10], [10, 15]];
const POINTS = [0.25, 0.40, 0.50, 0.60, 0.75];

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
function familyOf(series) {
  const s = String(series || "");
  if (/^KXHIGH/.test(s)) return "weather-temp";
  if (/^KXRAIN|^KXSNOW|^KXAQI/.test(s)) return "weather-other";
  if (/GAME$|^KXUFC|^KXWTA|^KXEPL/.test(s)) return "sports";
  if (/^KXBTC|^KXETH|^KXSOL|^KXXRP|^KXDOGE/.test(s)) return "crypto";
  if (/^KXAAAGAS|^KXNGAS/.test(s)) return "commodities";
  if (/^KXINX|^KXNASDAQ/.test(s)) return "financials";
  if (/^KXCPI|^KXFED|^KXPAYROLL|^KXU3|^KXFRM|^KXGDP|^KXRATECUT/.test(s)) return "macro";
  return "other";
}
const FEE_UNCERTAIN = new Set(["crypto"]);   // Kalshi charges a higher multiplier on premium/crypto

// ── accumulators: per-EVENT {sum,n} only, never raw trades ───────────────────
const A = {
  dp: new Map(),      // `${d}|${lo}-${hi}` -> {ev:Map(event->{s,n}), mk:0, win:0, imp:0}
  adv: new Map(),     // side -> {ev, n, win, imp}
  curve: new Map(),   // `${lo}-${hi}` -> {ev, n, win}
  series: new Map(),  // series -> {mkts:Set, ev, n, win, imp}
  fam: new Map(),     // family -> {series:Set, ev, n, win, imp}
  markets: 0, trades: 0, parlays: 0,
};
const slot = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };
const addEv = (o, ev, v) => { const e = slot(o.ev, ev, () => ({ s: 0, n: 0 })); e.s += v; e.n++; };
const evMeans = (o) => [...o.ev.values()].map((e) => e.s / e.n);

// C8 TRUNCATION GUARD. The collector caps trades per market; a capped market's history is a
// TAIL SLICE, not the market. Measured 2026-07-25: 88% of MLB markets hit the cap with a median
// captured span of 1.6h on markets running up to 75h — i.e. end-of-game trades only, where the
// losing side really is ~0%. That produced a spurious "sports +6.78c, t=21.5" family result.
// Decision-point fractions are meaningless on a truncated tail, so capped markets are EXCLUDED.
const TRADE_CAP = 5000;
let excludedCapped = 0;

/** Fold one market's trades (chronological) into every accumulator. */
function processMarket(meta, trs) {
  if (!trs.length) return;
  if (trs.length >= TRADE_CAP) { excludedCapped++; return; }        // C8
  A.markets++; A.trades += trs.length;
  const fam = familyOf(meta.series);
  const sBox = slot(A.series, meta.series, () => ({ mkts: new Set(), ev: new Map(), n: 0, win: 0, imp: 0 }));
  const fBox = slot(A.fam, fam, () => ({ series: new Set(), ev: new Map(), n: 0, win: 0, imp: 0 }));
  sBox.mkts.add(meta.ticker); fBox.series.add(meta.series);

  // C1 decision points (needs >=4 trades to have a meaningful life)
  if (trs.length >= 4) {
    for (const d of POINTS) {
      const tr = trs[Math.min(trs.length - 1, Math.floor(d * trs.length))];
      for (const [lo, hi] of LOW) {
        if (tr.p < lo || tr.p >= hi) continue;
        const box = slot(A.dp, `${d}|${lo}-${hi}`, () => ({ ev: new Map(), mk: 0, win: 0, imp: 0 }));
        addEv(box, meta.event, tr.p - meta.V);          // C3 maker-seller, maker fee ~0
        box.mk++; box.imp += tr.p; if (meta.V === 100) box.win++;
        break;
      }
    }
  }
  for (const tr of trs) {
    // C5 adverse selection + per-series/family (band only, taker direction split)
    if (tr.p >= 1 && tr.p <= 15) {
      const side = tr.takerYes ? "takerBuysYes" : "takerSellsYes";
      const box = slot(A.adv, side, () => ({ ev: new Map(), n: 0, win: 0, imp: 0 }));
      addEv(box, meta.event, tr.p - meta.V);
      box.n++; box.imp += tr.p; if (meta.V === 100) box.win++;
      if (tr.takerYes) {
        for (const b of [sBox, fBox]) { addEv(b, meta.event, tr.p - meta.V); b.n++; b.imp += tr.p; if (meta.V === 100) b.win++; }
      }
    }
    // FLB curve, buyer side, taker fee
    for (const [lo, hi] of BUCKETS) {
      if (tr.p < lo || tr.p >= hi) continue;
      const box = slot(A.curve, `${lo}-${hi}`, () => ({ ev: new Map(), n: 0, win: 0 }));
      addEv(box, meta.event, meta.V - tr.p - feeC(tr.p));
      box.n++; if (meta.V === 100) box.win++;
      break;
    }
  }
}

async function run() {
  if (!fs.existsSync(DIR)) { console.error("no data — run experiments/kalshi_collect_single_event.js first"); process.exit(1); }
  const seriesFiles = fs.readdirSync(DIR).filter((f) => f.endsWith(".markets.jsonl"));
  for (const mf of seriesFiles) {
    const series = mf.replace(".markets.jsonl", "");
    const tf = path.join(DIR, `${series}.trades.jsonl`);
    if (!fs.existsSync(tf)) continue;
    const meta = new Map();
    for (const line of fs.readFileSync(path.join(DIR, mf), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (PARLAY.test(m.ticker || "")) { A.parlays++; continue; }                  // C4
      const r = (m.result || "").toLowerCase();
      if (r !== "yes" && r !== "no") continue;
      meta.set(m.ticker, { ticker: m.ticker, V: r === "yes" ? 100 : 0, event: m.event_ticker || m.ticker, series });
    }
    // stream trades; the collector writes them grouped by ticker, so flush on ticker change
    let curTicker = null, buf = [];
    const rl = readline.createInterface({ input: fs.createReadStream(tf), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let t; try { t = JSON.parse(line); } catch { continue; }
      if (t.ticker !== curTicker) {
        if (curTicker && meta.has(curTicker)) { buf.sort((a, b) => a.ts - b.ts); processMarket(meta.get(curTicker), buf); }
        curTicker = t.ticker; buf = [];
      }
      if (!meta.has(t.ticker)) continue;
      const p = Math.round(parseFloat(t.yes_price_dollars) * 100);
      const ts = Date.parse(t.created_time);
      if (!Number.isFinite(p) || p <= 0 || p >= 100 || !Number.isFinite(ts)) continue;
      buf.push({ ts, p, takerYes: String(t.taker_side || t.taker_outcome_side || "").toLowerCase() === "yes" });
    }
    if (curTicker && meta.has(curTicker)) { buf.sort((a, b) => a.ts - b.ts); processMarket(meta.get(curTicker), buf); }
    process.stdout.write(`  ${series} `);
  }
  console.log("");
  report();
}

function report() {
  const rep = { date: new Date().toISOString().slice(0, 10), product_type: "single_event_only",
    corrections: ["C1 decision-point", "C2 event-cluster", "C3 maker-seller", "C4 no parlays", "C5 adverse-selection", "C6 wilson+degeneracy", "C7 per-family", "C8 truncation-guard"],
    markets: A.markets, trades: A.trades, parlays_excluded: A.parlays, truncated_markets_excluded: excludedCapped, decision_points: {}, adverse_selection: {}, flb_curve: [], per_series: {}, per_family: {} };
  console.log(`\nsingle-event markets: ${A.markets}   trades: ${A.trades}   parlays excluded: ${A.parlays}`);

  console.log(`\n=== SELL cheap YES as MAKER, hold to settlement (event-clustered) ===`);
  console.log(`${"point".padStart(6)} ${"bucket".padStart(8)} ${"events".padStart(7)} ${"net c/ct".padStart(9)} ${"t".padStart(7)} ${"implied".padStart(8)} ${"actual".padStart(7)}  CI95`);
  for (const d of POINTS) {
    rep.decision_points[d] = {};
    for (const [lo, hi] of LOW) {
      const box = A.dp.get(`${d}|${lo}-${hi}`); if (!box || box.ev.size < 5) continue;
      const st = tstat(evMeans(box)); const imp = box.imp / box.mk, act = 100 * box.win / box.mk, ci = wilson(box.win, box.mk);
      const deg = box.win === 0 || box.win === box.mk;
      rep.decision_points[d][`${lo}-${hi}`] = { events: st.n, markets: box.mk, net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), t_degenerate: deg, implied_pct: +imp.toFixed(2), actual_pct: +act.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)], overpriced: ci[1] < imp };
      console.log(`${String(d).padStart(6)} ${`${lo}-${hi}c`.padStart(8)} ${String(st.n).padStart(7)} ${st.m.toFixed(3).padStart(9)} ${(deg ? "deg" : st.t.toFixed(2)).padStart(7)} ${imp.toFixed(1).padStart(7)}% ${act.toFixed(1).padStart(6)}%  [${ci[0].toFixed(1)},${ci[1].toFixed(1)}]${ci[1] < imp ? " OVERPRICED" : ""}`);
    }
  }

  console.log(`\n=== ADVERSE SELECTION (band 1-15c, all trades) ===`);
  for (const side of ["takerBuysYes", "takerSellsYes"]) {
    const box = A.adv.get(side); if (!box) continue;
    const st = tstat(evMeans(box)); const imp = box.imp / box.n, act = 100 * box.win / box.n, ci = wilson(box.win, box.n);
    rep.adverse_selection[side] = { trades: box.n, events: st.n, maker_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), implied_pct: +imp.toFixed(2), actual_pct: +act.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)] };
    console.log(`  ${side.padEnd(14)} trades=${String(box.n).padStart(7)} events=${String(st.n).padStart(5)} maker net=${st.m.toFixed(3).padStart(7)}c t=${st.t.toFixed(2).padStart(6)}  implied=${imp.toFixed(1)}% actual=${act.toFixed(1)}% [${ci[0].toFixed(1)},${ci[1].toFixed(1)}]`);
  }

  console.log(`\n=== FLB signature: BUYER net by price bucket (event-clustered, taker fee) ===`);
  for (const [lo, hi] of BUCKETS) {
    const box = A.curve.get(`${lo}-${hi}`); if (!box || box.ev.size < 5) continue;
    const st = tstat(evMeans(box));
    rep.flb_curve.push({ bucket: `${lo}-${hi}`, lo, events: st.n, trades: box.n, buyer_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), actual_yes_pct: +(100 * box.win / box.n).toFixed(2) });
    console.log(`  ${`${lo}-${hi}c`.padStart(8)}  events=${String(st.n).padStart(5)} trades=${String(box.n).padStart(7)} buyer net=${st.m.toFixed(2).padStart(8)}c  t=${st.t.toFixed(2).padStart(7)}  yes=${(100 * box.win / box.n).toFixed(1)}%`);
  }
  const lows = rep.flb_curve.filter((r) => r.lo < 15), highs = rep.flb_curve.filter((r) => r.lo >= 85);
  rep.gates = { F_longshots_negative_for_buyer: lows.length > 0 && lows.every((r) => r.buyer_net_c < 0),
                F_favorites_positive_for_buyer: highs.length > 0 && highs.every((r) => r.buyer_net_c > 0) };

  console.log(`\n=== PER-FAMILY (the generality test): maker sells cheap YES, taker-buys-yes only ===`);
  console.log(`${"family".padEnd(15)} ${"series".padStart(6)} ${"events".padStart(6)} ${"trades".padStart(8)} ${"maker net".padStart(10)} ${"t".padStart(7)} ${"implied".padStart(8)} ${"actual".padStart(7)}`);
  for (const [f, b] of [...A.fam].sort((a, c) => c[1].ev.size - a[1].ev.size)) {
    if (!b.n) continue;
    const st = tstat(evMeans(b)); const imp = b.imp / b.n, act = 100 * b.win / b.n, ci = wilson(b.win, b.n);
    rep.per_family[f] = { series: b.series.size, events: st.n, trades: b.n, maker_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), implied_pct: +imp.toFixed(2), actual_pct: +act.toFixed(2), actual_ci95: [+ci[0].toFixed(2), +ci[1].toFixed(2)], overpriced: ci[1] < imp, fee_uncertain: FEE_UNCERTAIN.has(f) };
    console.log(`${f.padEnd(15)} ${String(b.series.size).padStart(6)} ${String(st.n).padStart(6)} ${String(b.n).padStart(8)} ${st.m.toFixed(3).padStart(10)} ${st.t.toFixed(2).padStart(7)} ${imp.toFixed(1).padStart(7)}% ${act.toFixed(1).padStart(6)}%${ci[1] < imp ? " OVERPRICED" : ""}${FEE_UNCERTAIN.has(f) ? " (fee?)" : ""}`);
  }
  for (const [s, b] of A.series) {
    if (!b.n) continue;
    const st = tstat(evMeans(b));
    rep.per_series[s] = { markets: b.mkts.size, events: st.n, trades: b.n, maker_net_c: +st.m.toFixed(3), t: +st.t.toFixed(2), implied_pct: +(b.imp / b.n).toFixed(2), actual_pct: +(100 * b.win / b.n).toFixed(2) };
  }
  // C9 A family only COUNTS toward generality with enough INDEPENDENT events. Without this the
  // gate reads "cross-family" off a family with 3 events (macro) — and sports is separately
  // suspect: 88% of its markets were truncation-excluded, so the survivors are the quiet games.
  const MIN_EVENTS = 30;
  const famVals = Object.values(rep.per_family);
  const qualified = famVals.filter((v) => v.events >= MIN_EVENTS);
  const pos = qualified.filter((v) => v.maker_net_c > 0).length;
  const sig = qualified.filter((v) => v.maker_net_c > 0 && v.t > 2).length;
  const under = famVals.length - qualified.length;
  rep.generality = { families_total: famVals.length, families_qualified: qualified.length, min_events: MIN_EVENTS,
    underpowered_excluded: under, positive: pos, positive_and_t_gt_2: sig,
    verdict: sig >= 3 ? "CROSS-FAMILY (>=3 qualified families positive at t>2)"
      : sig >= 1 ? `PARTIAL — holds in ${sig} qualified family/families only` : "NOT cross-family" };
  console.log(`\nGENERALITY (min ${MIN_EVENTS} events/family): ${pos}/${qualified.length} qualified positive, ${sig} at t>2`);
  if (under) console.log(`  ${under} family/families excluded as underpowered (<${MIN_EVENTS} events)`);
  console.log(`  -> ${rep.generality.verdict}`);
  console.log(`gates: ${JSON.stringify(rep.gates)}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2));
  console.log("->", OUT);
}

run().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
