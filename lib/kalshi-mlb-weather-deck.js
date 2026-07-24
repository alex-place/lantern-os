"use strict";

/**
 * Paper KXMLBTOTAL weather-edge deck — the MLB run-total sibling of the Σ₀ KXHIGHNY
 * weather deck. Deterministic, no LLM, no provider key. PAPER ONLY: this deck is NOT in
 * the live scope (live stays code-locked to `kalshi-weather-edge`), and it places nothing.
 *
 * LOOP MAPPING (one Convergence Core, no new subsystem):
 *   Observe  — live KXMLBTOTAL board + NWS game-time conditions per ballpark.
 *   Reason   — kalshi-mlb-weather-model tilts the run total by wind/temp/roof/precip.
 *   Verify   — fire ONLY on weather tails (strong wind on a known axis, roof-state
 *              divergence, temp extreme, postponement risk); a Normal total model turns
 *              the tilt into P(over/under) vs the market price, net of fees, with a
 *              robustness haircut. Modal slate ⇒ stand down (correct output).
 *   Act      — paper card + append to the settled ledger so the ONE unknown (how much of
 *              the tilt the market leaves unpriced) can be MEASURED, not assumed.
 *
 * HONESTY: the residual fraction is an explicit, conservative assumption (n=0 settled).
 * Every card says so. This deck's job is to START the ledger, not to claim proven edge.
 */

const kalshi = require("./kalshi-api");
const parks = require("./kalshi-mlb-parks");
const wmodel = require("./kalshi-mlb-weather-model");
const nws = require("./kalshi-nws-point");
const { sizePosition } = require("./kalshi-kelly");
const { feeFraction } = require("./kalshi-fees");
const fs = require("fs");
const path = require("path");

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const LEDGER = path.resolve(__dirname, "..", "data", "kalshi", "mlb-weather-paper-ledger.jsonl");

// The one calibratable assumption: fraction of the physics tilt the market leaves
// unpriced on a TAIL signal. Conservative until the ledger can measure it.
const RESIDUAL_FRACTION = num(process.env.KALSHI_MLB_RESIDUAL_FRAC, 0.35);
const TOTAL_SD = num(process.env.KALSHI_MLB_TOTAL_SD, 3.0);   // empirical MLB game-total σ
const MIN_EDGE_CENTS = num(process.env.KALSHI_MLB_MIN_EDGE_C, 4);
const BANKROLL_CENTS = num(process.env.KALSHI_MLB_BANKROLL_C, 10000);

function num(v, d) { const f = parseFloat(v); return Number.isFinite(f) ? f : d; }

// Standard normal CDF (Abramowitz-Stegun 7.1.26 erf approximation).
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function pOver(line, mean, sd) { return 1 - normCdf((line - mean) / sd); }

/** Parse a KXMLBTOTAL ticker → { code, line, startIso } (times are ET / EDT in season). */
function parseTicker(ticker) {
  const m = String(ticker || "").match(/KXMLBTOTAL-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]{4,8})-([0-9.]+)/);
  if (!m) return null;
  const [, yy, mon, dd, hh, mm, code, line] = m;
  const mo = MONTHS[mon];
  if (!mo) return null;
  return { code, line: parseFloat(line), startIso: `20${yy}-${mo}-${dd}T${hh}:${mm}:00-04:00` };
}

/** Market-implied total = interpolated line where yes_ask crosses 50¢. */
function impliedTotal(ladder) {
  const s = ladder.filter((r) => r.yesAsk != null).sort((a, b) => a.line - b.line);
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (a.yesAsk >= 50 && b.yesAsk <= 50 && a.yesAsk !== b.yesAsk) {
      return round2(a.line + ((a.yesAsk - 50) / (a.yesAsk - b.yesAsk)) * (b.line - a.line));
    }
  }
  return null;
}

/**
 * Best paper hypothesis for one game: pick the ladder line + side whose model edge vs the
 * market price is largest, surviving fees and a robustness haircut. Returns null if none.
 */
function bestBet(ladder, fairMean, worstMean, tilt) {
  let best = null;
  for (const r of ladder) {
    if (r.yesAsk == null && r.noAsk == null) continue;
    const pO = pOver(r.line, fairMean, TOTAL_SD);
    const pOw = pOver(r.line, worstMean, TOTAL_SD);     // haircut mean for worst-case
    // OVER via yes_ask
    if (r.yesAsk != null && r.yesAsk >= 5 && r.yesAsk <= 95) {
      const edge = pO - r.yesAsk / 100;
      const worst = pOw - r.yesAsk / 100 - feeFraction(r.yesAsk);
      const cand = { side: "over", betSide: "yes", line: r.line, ask: r.yesAsk, spread: spread(r, "yes"),
        volume: r.vol, pModel: pO, edgeC: Math.round(edge * 100), worstC: Math.round(worst * 100) };
      if (tilt > 0 && (!best || cand.edgeC > best.edgeC)) best = cand;
    }
    // UNDER via no_ask
    if (r.noAsk != null && r.noAsk >= 5 && r.noAsk <= 95) {
      const pU = 1 - pO, pUw = 1 - pOw;
      const edge = pU - r.noAsk / 100;
      const worst = pUw - r.noAsk / 100 - feeFraction(r.noAsk);
      const cand = { side: "under", betSide: "no", line: r.line, ask: r.noAsk, spread: spread(r, "no"),
        volume: r.vol, pModel: pU, edgeC: Math.round(edge * 100), worstC: Math.round(worst * 100) };
      if (tilt < 0 && (!best || cand.edgeC > best.edgeC)) best = cand;
    }
  }
  if (!best || best.worstC < MIN_EDGE_CENTS) return null;
  return best;
}
function spread(r, side) {
  if (side === "yes") return r.yesAsk != null && r.yesBid != null ? r.yesAsk - r.yesBid : null;
  return r.noAsk != null && r.noBid != null ? r.noAsk - r.noBid : null;
}

/**
 * getMlbWeatherDeck — live paper cards for weather-tail MLB totals, best worst-case edge
 * first. Returns a grounded-deck-shaped payload (paper-only).
 */
async function getMlbWeatherDeck({ limit = 12, maxForecasts = 12 } = {}) {
  const nowMs = Date.now();
  let markets = [];
  try {
    const r = await kalshi.getMarkets({ series_ticker: "KXMLBTOTAL", status: "open", limit: 400 });
    if (r && r.ok && r.data && Array.isArray(r.data.markets)) markets = r.data.markets;
  } catch (e) {
    return deckError(e.message);
  }

  // Group by game; attach park; drop games we can't weather-ground (no park, or a
  // fixed dome where weather is fully neutralized — no card is ever possible).
  const games = new Map();
  for (const m of markets) {
    const p = parseTicker(m.ticker);
    if (!p) continue;
    if (!games.has(p.code)) {
      const park = parks.parkForGameCode(p.code);
      games.set(p.code, { code: p.code, startIso: p.startIso, park, close: m.close_time, ladder: [] });
    }
    games.get(p.code).ladder.push({
      line: p.line, ticker: m.ticker,
      yesAsk: m.yes_ask, yesBid: m.yes_bid, noAsk: m.no_ask, noBid: m.no_bid,
      vol: Number.isFinite(m.volume_24h) ? m.volume_24h : (Number.isFinite(m.volume) ? m.volume : null),
    });
  }

  const audit = [];
  const candidates = [];
  for (const g of games.values()) {
    if (!g.park) { audit.push(`${g.code}: no park mapping — SKIP`); continue; }
    if (g.park.roof === "fixed") { audit.push(`${g.code} @ ${g.park.name}: fixed dome — weather-neutral, SKIP`); continue; }
    const implied = impliedTotal(g.ladder);
    if (implied == null) { audit.push(`${g.code}: no 50¢ crossover — SKIP`); continue; }
    candidates.push({ ...g, implied });
  }

  // Fetch NWS conditions for the candidate games (bounded — respect weather.gov). Order by
  // soonest first pitch so the most actionable games get the forecast budget.
  candidates.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  const cards = [];
  let fetched = 0;
  for (const g of candidates) {
    if (fetched >= maxForecasts) { audit.push(`${g.code}: forecast budget spent — SKIP`); continue; }
    fetched++;
    const cond = await nws.getGameConditions(g.park.lat, g.park.lon, g.startIso);
    if (!cond) { audit.push(`${g.code} @ ${g.park.name}: no NWS forecast — SKIP`); continue; }
    const tilt = wmodel.weatherTiltRuns(cond, g.park);
    audit.push(`${g.code} @ ${g.park.name}: ${Math.round(cond.tempF)}°F wind ${Math.round(cond.windMph||0)}mph → tilt ${tilt.deltaRuns} (${tilt.direction}) tail=${tilt.tail}`);
    if (!tilt.tail || tilt.deltaRuns === 0) continue;

    const residual = tilt.deltaRuns * RESIDUAL_FRACTION;
    const fairMean = g.implied + residual;
    const worstMean = g.implied + residual * 0.5;         // robustness haircut
    const bet = bestBet(g.ladder, fairMean, worstMean, tilt.deltaRuns);
    if (!bet) { audit.push(`  ${g.code}: tail but no line survives fees/haircut — stand down`); continue; }

    const sizing = sizePosition({
      winProb: bet.pModel, askCents: bet.ask, worstCaseNetC: bet.worstC,
      spreadCents: bet.spread, volume: bet.volume, bankrollCents: BANKROLL_CENTS,
    });
    cards.push(buildCard(g, cond, tilt, bet, sizing, residual, fairMean, nowMs));
  }

  cards.sort((a, b) => (b.sigma0.score - a.sigma0.score));
  const note = cards.length
    ? `MLB totals weather scan — ${cards.length} weather-tail hypothes${cards.length === 1 ? "is" : "es"} on the live board. PAPER ONLY, NOT in live scope. Residual fraction ${RESIDUAL_FRACTION} is an unproven assumption (n=0 settled) — each card is logged to calibrate it.`
    : "MLB totals weather scan — no weather-tail edge on the live slate (calm/mild/roofed). Standing down is the correct output.";

  return {
    cards: cards.slice(0, limit),
    count: cards.length,
    mode: "paper", live: false, liveScope: "kalshi-weather-edge (MLB not included)",
    gamesScanned: candidates.length, forecastsFetched: fetched,
    residualFraction: RESIDUAL_FRACTION, totalSd: TOTAL_SD,
    audit, generatedAt: new Date().toISOString(), note,
  };
}

function buildCard(g, cond, tilt, bet, sizing, residual, fairMean, nowMs) {
  const minsToClose = g.close ? Math.round((Date.parse(g.close) - nowMs) / 60000) : null;
  const evidence = [
    { claim: `${g.park.name}: NWS ${Math.round(cond.tempF)}°F, wind ${Math.round(cond.windMph || 0)}mph ${cond.windFromDeg != null ? "from " + Math.round(cond.windFromDeg) + "°" : "(dir n/a)"}, precip ${Math.round(cond.precipProb * 100)}% at first pitch`, source: "api.weather.gov hourly (" + cond.grid + ")" },
    { claim: `weather tilt ${tilt.deltaRuns} runs (${tilt.direction}), dominant=${tilt.dominant}, roof=${tilt.roofState}`, source: "kalshi-mlb-weather-model" },
    { claim: `market-implied total ${g.implied} → weather-adj fair ${round2(fairMean)} (residual ${round2(residual)} @ frac ${RESIDUAL_FRACTION})`, source: "50¢ crossover + model" },
  ];
  const card = {
    kind: "grounded", mode: "paper", live: false,
    ticker: bet.betSide === "yes" ? tickerFor(g, bet.line) : tickerFor(g, bet.line),
    title: `${g.park.awayCode}@${g.park.homeCode} total runs · ${g.park.name}`,
    favSide: bet.betSide, favLabel: `${bet.side.toUpperCase()} ${bet.line}`,
    favAsk: bet.ask, entryCents: bet.ask, minsToClose, close: g.close,
    conviction: Math.round(tilt.confidence * 100),
    grounding_status: "done", web_grounded: true,
    model: "MLB totals weather (paper)",
    rationale: `${g.park.name}: ${tilt.notes.length ? tilt.notes.join("; ") + ". " : ""}Conditions tilt the total ${tilt.deltaRuns} runs ${tilt.direction} (wind ${tilt.components.wind}, temp ${tilt.components.temp}, precip ${tilt.components.precip}). Market implies ${g.implied}; assuming the book under-reacts by ${Math.round(RESIDUAL_FRACTION * 100)}% on this tail → fair ${round2(fairMean)} → ${bet.side.toUpperCase()} ${bet.line} @ ${bet.ask}¢ (model P=${(bet.pModel * 100).toFixed(0)}%).`,
    evidence,
    sources: ["api.weather.gov", "Kalshi KXMLBTOTAL board"],
    reason: `${g.park.name} · ${Math.round(cond.tempF)}°F wind ${Math.round(cond.windMph || 0)}mph · tilt ${tilt.deltaRuns} ${tilt.direction} · ${bet.side.toUpperCase()} ${bet.line} @ ${bet.ask}¢ · worst +${bet.worstC}¢ net · ${sizing.contracts > 0 ? `paper size ${sizing.contracts} (½-Kelly)` : `NO SIZE — ${sizing.blockedBy.join("/")}`}${tilt.postponeRisk ? " · ⚠ postpone risk" : ""}`,
    sizing: {
      contracts: sizing.contracts, stakeCents: sizing.stakeCents,
      gatesOk: sizing.gatesOk, blockedBy: sizing.blockedBy,
      kellyFraction: sizing.kellyFraction, feeAdjWinProb: sizing.feeAdjWinProb,
      liveContracts: 0, liveArmed: false,      // paper-only: never live
    },
    weather: { conditions: cond, tilt },
    pPredicted: Math.round(bet.pModel * 1000) / 1000,
    sigma0: {
      end_state: bet.side.toUpperCase(), p_win: Math.round(bet.pModel * 100) / 100,
      ev_cents: bet.worstC, reward_cents: 100 - bet.ask, confidence: tilt.confidence,
      contracts: sizing.contracts, score: bet.worstC, positive_ev: bet.worstC > 0,
      verdict: tilt.confidence >= 0.7 ? "STRONG" : tilt.confidence >= 0.55 ? "MODERATE" : "WEAK",
    },
  };
  logLedger(card, g, cond, tilt, bet, fairMean);
  return card;
}

function tickerFor(g, line) {
  const r = g.ladder.find((x) => x.line === line);
  return r ? r.ticker : `${g.code}-${line}`;
}

function logLedger(card, g, cond, tilt, bet, fairMean) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({
      ts: new Date().toISOString(), code: g.code, park: g.park.name, startIso: g.startIso,
      ticker: card.ticker, side: bet.side, line: bet.line, ask: bet.ask,
      implied: g.implied, fairMean: round2(fairMean), tiltRuns: tilt.deltaRuns,
      pModel: card.pPredicted, worstC: bet.worstC, confidence: tilt.confidence,
      residualFraction: RESIDUAL_FRACTION, conditions: cond,
      resolved: null, actualTotal: null,       // filled later by a grader for calibration
    }) + "\n");
  } catch { /* best-effort */ }
}

function deckError(msg) {
  return { cards: [], count: 0, mode: "paper", live: false, error: msg,
    note: "MLB weather deck: could not reach Kalshi.", generatedAt: new Date().toISOString() };
}
function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { getMlbWeatherDeck, parseTicker, impliedTotal, bestBet };
