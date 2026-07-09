#!/usr/bin/env node
"use strict";
/**
 * GenCast Phase-0 — Gate G1 backtest runner (#2239). MEASUREMENT ONLY, no trading.
 *
 * Pulls a real summer window from IEM (NBS/NBM MOS forecasts + ASOS settled highs for KNYC /
 * Central Park), builds a day-ahead TIME-LAGGED ensemble per day, and grades that ensemble's
 * bucket distribution vs the incumbent fitted oracle vs flat climatology on settled highs —
 * using the live verifier's RPS/PIT (via ensemble-forecast-core.backtestG1).
 *
 * Caveat (rides every number here): a time-lagged NBS-MOS ensemble is the CHEAP proxy, not
 * GenCast and not a same-init perturbed ensemble — it conflates lead-time with spread. G1 only
 * asks "is a calibrated ensemble even a better forecaster than the crude Gaussian+ceiling core?"
 * If the proxy loses, GenCast (marginal on the same physics) won't save it. If it wins, THEN a
 * real ensemble is worth pursuing. Market/EV (G2) is a separate, later gate (needs #2218 asks).
 *
 * Run:  node experiments/gencast_g1_backtest.js [YYYY-MM]   (default 2025-07)
 */
const fs = require("fs");
const path = require("path");
const efc = require("../apps/lantern-garage/lib/ensemble-forecast-core");

const MONTH = process.argv[2] || "2025-07";
const [Y, M] = MONTH.split("-").map(Number);
const STATION_MOS = "KNYC", ASOS_STATION = "NYC", NETWORK = "NY_ASOS";
const OFFSET_H = -4; // EDT

// Fixed 2°F summer ladder (comparable across models; oracle + ensemble both grade on it).
const LADDER = [
  ["<=85", null, 85], ["86-87", 86, 87], ["88-89", 88, 89], ["90-91", 90, 91],
  ["92-93", 92, 93], ["94-95", 94, 95], ["96-97", 96, 97], ["98-99", 98, 99], [">=100", 100, null],
];

const pad = (n) => String(n).padStart(2, "0");
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

async function main() {
  const daysInMonth = new Date(Y, M, 0).getDate();
  // MOS window: 2 days before the 1st → 1 day after the last, to capture prior-day runs.
  const winStart = new Date(Date.UTC(Y, M - 1, 1) - 2 * 86400000);
  const winEnd = new Date(Date.UTC(Y, M - 1, daysInMonth) + 2 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 16) + "Z";

  console.log(`── G1 backtest · ${MONTH} · ${STATION_MOS} (Central Park) ──`);
  console.log(`fetching NBS MOS ${iso(winStart)}..${iso(winEnd)} + ASOS settled highs…`);
  const mosRows = await efc.fetchMosRows(STATION_MOS, iso(winStart), iso(winEnd));
  const settled = await efc.fetchSettledHighs(ASOS_STATION, NETWORK,
    { y: winStart.getUTCFullYear(), m: winStart.getUTCMonth() + 1, d: winStart.getUTCDate() },
    { y: winEnd.getUTCFullYear(), m: winEnd.getUTCMonth() + 1, d: winEnd.getUTCDate() }, OFFSET_H);
  console.log(`  MOS rows: ${mosRows.length} · settled days: ${settled.size}`);

  const days = [];
  const skipped = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${Y}-${pad(M)}-${pad(d)}`;
    const { members, runCount } = efc.timeLaggedEnsemble(mosRows, key, { offsetH: OFFSET_H });
    const settledHigh = settled.get(key);
    if (members.length < 3 || !Number.isFinite(settledHigh)) {
      skipped.push(`${key}(m=${members.length},settled=${settledHigh ?? "—"})`);
      continue;
    }
    days.push({
      ymd: key, members, ladder: LADDER, settledHigh,
      forecastHigh: median(members), leadDays: 1, month: M, day: d, runCount,
    });
  }

  const r = efc.backtestG1(days);
  console.log(`\ngraded days: ${days.length} (skipped ${skipped.length})`);
  console.log(`mean ensemble size: ${(days.reduce((s, x) => s + x.members.length, 0) / (days.length || 1)).toFixed(1)} members/day`);
  console.log(`\n── G1 RESULT ──`);
  console.log(`RPS (lower=better):  ensemble ${f(r.meanRPS.proxy)} · oracle ${f(r.meanRPS.oracle)} · climatology ${f(r.meanRPS.climatology)}`);
  console.log(`beats oracle: ${r.beatsOracle}   beats climatology: ${r.beatsClimo}`);
  console.log(`verdict: ${r.verdict}`);
  console.log(`report:  ${r.report}`);

  const out = path.resolve(__dirname, "../data/kalshi", `gencast-g1-${MONTH}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    month: MONTH, station: STATION_MOS, gradedDays: days.length, skipped,
    result: r, perDay: days.map((x) => ({ ymd: x.ymd, members: x.members.length, forecastHigh: x.forecastHigh, settledHigh: x.settledHigh })),
  }, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
}
const f = (x) => (x == null ? "—" : x.toFixed(4));

main().catch((e) => { console.error("G1 backtest failed:", e.message); process.exit(1); });
