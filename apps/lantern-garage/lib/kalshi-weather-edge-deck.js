"use strict";

/**
 * Σ₀ weather-edge deck — the Act-prep stage that turns the calibrated ceiling model
 * (kalshi-weather-edge) + the LIVE NWS forecast (kalshi-nws) + the LIVE Kalshi
 * KXHIGHNY board into swipe cards, in real time, with NO LLM and NO provider key.
 *
 * This replaces the never-completing LLM "grounded" path (which returned cards stuck
 * "pending" forever whenever a provider was unfunded) with a deterministic,
 * always-available, externally-grounded deck: every card's fair value comes from the
 * measured NWS-settled calibration, and an edge is shown only when it survives the
 * whole calibration band net of fees. Cards are emitted in the existing grounded-card
 * shape so the terminal renders them with zero UI changes. PAPER only — nothing here
 * places an order.
 */

const kalshi = require("./kalshi-api");
const nws = require("./kalshi-nws");
const model = require("./kalshi-weather-edge");

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const SOURCES = [
  "https://api.weather.gov/gridpoints/OKX/34,45/forecast",
  "https://www.weather.gov/media/okx/Climate/CentralPark/100DegreeDays.pdf",
];
const GROUNDING = "NWS OKX gridpoint forecast + NWS Daily Climatological Report (KNYC) settlement + NWS 100-Degree-Days record (last 100°F 2012-07-18)";

function dateFromTicker(ticker) {
  const m = String(ticker || "").match(/KXHIGHNY-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return { year: 2000 + parseInt(m[1], 10), month: mon, day: parseInt(m[3], 10) };
}

function minsToClose(m, nowMs) {
  const ct = m.close_time ? Date.parse(m.close_time) : NaN;
  return isFinite(ct) ? Math.round((ct - nowMs) / 60000) : null;
}

/** Build one grounded-shape card for an actionable (robust) edge row. */
function cardFor(m, row, ctx) {
  const yesAsk = m.yes_ask, noAsk = m.no_ask;
  const isNo = row.side === "no";
  const entry = isNo ? (noAsk != null ? noAsk : Math.round(100 - yesAsk)) : yesAsk;
  const pWinBucket = isNo ? 1 - row.fair : row.fair;   // model P(favoured side wins)
  const reward = 100 - (entry != null ? entry : 50);
  return {
    kind: "grounded", mode: "grounded",
    ticker: m.ticker,
    title: `NYC daily high · ${ctx.ymd} · ${m.yes_sub_title || m.subtitle || ""}`.trim(),
    yesPct: yesAsk,
    minsToClose: minsToClose(m, ctx.nowMs), close: m.close_time,
    rules: (m.rules_primary || "").slice(0, 240),
    marketFound: true,
    favSide: row.side, favLabel: row.side.toUpperCase(),
    favAsk: entry, entryCents: entry,
    conviction: Math.round((ctx.confidence || 0.6) * 100),
    grounding_status: "done", web_grounded: true,
    grounded_p_yes: Math.round(row.fair * 1000) / 1000,
    grounded_confidence: ctx.confidence,
    model: "Σ₀ weather-edge (calibrated NWS ceiling)",
    rationale: `NWS forecast ${ctx.fc}°F headline, but calibrated fair for this bucket is ${row.fair_pct}% — Central Park last reached 100°F on 2012-07-18 (2019/22/25 stalled at 99). Edge survives the full σ/mean calibration band net of fees.`,
    evidence: [
      { claim: `NWS forecast high ${ctx.fc}°F for ${ctx.ymd}`, source: SOURCES[0] },
      { claim: "≥100°F is a hard ceiling at KNYC (none since 2012-07-18)", source: SOURCES[1] },
    ],
    sources: SOURCES,
    stateLabel: "CONFIDENT",
    reason: `NWS ${ctx.fc}°F · calibrated fair ${row.fair_pct}% vs market ${row.ask_c}¢ → ${row.side.toUpperCase()} @ ${entry}¢ · worst-case +${Math.round(row.worst_c)}¢ net after fees`,
    grounding: GROUNDING,
    sigma0: {
      end_state: pWinBucket >= 0.5 ? row.side.toUpperCase() : (isNo ? "YES" : "NO"),
      p_win: Math.round(pWinBucket * 100) / 100,
      loss_odds: Math.round((1 - pWinBucket) * 100) / 100,
      ev_cents: Math.round(row.worst_c * 10) / 10,     // worst-case band edge = what you can rely on
      reward_cents: reward,
      confidence: ctx.confidence,
      score: Math.round(row.worst_c * 10) / 10,        // rank by reliable worst-case edge
      positive_ev: row.worst_c > 0,
      verdict: "STRONG",
    },
  };
}

/**
 * getWeatherEdgeDeck — live deterministic weather-edge cards, best (highest reliable
 * worst-case edge) first. Returns grounded-deck-shaped payload.
 */
async function getWeatherEdgeDeck({ limit = 12, minEdgeCents = 5, series = "KXHIGHNY" } = {}) {
  const nowMs = Date.now();
  const today = new Date(nowMs);

  // 1. Observe — live board + live NWS forecast (concurrent).
  let markets = [], highs = {};
  try {
    const [mkR, hi] = await Promise.all([
      kalshi.getMarkets({ series_ticker: series, status: "open", limit: 200 }),
      nws.getForecastHighs(series),
    ]);
    if (mkR && mkR.ok && mkR.data && Array.isArray(mkR.data.markets)) markets = mkR.data.markets;
    highs = hi || {};
  } catch (e) {
    return { cards: [], count: 0, grounded: 0, mode: "grounded", error: e.message,
      note: "Weather-edge deck: could not reach Kalshi/NWS.", generatedAt: new Date().toISOString() };
  }

  // 2. Group markets by settlement day.
  const byDay = new Map();
  for (const m of markets) {
    const d = dateFromTicker(m.ticker);
    if (!d) continue;
    const key = `${d.month}-${d.day}`;
    if (!byDay.has(key)) byDay.set(key, { d, markets: [] });
    byDay.get(key).markets.push(m);
  }

  const cards = [];
  const audit = [];
  const forecastMissing = [];
  for (const [key, grp] of byDay) {
    const fRec = highs[key];
    if (!fRec) { forecastMissing.push(key); audit.push(`${key}: no live NWS forecast — SKIP`); continue; }
    const fc = fRec.high;
    const dt = new Date(grp.d.year, grp.d.month - 1, grp.d.day);
    const lead = Math.round((dt - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);

    // 3. Build the ladder + asks from the live buckets.
    const ladder = [], ask = {};
    for (const m of grp.markets) {
      const band = model.parseBand(m.yes_sub_title || m.subtitle || "");
      if (!band || m.yes_ask == null) continue;
      ladder.push([m.ticker, band[0], band[1]]);
      ask[m.ticker] = m.yes_ask / 100;
    }
    if (!ladder.length) { audit.push(`${key}: no parseable buckets — SKIP`); continue; }

    // 4. Reason+Verify — band-robust net-of-fees gate.
    const rep = model.robustEdgeReport(fc, lead, ladder, ask, grp.d.month, grp.d.day, minEdgeCents);
    audit.push(`${grp.d.year}-${grp.d.month}-${grp.d.day} lead=${lead} NWS=${fc}°F -> ${rep.verdict}`);
    const ctx = { fc, ymd: fRec.ymd || `${grp.d.year}-${String(grp.d.month).padStart(2, "0")}-${String(grp.d.day).padStart(2, "0")}`,
      nowMs, confidence: 0.6 };
    for (const row of rep.actionable) {
      const m = grp.markets.find((x) => x.ticker === row.bucket);
      if (m) cards.push(cardFor(m, row, ctx));
    }
  }

  // 5. Rank by reliable worst-case edge (Σ₀ score), best first.
  cards.sort((a, b) => (b.sigma0?.score ?? -999) - (a.sigma0?.score ?? -999));

  const note = cards.length
    ? "Σ₀ weather-edge — live NWS-calibrated fair value vs market, band-robust net of fees. Deterministic (no LLM). PAPER only; live trading remains paused."
    : `Σ₀ weather-edge — no band-robust edge live right now (efficient board or milder forecast). Standing down is the correct output.${forecastMissing.length ? " (Some days lack a live NWS forecast.)" : ""}`;

  return {
    cards: cards.slice(0, limit),
    count: cards.length,
    grounded: cards.length,       // every card is externally grounded by construction
    knowledgeOnly: 0, pending: 0,
    positiveEv: cards.filter((c) => (c.sigma0?.ev_cents || 0) > 0).length,
    mode: "grounded",
    audit,
    generatedAt: new Date().toISOString(),
    note,
  };
}

module.exports = { getWeatherEdgeDeck, dateFromTicker, cardFor };
