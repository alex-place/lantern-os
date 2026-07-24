"use strict";
/** Day-of nowcast vs Kalshi intraday candlesticks — KXHIGHNY, settled days Jul 10-22 2026.
 * Nowcast: final_high = max(H_t, R), H_t = Central Park ASOS max-tmpf-so-far at checkpoint,
 * R ~ N(calibratedMean(day-of MOS lead-0), sigmaNowcastF) from the FITTED KNYC params.
 * Prices: executable candle closes (buy YES at yes_ask, buy NO at 1-yes_bid). Settlement:
 * the market's own result. Fees: Kalshi 7*p*(1-p) rounded up per contract. Read-only.
 * Caveat carried honestly: CLI settle can exceed ASOS max (measured up to 4F on 6/13 days),
 * so H_t is a conservative floor for the top side.
 */
const path = require("path");
const LIB = require("path").join(__dirname, "..", "apps", "lantern-garage", "lib");
const mos = require(path.join(LIB, "kalshi-mos.js"));
const edge = require(path.join(LIB, "kalshi-weather-edge.js"));
const PARAMS = edge.loadParams(require("path").join(__dirname, "..", "data", "kalshi", "weather-oracle-params.json"));
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const cdf = (x, mu, sg) => 0.5 * (1 + erf((x - mu) / sg / Math.SQRT2));

// P(final = max(H, R) satisfies the market) — integer settle, continuous R
function fairProb(m, H, mu, sg) {
  if (m.strike_type === "greater") {          // yes iff settle > floor
    const b = m.floor_strike + 0.5;
    return H > m.floor_strike ? 1 : 1 - cdf(b, mu, sg);
  }
  if (m.strike_type === "less") {             // yes iff settle < cap
    const b = m.cap_strike - 0.5;
    return H >= m.cap_strike ? 0 : cdf(b, mu, sg);
  }
  // between: floor <= settle <= cap
  const lo = m.floor_strike - 0.5, hi = m.cap_strike + 0.5;
  if (H > m.cap_strike) return 0;
  if (H >= m.floor_strike) return cdf(hi, mu, sg);
  return cdf(hi, mu, sg) - cdf(lo, mu, sg);
}
const feeD = (p) => Math.ceil(7 * p * (1 - p)) / 100;   // Kalshi fee in dollars/contract

(async () => {
  // 1. settled markets in window
  const minTs = Math.floor(Date.parse("2026-07-10T00:00:00Z") / 1000);
  const maxTs = Math.floor(Date.parse("2026-07-23T12:00:00Z") / 1000);
  const r = await fetch(`${BASE}/markets?series_ticker=KXHIGHNY&status=settled&limit=1000&min_close_ts=${minTs}&max_close_ts=${maxTs}`, { signal: AbortSignal.timeout(20000) });
  const markets = (await r.json()).markets || [];
  const byEvent = new Map();
  for (const m of markets) {
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
    byEvent.get(m.event_ticker).push(m);
  }
  console.log(`settled markets=${markets.length} events=${byEvent.size}`);

  // 2. METAR (Central Park 'NYC') + MOS (KNYC) for the window
  const asosUrl = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=NYC&network=NY_ASOS&data=tmpf&sts=2026-07-10T00:00Z&ets=2026-07-23T12:00Z&tz=Etc/UTC&format=onlycomma&missing=empty";
  const asos = mos.parseCsv(await (await fetch(asosUrl, { signal: AbortSignal.timeout(30000) })).text());
  const mosCsv = await (await fetch("https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KNYC&model=NBS&sts=2026-07-09T00:00Z&ets=2026-07-24T00:00Z&format=csv", { signal: AbortSignal.timeout(30000) })).text();
  const byRun = mos.mosForecastHighs(mos.parseCsv(mosCsv));
  console.log(`asos obs=${asos.length} mos runs=${byRun.size}`);

  const CHECKS_Z = [15, 17, 19, 21];   // 11a,1p,3p,5p ET
  const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  let totTrades = 0, totPnl = 0, totWins = 0, totFees = 0;
  const perCheck = {}; CHECKS_Z.forEach((h) => perCheck[h] = { n: 0, pnl: 0 });

  for (const [ev, ms] of [...byEvent].sort()) {
    const mm = ev.match(/-26([A-Z]{3})(\d{2})$/);
    if (!mm) continue;
    const mon = MONTHS[mm[1]], day = parseInt(mm[2], 10);
    const dayIso = `2026-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // MOS day-of (lead 0), fall back lead 1
    let fh = null;
    const r0 = byRun.get(`2026-${mon}-${day}`), r1 = byRun.get(`2026-${mon}-${day - 1}`);
    if (r0 && r0.days.get(`2026-${mon}-${day}`)) fh = r0.days.get(`2026-${mon}-${day}`).high;
    else if (r1 && r1.days.get(`2026-${mon}-${day}`)) fh = r1.days.get(`2026-${mon}-${day}`).high;
    if (fh == null) { console.log(`${dayIso}: no MOS, skip`); continue; }
    const mu = edge.calibratedMean(fh, mon, day, PARAMS);
    const sg = PARAMS.sigmaNowcastF || 1.839;

    // candles per market
    const st = Math.floor(Date.parse(`${dayIso}T10:00:00Z`) / 1000);
    const et = Math.floor(Date.parse(`${dayIso}T23:59:00Z`) / 1000);
    const candles = new Map();
    for (const m of ms) {
      try {
        const c = await fetch(`${BASE}/series/KXHIGHNY/markets/${m.ticker}/candlesticks?start_ts=${st}&end_ts=${et}&period_interval=60`, { signal: AbortSignal.timeout(15000) });
        candles.set(m.ticker, (await c.json()).candlesticks || []);
      } catch { candles.set(m.ticker, []); }
      await sleep(120);
    }
    const settleHigh = (() => {   // reconstruct settle from results for the log line
      let lo = -99, hi = 199;
      for (const m of ms) {
        if (m.strike_type === "greater") { if (m.result === "yes") lo = Math.max(lo, m.floor_strike + 1); else hi = Math.min(hi, m.floor_strike); }
        if (m.strike_type === "between" && m.result === "yes") { lo = m.floor_strike; hi = m.cap_strike; }
        if (m.strike_type === "less") { if (m.result === "yes") hi = Math.min(hi, m.cap_strike - 1); else lo = Math.max(lo, m.cap_strike); }
      }
      return lo === hi ? lo : `${lo}..${hi}`;
    })();

    const traded = new Set();
    let dayPnl = 0, dayTrades = 0;
    for (const hz of CHECKS_Z) {
      const cutoff = Date.parse(`${dayIso}T${String(hz).padStart(2, "0")}:00:00Z`);
      let H = -999;
      for (const o of asos) {
        const t = Date.parse(String(o.valid).replace(" ", "T") + "Z");
        const v = parseFloat(o.tmpf);
        if (Number.isFinite(v) && t <= cutoff && t >= cutoff - ietime()) {} // placeholder no-op
      }
      // max-so-far over the local day (ET day start = 04:00Z)
      const dayStart = Date.parse(`${dayIso}T04:00:00Z`);
      for (const o of asos) {
        const t = Date.parse(String(o.valid).replace(" ", "T") + "Z");
        const v = parseFloat(o.tmpf);
        if (Number.isFinite(v) && t >= dayStart && t <= cutoff && v > H) H = v;
      }
      if (H < -100) continue;
      for (const m of ms) {
        if (traded.has(m.ticker)) continue;
        const cs = candles.get(m.ticker) || [];
        const cand = cs.filter((c) => c.end_period_ts * 1000 <= cutoff).pop();
        if (!cand) continue;
        const ask = parseFloat((cand.yes_ask || {}).close_dollars);
        const bid = parseFloat((cand.yes_bid || {}).close_dollars);
        if (!Number.isFinite(ask) || !Number.isFinite(bid)) continue;
        const fair = fairProb(m, H, mu, sg);
        const won = m.result === "yes" ? 1 : 0;
        let g = null, px = null;
        if (ask > 0.01 && ask < 0.99 && fair - ask > 0.05) { px = ask; g = won - ask - feeD(ask); }
        else if (bid > 0.01 && bid < 0.99 && (1 - fair) - (1 - bid) > 0.05) { px = 1 - bid; g = (1 - won) - px - feeD(px); }
        if (g != null) {
          traded.add(m.ticker);
          dayTrades++; dayPnl += g; totTrades++; totPnl += g; totFees += feeD(px); if (g > 0) totWins++;
          perCheck[hz].n++; perCheck[hz].pnl += g;
        }
      }
    }
    console.log(`${dayIso} settle=${settleHigh} fh=${fh} mu=${mu.toFixed(1)} trades=${dayTrades} pnl=${dayPnl >= 0 ? "+" : ""}${dayPnl.toFixed(2)}`);
  }
  function ietime() { return 0; }
  console.log(`\nDAY-OF NOWCAST vs KALSHI (net of fees, executable ask/bid):`);
  console.log(`trades=${totTrades} wins=${totWins} pnl=$${totPnl.toFixed(2)}/unit  fees=$${totFees.toFixed(2)}`);
  for (const hz of CHECKS_Z) console.log(`  checkpoint ${hz}Z (${hz - 4 - 12 > 0 ? hz - 16 : hz - 4}${hz - 4 >= 12 ? "pm" : "am"} ET): n=${perCheck[hz].n} pnl=${perCheck[hz].pnl >= 0 ? "+" : ""}${perCheck[hz].pnl.toFixed(2)}`);
})();
