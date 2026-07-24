"use strict";

/**
 * Grounded event-market suggester — fetch → filter → ground → fee-aware EV gate.
 *
 * This is the Reason+Act-prep stage for the grounded Kalshi trader. It targets
 * GROUNDABLE event markets (weather first — daily high-temp, ~1-day resolution,
 * NWS-tied rules, forecastable) instead of efficient crypto noise, grounds each in
 * external reality (kalshi-grounding), and ranks by fee-aware expected value
 * (kalshi-fees) so the best risk-adjusted position leads.
 *
 * Grounding is SLOW (~20s/market: web search + LLM), so the deck renders instantly
 * from cache and kicks off background grounding for the misses — the swipe terminal
 * polls and picks up grounded cards as they complete. Bounded + cached to respect
 * Gemini quota. Nothing here places an order.
 */

const kalshi = require("./kalshi-api");
const fees = require("./kalshi-fees");
const grounding = require("./kalshi-grounding");

// Weather daily high-temp series — the proof-of-concept universe (forecastable,
// resolves in ~1 day). Expandable: any Kalshi event series with populated rules.
const WEATHER_SERIES = [
  "KXHIGHNY", "KXHIGHCHI", "KXHIGHLAX", "KXHIGHMIA", "KXHIGHDEN",
  "KXHIGHAUS", "KXHIGHPHIL", "KXHIGHDC", "KXHIGHHOU", "KXHIGHATL",
];

function _minsToClose(m, nowMs) {
  const ct = m.close_time ? Date.parse(m.close_time) : NaN;
  return isFinite(ct) ? Math.round((ct - nowMs) / 60000) : null;
}

// Groundable = researchable + near-term + tradeable band + single-outcome.
function isGroundableEventMarket(m, nowMs) {
  const ct = m.close_time ? Date.parse(m.close_time) : NaN;
  if (!isFinite(ct)) return false;
  const days = (ct - nowMs) / 86400000;
  if (days < 0.04 || days > 14) return false;          // ~1h .. 14d
  if (!(m.rules_primary || "").trim()) return false;    // need a YES condition to research
  if ((m.ticker || "").startsWith("KXMV")) return false; // skip multivariate parlays
  const ya = m.yes_ask;                                  // cents (normalized)
  if (ya == null || ya < 10 || ya > 90) return false;    // priced, not already resolved
  return true;
}

async function fetchCandidates(series, perSeries) {
  const out = [];
  await Promise.all(series.map(async (s) => {
    try {
      const r = await kalshi.getMarkets({ series_ticker: s, status: "open", limit: perSeries });
      if (r && r.ok && r.data && Array.isArray(r.data.markets)) out.push(...r.data.markets);
    } catch { /* skip series */ }
  }));
  return out;
}

// Build a swipe card from a market + its grounding (or a pending placeholder).
function toCard(m, g, nowMs) {
  const ya = m.yes_ask, na = m.no_ask;
  const yesPct = ya != null ? ya : null;
  const minsToClose = _minsToClose(m, nowMs);
  const base = {
    kind: "grounded", mode: "grounded",
    ticker: m.ticker, title: m.title,
    yesPct, minsToClose, close: m.close_time,
    rules: (m.rules_primary || "").slice(0, 240),
    marketFound: true,
  };

  if (!g || g.p_yes == null) {
    return {
      ...base, favSide: "yes", favLabel: "YES", favAsk: ya, conviction: 0,
      grounding_status: g && g.grounded === false ? "unavailable" : "pending",
      stateLabel: "", reason: "Grounding in progress — web research pending…",
    };
  }

  const pYes = g.p_yes;

  // KNOWLEDGE-ONLY estimate (no live web sources): the External-Reality rule says we
  // can't assert an edge over the market on model memory / climatology alone. Show the
  // estimate, but defer to the market — no edge claimed, not counted as actionable.
  if (!g.web_grounded) {
    const favYes = (yesPct ?? 50) >= 50;
    return {
      ...base,
      favSide: favYes ? "yes" : "no", favLabel: favYes ? "YES" : "NO",
      favAsk: favYes ? ya : na, entryCents: favYes ? ya : na,
      conviction: Math.round((g.confidence || 0.3) * 100),
      grounding_status: "knowledge-only",
      grounded_p_yes: pYes, grounded_confidence: g.confidence, rationale: g.rationale,
      evidence: g.evidence || [], sources: g.sources || [], model: g.model,
      stateLabel: "",
      reason: `⚠ No live sources — knowledge-only estimate P(YES) ${Math.round(pYes * 100)}% (market ${yesPct}%). Deferring to market; tap Re-ground for live data.`,
      sigma0: {
        score: -999, end_state: favYes ? "YES" : "NO", p_win: null, loss_odds: null,
        ev_cents: null, reward_cents: null, confidence: g.confidence, verdict: "UNVERIFIED",
      },
    };
  }

  // WEB-GROUNDED: fee-aware EV gate — take the side with the higher net EV after fees.
  const evYes = ya != null ? fees.netEvCents(ya, pYes) : -999;
  const evNo = na != null ? fees.netEvCents(na, 1 - pYes) : -999;
  const yesBetter = evYes >= evNo;
  const side = yesBetter ? "yes" : "no";
  const entry = yesBetter ? ya : na;
  const ev = yesBetter ? evYes : evNo;
  const pWin = yesBetter ? pYes : 1 - pYes;
  const edge = Math.round((pWin - (entry || 50) / 100) * 100); // grounded edge, cents

  return {
    ...base,
    favSide: side, favLabel: side.toUpperCase(), favAsk: entry, entryCents: entry,
    conviction: Math.round((g.confidence || 0.5) * 100),
    grounding_status: "done", web_grounded: true,
    grounded_p_yes: pYes, grounded_confidence: g.confidence, rationale: g.rationale,
    evidence: g.evidence || [], sources: g.sources || [], model: g.model,
    stateLabel: ev > 0 ? "CONFIDENT" : "DETERMINED",
    reason: `Grounded P(YES) ${Math.round(pYes * 100)}% vs market ${yesPct}% → ${side.toUpperCase()} · edge ${edge >= 0 ? "+" : ""}${edge}¢ · EV ${ev >= 0 ? "+" : ""}${ev}¢/contract`,
    sigma0: {
      score: ev, end_state: pYes >= 0.5 ? "YES" : "NO", p_win: Math.round(pWin * 100) / 100,
      loss_odds: Math.round((1 - pWin) * 100) / 100, ev_cents: ev, reward_cents: 100 - (entry || 50),
      confidence: g.confidence, verdict: ev > 0 ? "STRONG" : "SKIP_NEG_EV",
    },
  };
}

let _groundingActive = false;

/**
 * getGroundedSuggestions — returns grounded event cards, sorted best-EV first.
 * Renders instantly from cache; fires a bounded background grounding pass for misses.
 */
async function getGroundedSuggestions({ limit = 12, maxGround = 6, perSeries = 8, series = WEATHER_SERIES } = {}) {
  const nowMs = Date.now();
  const cands = (await fetchCandidates(series, perSeries)).filter((m) => isGroundableEventMarket(m, nowMs));
  // de-dup by ticker, soonest-to-close first (fastest forward validation)
  const seen = new Set();
  const uniq = [];
  for (const m of cands) { if (!seen.has(m.ticker)) { seen.add(m.ticker); uniq.push(m); } }
  uniq.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  const pool = uniq.slice(0, Math.max(limit, maxGround));

  const cards = [];
  const ungrounded = [];
  for (const m of pool) {
    const g = grounding.peek(m.ticker);
    cards.push(toCard(m, g, nowMs));
    if (!g) ungrounded.push(m);
  }

  // fire-and-forget background grounding for the misses. Concurrency 1: the live
  // googleSearch grounding free-tier 429s under parallel load and silently drops to a
  // knowledge-only guess — serial keeps more estimates actually web-grounded.
  if (ungrounded.length && !_groundingActive) {
    _groundingActive = true;
    grounding.groundMany(ungrounded.slice(0, maxGround), { concurrency: 1 })
      .catch(() => {})
      .finally(() => { _groundingActive = false; });
  }

  // sort: web-grounded actionable +EV (best first), then web-grounded ≤EV, then
  // knowledge-only / pending (no edge claimed) last.
  const rank = (c) => c.grounding_status === "done" ? 0 : c.grounding_status === "knowledge-only" ? 1 : 2;
  cards.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.sigma0?.ev_cents ?? -1000) - (a.sigma0?.ev_cents ?? -1000);
  });

  const webGrounded = cards.filter((c) => c.grounding_status === "done");
  return {
    cards: cards.slice(0, limit),
    count: cards.length,
    grounded: webGrounded.length,                                   // web-grounded (actionable)
    knowledgeOnly: cards.filter((c) => c.grounding_status === "knowledge-only").length,
    pending: cards.filter((c) => c.grounding_status === "pending").length,
    positiveEv: webGrounded.filter((c) => (c.sigma0?.ev_cents || 0) > 0).length,
    grounding: _groundingActive,
    mode: "grounded",
    generatedAt: new Date().toISOString(),
    note: "Grounded event markets — live web-researched P(YES) vs market price, fee-aware EV. Knowledge-only estimates (no live sources) defer to the market. PAPER only; live trading remains paused.",
  };
}

module.exports = { getGroundedSuggestions, isGroundableEventMarket, toCard, WEATHER_SERIES };
