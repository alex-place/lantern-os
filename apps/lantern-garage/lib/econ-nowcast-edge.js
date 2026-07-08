"use strict";

/**
 * Econ-nowcast edge — MEASUREMENT harness, not a claimed edge (#2222).
 *
 * Kalshi econ contracts (CPI, jobs, Fed, GDP) settle on the authoritative BLS/Fed print —
 * the same "target === settlement source" structure that makes the weather oracle work.
 * BUT these markets are deep, liquid, and heavily modeled, and public nowcasts (Cleveland
 * Fed inflation nowcast, Atlanta Fed GDPNow) are very likely ALREADY PRICED IN. That is a
 * HEURISTIC, not an established fact — so this module treats the nowcast as a hypothesis to
 * MEASURE against the market-implied probability, and refuses to call it an edge until it
 * demonstrably beats the market after fees. Expected outcome: thin / no edge. Same discipline
 * that stopped us fooling ourselves on crypto 15-min.
 *
 * There is deliberately NO trading path here. `buildNowcast` is an unwired source stub so
 * nobody mistakes a placeholder for a live signal.
 *
 * Record contract: { nowcastP:0..1, marketP:0..1, outcome:0|1 } — one settled event each,
 * where marketP is the pre-settlement market-implied YES and outcome is what actually printed.
 */

const { kalshiFeeCents } = require("./kalshi-weather-edge");

const MIN_SAMPLES = 20; // no verdict below this — same n>=20 bar as the weather verifier

const clamp01 = (p) => Math.max(0, Math.min(1, p));

/** Mean Brier score (lower = better calibrated). */
function brier(records, key) {
  const rs = records.filter((r) => r && Number.isFinite(r[key]) && (r.outcome === 0 || r.outcome === 1));
  if (!rs.length) return null;
  return rs.reduce((s, r) => s + (clamp01(r[key]) - r.outcome) ** 2, 0) / rs.length;
}

/**
 * Net EV (cents/contract) of trading the NOWCAST against the market. On each event we take
 * the side the nowcast favours vs the market ask, pay the entry + fee, and settle at 100/0.
 * A contract's YES ask ≈ marketP (in cents). Buying YES when nowcastP > marketP:
 *   EV = 100·outcome − 100·marketP − fee. Buying NO when nowcastP < marketP:
 *   EV = 100·(1−outcome) − 100·(1−marketP) − fee. Only counts events where the nowcast
 * actually disagrees with the market by > `minDisagree`.
 */
function netEvCents(records, { feeCents = kalshiFeeCents, minDisagree = 0.02 } = {}) {
  let n = 0, total = 0;
  for (const r of records) {
    if (!r || !Number.isFinite(r.nowcastP) || !Number.isFinite(r.marketP)) continue;
    if (r.outcome !== 0 && r.outcome !== 1) continue;
    const edge = r.nowcastP - r.marketP;
    if (Math.abs(edge) <= minDisagree) continue;
    n++;
    if (edge > 0) {            // nowcast says YES is underpriced → buy YES at marketP
      total += 100 * r.outcome - 100 * clamp01(r.marketP) - feeCents(r.marketP);
    } else {                  // nowcast says YES is overpriced → buy NO at (1−marketP)
      total += 100 * (1 - r.outcome) - 100 * clamp01(1 - r.marketP) - feeCents(1 - r.marketP);
    }
  }
  return { n, evCentsPerContract: n ? total / n : null, totalCents: total };
}

/**
 * The go/no-go gate. Trades ONLY if, over n≥MIN_SAMPLES settled events, the nowcast is
 * better calibrated than the market (lower Brier) AND trading it nets positive after fees.
 * Any shortfall → stand down. Default posture is NO EDGE; the burden is on the data.
 */
function measureEdge(records = [], opts = {}) {
  const rs = records.filter((r) => r && (r.outcome === 0 || r.outcome === 1));
  const n = rs.length;
  const brierNowcast = brier(rs, "nowcastP");
  const brierMarket = brier(rs, "marketP");
  const ev = netEvCents(rs, opts);

  if (n < MIN_SAMPLES) {
    return {
      n, active: false, verdict: "insufficient-data",
      brierNowcast, brierMarket, evCentsPerContract: ev.evCentsPerContract,
      report: `n=${n} settled events (need ${MIN_SAMPLES}) — no verdict; stand down.`,
    };
  }
  const betterCalibrated = brierNowcast != null && brierMarket != null && brierNowcast < brierMarket;
  const netsPositive = ev.evCentsPerContract != null && ev.evCentsPerContract > 0;
  const tradeable = betterCalibrated && netsPositive;
  return {
    n, active: true, verdict: tradeable ? "demonstrated-edge" : "no-demonstrated-edge",
    tradeable,
    brierNowcast, brierMarket, betterCalibrated,
    evCentsPerContract: ev.evCentsPerContract, disagreements: ev.n, netsPositive,
    report: tradeable
      ? `nowcast beats market: Brier ${brierNowcast.toFixed(4)} < ${brierMarket.toFixed(4)} and +${ev.evCentsPerContract.toFixed(2)}c/contract after fees over ${ev.n} disagreements.`
      : `no demonstrated edge — ${betterCalibrated ? "" : "not better-calibrated; "}${netsPositive ? "" : "not net-positive after fees; "}stand down (expected outcome).`,
  };
}

/** Source stub — NOT wired. Building the actual nowcast (Cleveland Fed inflation nowcast,
 *  Atlanta Fed GDPNow, etc.) needs external egress + a per-series adapter; do that behind
 *  the market-data client, then feed measureEdge. Throws so a placeholder is never mistaken
 *  for a live signal. */
function buildNowcast(_series) {
  throw new Error("econ-nowcast source not wired — measure against market-implied first (#2222)");
}

module.exports = { brier, netEvCents, measureEdge, buildNowcast, MIN_SAMPLES };
