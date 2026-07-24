"use strict";
/** UHLGA forward verification v2 — fixes vs v1:
 *  (1) clean settlements only; (2) strict-exceed oracle P(X > thr+0.5) matching the venue's
 *  "high > thr" convention; (3) board thresholds gated on pair_quantity>0 (really traded)
 *  so we never score or "trade" placeholder quotes. Read-only, no orders.
 */
const path = require("path");
const LIB = require("path").join(__dirname, "..", "apps", "lantern-garage", "lib");
const board = require(path.join(LIB, "forecastex-board.js"));
const mos = require(path.join(LIB, "kalshi-mos.js"));
const edge = require(path.join(LIB, "kalshi-weather-edge.js"));

const PRODUCT = "UHLGA";
const PARAMS = edge.loadParams(require("path").join(__dirname, "..", "data", "kalshi", "weather-oracle-params-klga.json"));
const DAYS = [];
for (let d = 9; d <= 23; d++) DAYS.push(`202607${String(d).padStart(2, "0")}`);

function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const oracleYes = (thr, mean, sigma) => 1 - 0.5 * (1 + erf(((thr + 0.5 - mean) / sigma) / Math.SQRT2));

function tradedBoard(rows, contractDate) {
  const out = [];
  for (const r of rows || []) {
    if (r.subtype !== "YES") continue;
    const p = board.parseContractId(r.event_contract);
    if (!p || p.product !== PRODUCT || p.date !== contractDate) continue;
    const yes = parseFloat(r.end_price), vol = parseFloat(r.pair_quantity), oi = parseFloat(r.open_interest);
    if (!Number.isFinite(yes)) continue;
    out.push({ thr: p.thr, yes, vol: Number.isFinite(vol) ? vol : 0, oi: Number.isFinite(oi) ? oi : 0 });
  }
  return out.sort((a, b) => a.thr - b.thr);
}
function rps(cum, outIdx) {
  let s = 0;
  for (let i = 0; i < cum.length; i++) s += (cum[i] - (outIdx > i ? 1 : 0)) ** 2;
  return s / cum.length;
}

(async () => {
  const rowsByDay = {};
  for (const d of DAYS) rowsByDay[d] = await board.fetchDailyCsv("prices", d);
  const allRows = Object.values(rowsByDay).filter(Boolean).flat();
  const settled = board.settledHighs(allRows, PRODUCT);

  const sts = "2026-07-08T00:00Z", ets = "2026-07-24T00:00Z";
  const mosCsv = await (await fetch(
    `https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=KLGA&model=NBS&sts=${sts}&ets=${ets}&format=csv`,
    { signal: AbortSignal.timeout(30000) })).text();
  const byRun = mos.mosForecastHighs(mos.parseCsv(mosCsv));

  let nDays = 0, rpsO = 0, rpsB = 0, trades = 0, pnl = 0, wins = 0;
  const EDGE = 0.05;
  console.log("day        set  fh(L)  mean  nTraded  RPS_oracle RPS_board   trades  pnl");
  for (const [dayIso, s] of [...settled].sort()) {
    if (!s.clean || s.high == null) continue;
    const D = dayIso.replace(/-/g, "");
    const i = DAYS.indexOf(D);
    if (i <= 0 || !rowsByDay[DAYS[i - 1]]) continue;
    const b = tradedBoard(rowsByDay[DAYS[i - 1]], dayIso).filter((x) => x.vol > 0);
    if (b.length < 3) { console.log(`${dayIso}  ${s.high}  — <3 traded thresholds day-ahead, skipped`); continue; }
    const [y, m, dd] = dayIso.split("-").map(Number);
    let fh = null, lead = null;
    const rPrev = byRun.get(`${y}-${m}-${dd - 1}`), rDay = byRun.get(`${y}-${m}-${dd}`);
    if (rPrev && rPrev.days.get(`${y}-${m}-${dd}`)) { fh = rPrev.days.get(`${y}-${m}-${dd}`).high; lead = 1; }
    else if (rDay && rDay.days.get(`${y}-${m}-${dd}`)) { fh = rDay.days.get(`${y}-${m}-${dd}`).high; lead = 0; }
    if (fh == null) { console.log(`${dayIso}  ${s.high}  NO MOS — skipped`); continue; }
    const mean = edge.calibratedMean(fh, m, dd, PARAMS);
    const sigma = edge.sigmaForLead(lead, PARAMS);
    const cumO = b.map((x) => oracleYes(x.thr, mean, sigma));
    const cumB = b.map((x) => x.yes);
    const outIdx = b.filter((x) => s.high > x.thr).length;   // strict exceed
    const ro = rps(cumO, outIdx), rb = rps(cumB, outIdx);
    nDays++; rpsO += ro; rpsB += rb;
    let dT = 0, dP = 0;
    for (let k = 0; k < b.length; k++) {
      const fair = cumO[k], px = cumB[k];
      if (px <= 0.02 || px >= 0.98) continue;
      const won = s.high > b[k].thr ? 1 : 0;
      let g = null;
      if (fair - px > EDGE) g = won - px;
      else if (px - fair > EDGE) g = (1 - won) - (1 - px);
      if (g != null) { dT++; dP += g; trades++; pnl += g; if (g > 0) wins++; }
    }
    console.log(`${dayIso}  ${String(s.high).padStart(3)}  ${String(fh).padStart(3)}(L${lead}) ${mean.toFixed(1)}   ${String(b.length).padStart(3)}      ${ro.toFixed(4)}     ${rb.toFixed(4)}     ${dT}      ${dP >= 0 ? "+" : ""}${dP.toFixed(2)}`);
  }
  console.log(`\nFORWARD clean days n=${nDays}:  RPS oracle=${(rpsO / nDays).toFixed(4)}  vs board=${(rpsB / nDays).toFixed(4)}  -> ${rpsO < rpsB ? "ORACLE BETTER" : "BOARD BETTER"}`);
  console.log(`hypo trades (edge>5c, traded thresholds only, GROSS no fees): n=${trades} wins=${wins} pnl=$${pnl.toFixed(2)}/unit`);
})();
