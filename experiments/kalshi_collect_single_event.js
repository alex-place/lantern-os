"use strict";
/**
 * Kalshi single-event settled-market collector (#2954 requirement #7).
 *
 * WHY THIS EXISTS: the original FLB study's source data was never committed and is gone from
 * every checkout and archive, so its headline could not be reproduced. This collector is the
 * committed, rerunnable replacement. Two hard rules it encodes:
 *
 *   1. ENUMERATE BY series_ticker, NEVER by a paginated market list. Measured 2026-07-25:
 *      getMarkets({status:"open"}) pagination returned 12,000 markets that were 100% KXMVE*
 *      parlays — single-event markets never entered the sample. Any conclusion drawn from that
 *      walk is a selection artifact (this actually happened; see #2954 correction comment).
 *   2. EXCLUDE PARLAYS (KXMVE*). They are venue-constructed from leg probabilities with designed
 *      margin and strongly correlated legs — a different population from CEPR DP20631's
 *      single-event contracts. Kept out by construction here (series allowlist) AND asserted.
 *
 * Writes data/kalshi/settled-single/<series>.{markets,trades}.jsonl + a composition manifest so
 * a skewed sample can never again masquerade as a finding. Read-only; no orders.
 *
 * Run: node experiments/kalshi_collect_single_event.js [--series A,B] [--max-markets 200]
 */
const fs = require("fs");
const path = require("path");

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const OUT = path.join(__dirname, "..", "data", "kalshi", "settled-single");
const PARLAY = /^KXMVE/i;

// Liquid single-event series across distinct categories (weather / macro / rates).
const DEFAULT_SERIES = [
  "KXHIGHNY", "KXHIGHCHI", "KXHIGHLAX", "KXHIGHDEN", "KXHIGHPHIL", "KXHIGHTDC",
  "KXHIGHTHOU", "KXHIGHTLV", "KXHIGHTATL", "KXHIGHTSEA",
  "KXCPI", "KXCPICOREA", "KXFEDDECISION", "KXRATECUTCOUNT", "KXFRM", "KXU3MAX",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "unisona-flb-collector" } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(400 * (i + 1)); }
  }
  return null;
}

async function settledMarkets(series, maxMarkets) {
  const out = [];
  let cursor = null, pages = 0;
  do {
    const u = new URL(`${BASE}/markets`);
    u.searchParams.set("series_ticker", series);
    u.searchParams.set("status", "settled");
    u.searchParams.set("limit", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = await api(u.toString());
    if (!j) break;
    const ms = (j.markets || []).filter((m) => {
      if (PARLAY.test(m.ticker || "")) return false;           // rule 2, asserted not assumed
      const r = (m.result || "").toLowerCase();
      return r === "yes" || r === "no";                        // settled ground truth only
    });
    out.push(...ms);
    cursor = j.cursor; pages++;
    await sleep(120);
  } while (cursor && pages < 6 && out.length < maxMarkets);
  return out.slice(0, maxMarkets);
}

async function tradesFor(ticker) {
  const out = [];
  let cursor = null, pages = 0;
  do {
    const u = new URL(`${BASE}/markets/trades`);
    u.searchParams.set("ticker", ticker);
    u.searchParams.set("limit", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = await api(u.toString());
    if (!j) break;
    out.push(...(j.trades || []));
    cursor = j.cursor; pages++;
    await sleep(90);
  } while (cursor && pages < 5);
  return out;
}

(async () => {
  const argv = process.argv;
  const sIdx = argv.indexOf("--series");
  const series = sIdx > 0 && argv[sIdx + 1] ? argv[sIdx + 1].split(",").map((s) => s.trim()) : DEFAULT_SERIES;
  const mIdx = argv.indexOf("--max-markets");
  const maxMarkets = mIdx > 0 ? parseInt(argv[mIdx + 1], 10) || 200 : 200;

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { collected_at: new Date().toISOString(), series: {}, totals: { markets: 0, trades: 0, parlays_excluded: 0 } };

  for (const s of series) {
    if (PARLAY.test(s)) { manifest.totals.parlays_excluded++; continue; }
    const ms = await settledMarkets(s, maxMarkets);
    if (!ms.length) { manifest.series[s] = { markets: 0, trades: 0, note: "no settled markets" }; continue; }
    fs.writeFileSync(path.join(OUT, `${s}.markets.jsonl`), ms.map((m) => JSON.stringify(m)).join("\n") + "\n");
    let nTrades = 0;
    const tf = fs.createWriteStream(path.join(OUT, `${s}.trades.jsonl`));
    for (const m of ms) {
      const tr = await tradesFor(m.ticker);
      for (const t of tr) tf.write(JSON.stringify(t) + "\n");
      nTrades += tr.length;
    }
    tf.end();
    manifest.series[s] = { markets: ms.length, trades: nTrades, product_type: "single_event" };
    manifest.totals.markets += ms.length; manifest.totals.trades += nTrades;
    console.log(`${s.padEnd(16)} markets=${String(ms.length).padStart(4)}  trades=${nTrades}`);
  }
  fs.writeFileSync(path.join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nTOTAL markets=${manifest.totals.markets} trades=${manifest.totals.trades}`);
  console.log(`composition: 100% single_event by construction (parlays excluded by allowlist + assertion)`);
  console.log("->", OUT);
})();
