"use strict";
/**
 * Kalshi 1-minute quote-history collector — the free/OSS path to fill-realistic backtests (#2954).
 *
 * WHY: Kalshi's public API does NOT serve historical order-book depth; commercial vendors solve
 * that by continuously polling and persisting it. But the public `candlesticks` endpoint DOES
 * serve per-minute **yes_bid and yes_ask OHLC** plus volume and open interest — which is enough
 * to simulate a resting maker order honestly instead of assuming it filled. That assumption was
 * the largest unaddressed caveat in the corrected FLB backtest; this removes it using free data.
 *
 * FILL SEMANTICS this data supports (see kalshi_flb_fillmodel.js):
 *   a resting ASK at price P fills when some later minute's yes_bid HIGH reaches P — i.e. a buyer
 *   was willing to pay P and would have lifted the offer. Conservative variant: strictly exceeds P.
 *
 * BEST PRACTICES ENCODED
 *   - Resumable: an existing complete output file is skipped, so a killed run costs nothing.
 *   - Rate-limit aware: 429 -> exponential backoff, and a steady inter-request delay.
 *   - Completeness tracked per market (candles vs expected minutes) and written to a MANIFEST,
 *     because a silently-truncated sample fabricated an edge here once already (2026-07-25).
 *   - Compact rows (~11 numbers/minute), so the whole thing stays small enough to re-analyse.
 *   - Read-only. No orders, no auth needed — this is public market data.
 *
 * Run: node experiments/kalshi_collect_candles.js [--series A,B] [--max-markets 300]
 */
const fs = require("fs");
const path = require("path");

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SRC = path.join(__dirname, "..", "data", "kalshi", "settled-single");
const OUT = path.join(__dirname, "..", "data", "kalshi", "candles-1m");
const PARLAY = /^KXMVE/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c2 = (d) => { const n = parseFloat(d); return Number.isFinite(n) ? Math.round(n * 100) : null; };

async function api(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "unisona-candle-collector" } });
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(500 * (i + 1)); }
  }
  return null;
}

/** One market's minute candles, compacted. Returns {rows, expected, complete}. */
async function candlesFor(series, m) {
  const st = Math.floor(Date.parse(m.open_time || m.created_time) / 1000);
  const et = Math.floor(Date.parse(m.close_time) / 1000);
  if (!Number.isFinite(st) || !Number.isFinite(et) || et <= st) return null;
  const expected = Math.floor((et - st) / 60);
  const rows = [];
  // The endpoint caps a response; walk the window in chunks so long markets are not truncated.
  const CHUNK = 5000 * 60;   // 5000 minutes per request window
  for (let a = st; a < et; a += CHUNK) {
    const b = Math.min(a + CHUNK, et);
    const j = await api(`${BASE}/series/${series}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${a}&end_ts=${b}&period_interval=1`);
    if (!j) continue;
    for (const c of (j.candlesticks || [])) {
      const bid = c.yes_bid || {}, ask = c.yes_ask || {}, pr = c.price || {};
      rows.push({
        t: c.end_period_ts,
        bo: c2(bid.open_dollars), bh: c2(bid.high_dollars), bl: c2(bid.low_dollars), bc: c2(bid.close_dollars),
        ao: c2(ask.open_dollars), ah: c2(ask.high_dollars), al: c2(ask.low_dollars), ac: c2(ask.close_dollars),
        pc: c2(pr.close_dollars),
        v: Math.round(parseFloat(c.volume_fp || 0) || 0),
        oi: Math.round(parseFloat(c.open_interest_fp || 0) || 0),
      });
    }
    await sleep(90);
  }
  rows.sort((x, y) => x.t - y.t);
  // Completeness is about TRADEABLE moments, not wall-clock minutes. Measured 2026-07-25: the
  // endpoint is sparse by design (quiet minutes are omitted, not truncated — verified by chunked
  // vs single request returning the same count), and on a deep-OTM strike only ~5% of minutes
  // carry a live bid at all. A resting offer cannot fill in a minute with no bid, so quote
  // coverage is the number that decides whether a maker strategy is even executable.
  const quoted = rows.filter((r) => r.bc > 0).length;
  return { rows, expected, quoted, quote_coverage: expected ? quoted / expected : 0,
           complete: rows.length > 0 };
}

(async () => {
  const argv = process.argv;
  const sIdx = argv.indexOf("--series");
  const mIdx = argv.indexOf("--max-markets");
  const maxMarkets = mIdx > 0 ? parseInt(argv[mIdx + 1], 10) || 300 : 300;
  let seriesList = sIdx > 0 && argv[sIdx + 1] ? argv[sIdx + 1].split(",").map((s) => s.trim())
    : fs.readdirSync(SRC).filter((f) => f.endsWith(".markets.jsonl")).map((f) => f.replace(".markets.jsonl", ""));
  seriesList = seriesList.filter((s) => !PARLAY.test(s));

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { collected_at: new Date().toISOString(), interval_minutes: 1, series: {},
    totals: { markets: 0, candles: 0, incomplete: 0, skipped_existing: 0 } };

  for (const s of seriesList) {
    const mf = path.join(SRC, `${s}.markets.jsonl`);
    if (!fs.existsSync(mf)) continue;
    const markets = fs.readFileSync(mf, "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && !PARLAY.test(m.ticker || "") && ["yes", "no"].includes((m.result || "").toLowerCase()))
      .slice(0, maxMarkets);
    if (!markets.length) continue;

    const outFile = path.join(OUT, `${s}.candles.jsonl`);
    if (fs.existsSync(outFile)) { manifest.totals.skipped_existing++; console.log(`${s.padEnd(16)} skipped (exists)`); continue; }
    const ws = fs.createWriteStream(outFile + ".part");
    let nC = 0, nIncomplete = 0;
    for (const m of markets) {
      const res = await candlesFor(s, m);
      if (!res || !res.rows.length) continue;
      if (res.quote_coverage < 0.05) nIncomplete++;   // <5% of minutes quoted = barely tradeable
      ws.write(JSON.stringify({ ticker: m.ticker, event: m.event_ticker || m.ticker, series: s,
        result: (m.result || "").toLowerCase(), open: m.open_time, close: m.close_time,
        expected_minutes: res.expected, quoted_minutes: res.quoted, quote_coverage: +res.quote_coverage.toFixed(4), candles: res.rows }) + "\n");
      nC += res.rows.length;
    }
    await new Promise((r) => ws.end(r));
    fs.renameSync(outFile + ".part", outFile);          // atomic: a killed run leaves no half file
    manifest.series[s] = { markets: markets.length, candles: nC, thin_markets_lt5pct_quoted: nIncomplete };
    manifest.totals.markets += markets.length; manifest.totals.candles += nC; manifest.totals.incomplete += nIncomplete;
    console.log(`${s.padEnd(16)} markets=${String(markets.length).padStart(4)} candles=${String(nC).padStart(7)} thin(<5% quoted)=${nIncomplete}`);
  }
  fs.writeFileSync(path.join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nTOTAL markets=${manifest.totals.markets} candles=${manifest.totals.candles} incomplete=${manifest.totals.incomplete}`);
  console.log("->", OUT);
})();
