"use strict";
/** Cross-venue basis test: Kalshi KXHIGHNY (Central Park, CLI settle) vs ForecastEx UHLGA
 * (LaGuardia, METAR-max settle). Measures: (1) realized station basis Jun1-Jul22 in each
 * venue's OWN settle definition; (2) daily venue-implied basis vs climo vs realized;
 * (3) symmetric cross-transport hypothetical trades at executable/haircut prices, net fees.
 * Read-only — no orders. Small-n caveats printed with results.
 */
const path = require("path");
const LIB = require("path").join(__dirname, "..", "apps", "lantern-garage", "lib");
const board = require(path.join(LIB, "forecastex-board.js"));
const mos = require(path.join(LIB, "kalshi-mos.js"));
const fees = require(path.join(LIB, "forecastex-fees.js"));
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kFee = (p) => Math.ceil(7 * p * (1 - p)) / 100;
const fFee = (fees.forecastExFeeCents() || 0) / 100;

const DAYS = [];
for (let d = 9; d <= 23; d++) DAYS.push(`202607${String(d).padStart(2, "0")}`);
const isoOf = (D) => `${D.slice(0, 4)}-${D.slice(4, 6)}-${D.slice(6, 8)}`;

function cumAt(thrs, cums, x) {   // P(high > x) with linear interp on threshold grid
  if (!thrs.length) return null;
  if (x <= thrs[0]) return cums[0];
  if (x >= thrs[thrs.length - 1]) return cums[cums.length - 1];
  for (let i = 1; i < thrs.length; i++) if (x <= thrs[i]) {
    const w = (x - thrs[i - 1]) / (thrs[i] - thrs[i - 1]);
    return cums[i - 1] + w * (cums[i] - cums[i - 1]);
  }
  return cums[cums.length - 1];
}
function medianOf(thrs, cums) {   // temp t where P(high > t) = 0.5
  for (let i = 0; i < thrs.length; i++) if (cums[i] <= 0.5) {
    if (i === 0) return thrs[0];
    const w = (cums[i - 1] - 0.5) / (cums[i - 1] - cums[i]);
    return thrs[i - 1] + w * (thrs[i] - thrs[i - 1]);
  }
  return thrs[thrs.length - 1];
}
// Kalshi bracket markets -> pmf over integer temps -> cum P(> t) on a threshold grid
function kalshiCum(ms, quotes) {
  const pmf = new Map();
  let tot = 0;
  const add = (t, p) => { pmf.set(t, (pmf.get(t) || 0) + p); };
  for (const m of ms) {
    const q = quotes.get(m.ticker);
    if (!q) continue;
    const mid = (q.bid + q.ask) / 2;
    if (!(mid > 0 && mid < 1)) continue;
    if (m.strike_type === "between") {
      const n = m.cap_strike - m.floor_strike + 1;
      for (let t = m.floor_strike; t <= m.cap_strike; t++) add(t, mid / n);
    } else if (m.strike_type === "greater") {
      for (let t = m.floor_strike + 1; t <= m.floor_strike + 4; t++) add(t, mid / 4);
    } else if (m.strike_type === "less") {
      for (let t = m.cap_strike - 4; t <= m.cap_strike - 1; t++) add(t, mid / 4);
    }
    tot += mid;
  }
  if (tot < 0.5) return null;   // too little priced mass to normalize honestly
  const temps = [...pmf.keys()].sort((a, b) => a - b);
  const cum = [];
  for (const t of temps) {
    let s = 0;
    for (const [u, p] of pmf) if (u > t) s += p;
    cum.push(s / tot);
  }
  return { thrs: temps, cums: cum };
}

(async () => {
  // ── settlement legs, each venue's own definition ─────────────────────────
  const cli = await (await fetch("https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year=2026", { signal: AbortSignal.timeout(30000) })).json();
  const knyc = new Map();   // iso -> CLI high
  for (const r of cli.results || []) if (r.valid >= "2026-06-01" && Number.isFinite(r.high)) knyc.set(r.valid, r.high);
  const asosCsv = await (await fetch("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=LGA&network=NY_ASOS&data=tmpf&sts=2026-06-01T04:00Z&ets=2026-07-23T04:00Z&tz=Etc/UTC&format=onlycomma&missing=empty", { signal: AbortSignal.timeout(45000) })).text();
  const lga = new Map();    // iso (ET day) -> round(max tmpf)
  for (const o of mos.parseCsv(asosCsv)) {
    const v = parseFloat(o.tmpf);
    if (!Number.isFinite(v)) continue;
    const t = Date.parse(String(o.valid).replace(" ", "T") + "Z") - 4 * 3600e3;
    const d = new Date(t).toISOString().slice(0, 10);
    if (!lga.has(d) || v > lga.get(d)) lga.set(d, v);
  }
  for (const [d, v] of lga) lga.set(d, Math.round(v));
  const basisDays = [...knyc.keys()].filter((d) => lga.has(d) && d <= "2026-07-22").sort();
  const bs = basisDays.map((d) => lga.get(d) - knyc.get(d));
  const bMean = bs.reduce((a, b) => a + b, 0) / bs.length;
  const bSd = Math.sqrt(bs.reduce((a, b) => a + (b - bMean) ** 2, 0) / bs.length);
  console.log(`realized basis LGA(venue-def) - KNYC(CLI), ${basisDays[0]}..${basisDays[basisDays.length - 1]}: n=${bs.length} mean=${bMean.toFixed(2)}F sd=${bSd.toFixed(2)}F min=${Math.min(...bs)} max=${Math.max(...bs)}`);

  // ── venue data ────────────────────────────────────────────────────────────
  const rowsByDay = {};
  for (const d of DAYS) rowsByDay[d] = await board.fetchDailyCsv("prices", d);
  const minTs = Math.floor(Date.parse("2026-07-10T00:00:00Z") / 1000);
  const maxTs = Math.floor(Date.parse("2026-07-23T12:00:00Z") / 1000);
  const km = ((await (await fetch(`${BASE}/markets?series_ticker=KXHIGHNY&status=settled&limit=1000&min_close_ts=${minTs}&max_close_ts=${maxTs}`, { signal: AbortSignal.timeout(20000) })).json()).markets) || [];
  const byEvent = new Map();
  for (const m of km) { if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []); byEvent.get(m.event_ticker).push(m); }

  let f2kTrades = 0, f2kPnl = 0, k2fTrades = 0, k2fPnl = 0;
  const EDGE = 0.05, HAIRCUT = 0.02;
  console.log(`\nday        b_real  b_climo  b_implied(F-K)   F->K trades/pnl   K->F trades/pnl`);
  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7 };
  for (const [ev, ms] of [...byEvent].sort()) {
    const mm = ev.match(/-26([A-Z]{3})(\d{2})$/); if (!mm) continue;
    const dayIso = `2026-${String(MONTHS[mm[1]]).padStart(2, "0")}-${mm[2]}`;
    const D = dayIso.replace(/-/g, "");
    const i = DAYS.indexOf(D);
    if (i <= 0 || !rowsByDay[DAYS[i - 1]]) continue;
    // FEX D-1 EOD board, traded thresholds only
    const fb = [];
    for (const r of rowsByDay[DAYS[i - 1]] || []) {
      if (r.subtype !== "YES") continue;
      const p = board.parseContractId(r.event_contract);
      if (!p || p.product !== "UHLGA" || p.date !== dayIso) continue;
      const yes = parseFloat(r.end_price), vol = parseFloat(r.pair_quantity);
      if (Number.isFinite(yes) && vol > 0) fb.push({ thr: p.thr, yes });
    }
    fb.sort((a, b) => a.thr - b.thr);
    if (fb.length < 3) continue;
    const fThrs = fb.map((x) => x.thr), fCums = fb.map((x) => x.yes);
    // Kalshi quotes: morning-of candle (first ≥10Z) per market
    const st = Math.floor(Date.parse(`${dayIso}T10:00:00Z`) / 1000);
    const et = st + 4 * 3600;
    const quotes = new Map();
    for (const m of ms) {
      try {
        const cs = ((await (await fetch(`${BASE}/series/KXHIGHNY/markets/${m.ticker}/candlesticks?start_ts=${st}&end_ts=${et}&period_interval=60`, { signal: AbortSignal.timeout(15000) })).json()).candlesticks) || [];
        const c = cs[0];
        if (c) quotes.set(m.ticker, { ask: parseFloat(c.yes_ask.close_dollars), bid: parseFloat(c.yes_bid.close_dollars) });
      } catch {}
      await sleep(110);
    }
    const kc = kalshiCum(ms, quotes);
    const bReal = (lga.get(dayIso) != null && knyc.get(dayIso) != null) ? lga.get(dayIso) - knyc.get(dayIso) : null;
    let bImp = null;
    if (kc) bImp = medianOf(fThrs, fCums) - medianOf(kc.thrs, kc.cums);

    // F->K: transported fair for each Kalshi market vs executable ask/bid
    let dT = 0, dP = 0;
    for (const m of ms) {
      const q = quotes.get(m.ticker);
      if (!q || !(q.ask > 0.01 && q.ask < 0.99)) continue;
      let fair = null;
      if (m.strike_type === "greater") fair = cumAt(fThrs, fCums, m.floor_strike + bMean);
      else if (m.strike_type === "less") fair = 1 - cumAt(fThrs, fCums, m.cap_strike - 1 + bMean);
      else fair = cumAt(fThrs, fCums, m.floor_strike - 1 + bMean) - cumAt(fThrs, fCums, m.cap_strike + bMean);
      if (fair == null || !Number.isFinite(fair)) continue;
      const won = m.result === "yes" ? 1 : 0;
      if (fair - q.ask > EDGE) { dP += won - q.ask - kFee(q.ask); dT++; }
      else if ((1 - fair) - (1 - q.bid) > EDGE && q.bid > 0.01) { const px = 1 - q.bid; dP += (1 - won) - px - kFee(px); dT++; }
    }
    f2kTrades += dT; f2kPnl += dP;
    // K->F: transported fair for each FEX threshold vs EOD close ± haircut
    let eT = 0, eP = 0;
    if (kc && lga.get(dayIso) != null) {
      for (const x of fb) {
        if (!(x.yes > 0.02 && x.yes < 0.98)) continue;
        const fair = cumAt(kc.thrs, kc.cums, x.thr - bMean);
        if (fair == null) continue;
        const won = lga.get(dayIso) > x.thr ? 1 : 0;
        if (fair - x.yes > EDGE) { const px = Math.min(0.99, x.yes + HAIRCUT); eP += won - px - fFee; eT++; }
        else if (x.yes - fair > EDGE) { const px = Math.min(0.99, 1 - x.yes + HAIRCUT); eP += (1 - won) - px - fFee; eT++; }
      }
    }
    k2fTrades += eT; k2fPnl += eP;
    console.log(`${dayIso}   ${bReal == null ? " ?" : String(bReal).padStart(2)}      ${bMean.toFixed(1)}     ${bImp == null ? "  ?  " : bImp.toFixed(1).padStart(5)}          ${dT}/${dP >= 0 ? "+" : ""}${dP.toFixed(2)}          ${eT}/${eP >= 0 ? "+" : ""}${eP.toFixed(2)}`);
  }
  console.log(`\nCROSS-VENUE (net of fees; FEX fills haircut ${HAIRCUT * 100}c; K->F freshness favors Kalshi info):`);
  console.log(`  FEX->Kalshi: trades=${f2kTrades} pnl=$${f2kPnl.toFixed(2)}/unit`);
  console.log(`  Kalshi->FEX: trades=${k2fTrades} pnl=$${k2fPnl.toFixed(2)}/unit`);
  console.log(`  caveats: aligned days are few; FEX leg uses D-1 EOD close vs Kalshi morning-of (10Z) — a ~10h info gap that HANDICAPS the FEX->Kalshi direction; EOD closes are not guaranteed executable.`);
})();
