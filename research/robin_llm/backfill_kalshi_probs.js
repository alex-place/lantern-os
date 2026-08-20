"use strict";
// Backfill market-implied probabilities for the resolved-Kalshi benchmark parquet.
//
// WHY. The benchmark (1,531 resolved Kalshi questions, 894 series) ships with ground_truth but
// market_probability null on every row -- which supports calibration-vs-outcome evals (already
// published as KalshiBench) and NOT the one idea from the mill that keeps surviving review:
// market-implied uncertainty as supervision for internal confidence signals. That needs prices.
//
// WHERE THE PRICES LIVE, found the hard way: Kalshi partitions old data behind /historical/
// routes (docs.kalshi.com/getting_started/historical_data). Settled markets return ZERO from
// every live listing -- public or authed, by series, event, or close-ts window -- and the
// per-ticker candlesticks 404 for old markets. GET /trade-api/v2/historical/markets is the one
// path that works, and its rows carry last_price_dollars, yes_bid/ask_dollars,
// previous_price_dollars, result, close_time. No auth needed. So per row we can recover:
//   market_probability  = last traded YES price at close, in [0,1]
//   spread              = yes_ask - yes_bid at close (the market's own disagreement measure)
//
// MATCHING. The parquet has only series tickers; a series holds many markets (one per candidate/
// side). A row is matched to a market by EXACT close_time; fallback, nearest within 3s with
// result agreeing with ground_truth. Unmatched rows are written with match:"none" -- absence
// recorded, never imputed.
//
// Read-only market data throughout: no auth, no orders, no account endpoints. Polite (~350ms
// between calls), resumable (per-series cache on disk), ~6 minutes for 894 series.
//
// Run:  node research/robin_llm/backfill_kalshi_probs.js [--rows FILE] [--out FILE]

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROWS = argv("rows", "D:/tmp/claude/kalshi_rows.jsonl");
const OUT = argv("out", path.join(__dirname, "..", "..", "data", "kalshi", "settled", "benchmark-backfill.jsonl"));
const CACHE_DIR = path.join(__dirname, "results", ".kalshi-hist-cache");
const GAP_MS = 350;

function argv(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "lantern-research/1.0 (mailto:founder@lantern-os.net)" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: -1, body: String(e.message) }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ status: -2, body: "timeout" }); });
  });
}

async function seriesMarkets(series) {
  const cacheFile = path.join(CACHE_DIR, `${series}.json`);
  if (fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* refetch */ }
  }
  const all = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    await sleep(GAP_MS);
    const url = `https://api.elections.kalshi.com/trade-api/v2/historical/markets?series_ticker=${encodeURIComponent(series)}`
              + `&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await get(url);
    if (r.status !== 200) return { error: `${r.status}`, markets: all };
    let j;
    try { j = JSON.parse(r.body); } catch { return { error: "parse", markets: all }; }
    for (const m of j.markets || []) {
      all.push({
        ticker: m.ticker, result: m.result, close_time: m.close_time,
        last: num(m.last_price_dollars), bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars),
        prev: num(m.previous_price_dollars), title: m.yes_sub_title || m.subtitle || "",
      });
    }
    cursor = j.cursor || "";
    if (!cursor || !(j.markets || []).length) break;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ markets: all }));
  return { markets: all };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function match(row, markets) {
  const t = new Date(row.close).getTime();
  let exact = markets.find((m) => new Date(m.close_time).getTime() === t);
  if (exact) return { m: exact, how: "exact_close_time" };
  let best = null, bestD = Infinity;
  for (const m of markets) {
    const d = Math.abs(new Date(m.close_time).getTime() - t);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (best && bestD <= 3000 && String(best.result) === String(row.gt)) {
    return { m: best, how: `near_${bestD}ms_result_agrees` };
  }
  return { m: null, how: "none" };
}

async function main() {
  const rows = fs.readFileSync(ROWS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series)) bySeries.set(r.series, []);
    bySeries.get(r.series).push(r);
  }
  console.log(`${rows.length} rows across ${bySeries.size} series -> ${OUT}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = fs.createWriteStream(OUT);
  let done = 0, matched = 0, disagree = 0, apiErr = 0;
  for (const [series, srows] of bySeries) {
    const res = await seriesMarkets(series);
    if (res.error) apiErr++;
    for (const row of srows) {
      const { m, how } = match(row, res.markets || []);
      const rec = {
        row: row.row, series, question: row.question, ground_truth: row.gt, close_time: row.close,
        match: how, ticker: m ? m.ticker : null,
        market_probability: m ? m.last : null,
        yes_bid: m ? m.bid : null, yes_ask: m ? m.ask : null,
        spread: m && m.bid !== null && m.ask !== null ? Number((m.ask - m.bid).toFixed(4)) : null,
        result: m ? m.result : null,
        result_agrees: m ? String(m.result) === String(row.gt) : null,
      };
      if (m) { matched++; if (rec.result_agrees === false) disagree++; }
      out.write(JSON.stringify(rec) + "\n");
    }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${bySeries.size} series; matched ${matched}, result-disagrees ${disagree}, api errors ${apiErr}`);
  }
  out.end();
  console.log(`\nDONE: ${matched}/${rows.length} rows matched; ${disagree} matched rows where result != ground_truth `
    + `(those are label problems in the BENCHMARK, worth listing); ${apiErr} series with API errors.`);
  console.log(`-> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
