/**
 * Kalshi stats — serves the SAME data the CIO collector is recording.
 *
 * Reads data/kalshi/price-snapshots.jsonl (built by experiments/kalshi_collect_loop),
 * takes the latest snapshot per ticker, groups MLB game markets by matchup, and
 * returns de-vigged moneyline odds plus how many snapshots have accumulated
 * (the trajectory length the CIO convergence model needs).
 *
 * Read-only. No auth, no orders. The running collector keeps the file fresh.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonlCached } = require("./jsonl-cache");

const SNAPSHOTS = path.resolve(__dirname, "..", "data", "kalshi", "price-snapshots.jsonl");

function fnum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @returns {{updatedAt:string, snapshotRounds:number, marketCount:number, games:Array}}
 */
function getKalshiStats() {
  if (!fs.existsSync(SNAPSHOTS)) {
    return { updatedAt: null, snapshotRounds: 0, marketCount: 0, games: [] };
  }

  // latest row + point-count per ticker
  const latest = {};   // ticker -> row
  const points = {};   // ticker -> count
  let updatedAt = "";
  // mtime-cached parse: the snapshots file is append-only (the collector loop
  // owns it), so re-reading + re-parsing every request was wasted work (#1889).
  for (const r of readJsonlCached(SNAPSHOTS)) {
    const t = r.ticker;
    if (!t) continue;
    points[t] = (points[t] || 0) + 1;
    if (!latest[t] || r.ts > latest[t].ts) latest[t] = r;
    if (r.ts > updatedAt) updatedAt = r.ts;
  }

  // group GAME moneyline markets by matchup (event key = ticker minus last seg)
  const games = {};
  for (const t of Object.keys(latest)) {
    if (!t.startsWith("KXMLBGAME")) continue;
    const r = latest[t];
    const ya = fnum(r.yes_ask), na = fnum(r.no_ask);
    if (ya <= 0 && na <= 0) continue;
    const seg = t.lastIndexOf("-");
    const eventKey = seg > 0 ? t.slice(0, seg) : t;
    const team = seg > 0 ? t.slice(seg + 1) : t;
    const yesPct = ya + na > 0 ? Math.round((ya / (ya + na)) * 100) : 0;
    if (!games[eventKey]) games[eventKey] = { event: eventKey, close: r.close_time || "", sides: [] };
    games[eventKey].sides.push({ team, yesPct, points: points[t] || 1 });
  }

  const list = Object.values(games)
    .map((g) => { g.sides.sort((a, b) => b.yesPct - a.yesPct); return g; })
    .sort((a, b) => String(a.close).localeCompare(String(b.close)));  // near-term first

  const snapshotRounds = Math.max(0, ...Object.values(points));
  return {
    updatedAt: updatedAt || null,
    snapshotRounds,
    marketCount: Object.keys(latest).length,
    games: list,
  };
}

module.exports = { getKalshiStats };
