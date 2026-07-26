"use strict";
/**
 * Fade-the-longshot LIVE PROBE (#2954 evidence instrument, #2956) — prepare-only harness.
 *
 * WHAT IT MEASURES (the two things no backtest can): maker fill quality / adverse selection
 * in the 1-15c band, and operational truth of the pipeline. It is NOT a hit-rate certifier —
 * at 1 contract/market, ~300 settled fills are needed before the hit-rate CI says anything
 * (pre-registered below). Scaling past 1-contract probes is gated on #2954 landing.
 *
 * THE TRADE (validated design, CEPR DP20631 — Buergi, Deng & Whelan): post a RESTING 1-contract
 * NO bid at 100−p for markets whose YES ask p ≤ 15c. Maker-side (the paper's better-informed
 * side of the bias); maker fee rounds to ~$0 at this size per the 2026-07 fee schedule.
 *
 * SAFETY — this script cannot spend money by itself. Every order goes through
 * lib/kalshi-api.placeOrder, which requires ALL of: KALSHI_TRADING_ENABLED=1, the admin flag,
 * kill-switch absent, KALSHI_LIVE_EDGE_PROVEN=1 (fail-closed prove-or-pause), the source
 * 'kalshi-longshot-probe' in KALSHI_LIVE_SCOPE, confirmLive:true (only set by --confirm-live),
 * AND the server-side probe contract (1x NO limit 85-99c only). Default invocation is DRY-RUN
 * and just logs the plan. Arming any of that is the OPERATOR's action, never this script's.
 *
 * PRE-REGISTERED PROTOCOL (before first arm; grade against these, no post-hoc bending):
 *   - Band: implied YES 1-15c. Exclusions: crypto-family tickers (higher fee multiplier),
 *     markets closing <2h (news risk) or >7d (capital drag), one market per EVENT.
 *   - Caps: --max markets per run (default 5), 1 contract each (~$4.75 max new collateral/run).
 *   - Operational kill: any live order outside the probe contract → file the kill switch.
 *   - Hit-rate judgment: NONE before 300 settled fills (q=1% → Wilson 95% CI ~[0.2%, 2.9%]).
 *   - Adverse-selection proxy: mean(settle-vs-fill markout) reported per grade run; if fills
 *     lose >2c/contract on average after 50 settles, pause and take the finding to #2954.
 *
 * Run:  node experiments/kalshi_longshot_probe.js            # scan + DRY-RUN plans
 *       node experiments/kalshi_longshot_probe.js --confirm-live   # real orders IF env gates open
 *       node experiments/kalshi_longshot_probe.js --grade    # settle + grade past probe rows
 */
const fs = require("fs");
const path = require("path");
const api = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "kalshi-api.js"));

const LEDGER = path.join(__dirname, "..", "data", "trading", "longshot-probe.jsonl");
const BAND = { lo: 1, hi: 15 };
// Higher-fee crypto family, AND parlays (KXMVE* multi-variant events). The parlay exclusion is
// load-bearing, not cosmetic: a DRY RUN on 2026-07-25 found 177/6000 open markets in the 1-15c
// band and ALL 177 were KXMVESPORTSMULTIGAMEEXTENDED / KXMVECROSSCATEGORY — e.g. "yes Baltimore,
// yes Arizona, yes Chicago C, ..." (12-leg combos at 0.2c). Parlays are a CONSTRUCTED product
// priced by the venue from leg probabilities with built-in margin, with strongly correlated legs.
// Selling their NO side is not "fading irrational longshot buyers" (the CEPR DP20631 population,
// which is SINGLE-EVENT contracts) — it is competing with the venue's own pricing engine while
// taking correlated tail risk. Different population => the studied edge does not transfer.
const EXCLUDE = /BTC|ETH|SOL|XRP|DOGE|CRYPTO/i;   // higher fee multiplier family
const EXCLUDE_PARLAY = /^KXMVE/i;                 // multi-variant / parlay events
const MIN_TTL_H = 2, MAX_TTL_D = 7;

function log(row) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}
function ledgerRows() {
  try { return fs.readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

/** Pure candidate filter — unit-tested. Returns {ok, why} per market. */
function probeFilter(m, now = Date.now(), seenEvents = new Set()) {
  const ask = Number(m.yesAskCents);
  if (!Number.isFinite(ask) || ask < BAND.lo || ask > BAND.hi) return { ok: false, why: "outside 1-15c band" };
  if (EXCLUDE.test(String(m.ticker || "")) || EXCLUDE.test(String(m.eventTicker || ""))) return { ok: false, why: "crypto-family fee multiplier" };
  if (EXCLUDE_PARLAY.test(String(m.ticker || "")) || EXCLUDE_PARLAY.test(String(m.eventTicker || ""))) return { ok: false, why: "parlay (KXMVE*) — wrong population, correlated legs, venue-priced" };
  const close = Date.parse(m.closeTime || "");
  if (!Number.isFinite(close)) return { ok: false, why: "no close time" };
  const ttlH = (close - now) / 3.6e6;
  if (ttlH < MIN_TTL_H) return { ok: false, why: "closes <2h (news risk)" };
  if (ttlH > MAX_TTL_D * 24) return { ok: false, why: "closes >7d (capital drag)" };
  if (seenEvents.has(m.eventTicker)) return { ok: false, why: "event already has a probe market" };
  if (!(Number(m.volume) > 0)) return { ok: false, why: "no volume" };
  return { ok: true, why: "candidate" };
}

async function scan(confirmLive, maxMarkets) {
  const already = new Set(ledgerRows().filter(r => r.event === "probe_order").map(r => r.ticker));
  // ENUMERATE BY SERIES, never by the paginated market list. Measured 2026-07-25: a plain
  // getMarkets({status:"open"}) walk returned 12,000 markets that were 100% KXMVE* parlays —
  // single-event markets never appeared in the sample at all. Scanning that way finds zero real
  // candidates and looks like "no population exists", which is FALSE: querying by series_ticker
  // shows abundant single-event longshots (KXFEDDECISION 30 in-band w/ vol, KXCPI 4 @ 15-28k vol,
  // KXHIGHNY/CHI/LAX 7-8 each). Series enumeration is the only unbiased way in.
  const seriesList = (process.env.KALSHI_PROBE_SERIES ||
    "KXHIGHNY,KXHIGHCHI,KXHIGHLAX,KXHIGHDEN,KXHIGHPHIL,KXHIGHTDC,KXCPI,KXCPICOREA,KXFEDDECISION,KXRATECUTCOUNT,KXU3MAX,KXFRM"
  ).split(",").map(s => s.trim()).filter(Boolean);
  const raw = [];
  for (const s of seriesList) {
    try {
      const r = await api.getMarkets({ series_ticker: s, status: "open", limit: 1000 });
      const ms = ((r && r.data && r.data.markets) || (r && r.markets) || []);
      raw.push(...ms);
    } catch { /* series may not exist right now — skip */ }
  }
  if (!raw.length) {
    console.error("no markets returned across", seriesList.length, "series (network/creds?)");
    return;
  }
  const cents = (c, d) => Number.isFinite(Number(c)) ? Number(c) : (Number.isFinite(parseFloat(d)) ? Math.round(parseFloat(d) * 100) : NaN);
  const markets = raw.map(m => ({
    ticker: m.ticker, eventTicker: m.event_ticker || m.eventTicker,
    yesAskCents: cents(m.yes_ask, m.yes_ask_dollars), yesBidCents: cents(m.yes_bid, m.yes_bid_dollars),
    volume: Number(m.volume ?? m.volume_fp ?? 0), closeTime: m.close_time || m.closeTime,
  }));
  const seenEvents = new Set();
  const picks = [];
  for (const m of markets) {
    if (already.has(m.ticker)) continue;
    const f = probeFilter(m, Date.now(), seenEvents);
    if (!f.ok) continue;
    seenEvents.add(m.eventTicker);
    picks.push(m);
    if (picks.length >= maxMarkets) break;
  }
  console.log(`candidates: ${picks.length}/${markets.length} (band ${BAND.lo}-${BAND.hi}c, dedup by event)`);
  for (const m of picks) {
    const p = Number(m.yesAskCents);
    const noLimit = 100 - p;                    // resting NO bid == offering YES at p
    const order = { ticker: m.ticker, side: "no", action: "buy", count: 1, type: "limit",
                    limitCents: noLimit, source: "kalshi-longshot-probe", confirmLive };
    const out = await api.placeOrder(order);
    log({ event: "probe_order", ticker: m.ticker, eventTicker: m.eventTicker, yesAskCents: p,
          noLimitCents: noLimit, mode: out.mode, wouldBlock: out.wouldBlock || null,
          orderId: (out.order && out.order.orderId) || null,
          snapshot: { yesBid: m.yesBidCents, yesAsk: m.yesAskCents, volume: m.volume, close: m.closeTime } });
    console.log(`  ${m.ticker}  YES@${p}c -> NO limit ${noLimit}c  [${out.mode}]${out.wouldBlock ? " blocked: " + out.wouldBlock.join("; ") : ""}`);
  }
  if (!picks.length) console.log("nothing in band right now — rerun later.");
}

async function grade() {
  const rows = ledgerRows().filter(r => r.event === "probe_order");
  if (!rows.length) return console.log("no probe rows yet");
  let settled = 0, hits = 0, pnl = 0;
  for (const r of rows) {
    try {
      const res = await api.getMarkets({ tickers: r.ticker });
      const m = (res.markets || [])[0];
      const result = (m && m.result || "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;
      settled++;
      const hit = result === "yes";                       // the longshot happened -> we pay
      if (hit) hits++;
      const net = hit ? -(r.noLimitCents) + 100 - 100 : (100 - r.noLimitCents); // NO buyer: win=100-cost, lose=-cost
      pnl += hit ? -(r.noLimitCents) : (100 - r.noLimitCents);
      log({ event: "probe_grade", ticker: r.ticker, result, hit, netCents: hit ? -r.noLimitCents : 100 - r.noLimitCents });
    } catch { /* market gone; skip */ }
  }
  const q = settled ? (100 * hits / settled).toFixed(2) : "n/a";
  console.log(`settled=${settled} hits=${hits} (${q}%)  pnl=${pnl}c  [judgment gate: 300 settled fills]`);
  if (settled < 300) console.log("PRE-REGISTERED: below the 300-fill bar — no hit-rate conclusion may be drawn.");
}

if (require.main === module) {
  const confirmLive = process.argv.includes("--confirm-live");
  const maxIdx = process.argv.indexOf("--max");
  const maxMarkets = maxIdx > 0 ? Math.max(1, Math.min(10, parseInt(process.argv[maxIdx + 1], 10) || 5)) : 5;
  (process.argv.includes("--grade") ? grade() : scan(confirmLive, maxMarkets))
    .catch(e => { console.error("probe error:", e.message); process.exit(1); });
}

module.exports = { probeFilter, BAND };
