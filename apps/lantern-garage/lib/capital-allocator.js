'use strict';

/**
 * capital-allocator.js — ONE book over the trader sleeves (loop stage: Converge).
 *
 * The engines (intraday scanner, overnight sleeve book, options bridge) each had a
 * static env cap; nothing above them owned the whole risk budget. This module is
 * that owner: it reads each sleeve's OWN live ledger and assigns the account's
 * capital by MEASURED evidence — the operator's "one book, one allocator" directive
 * (2026-07-26). It is also the concrete "traders working as a team" mechanism:
 * every sleeve's evidence and the shared market regime flow through one decision.
 *
 * Method (established math, no novelty): Kelly-lite fractional sizing —
 *   raw_i = max(0, mu_i / sigma_i^2)  shrunk by evidence  min(1, n_i / minN_i)
 * normalized under per-sleeve CAPS, with an EXPLORATION FLOOR for unproven sleeves
 * (they must keep collecting evidence — the anti-collapse leg) and a REGIME DAMPER:
 * when the shared SPY regime read says downtrend, the intraday sleeve (whose
 * measured edge is long-biased and OOS-unproven) is pinned to its floor.
 *
 * Pure math + ledger reads only. It PLACES NOTHING and never overrides an engine's
 * own safety gates — engines ask budgetFor() and stay free to use less. Explicit
 * env caps (OVERNIGHT_ALLOC_PCT etc.) still win, so the operator can always pin.
 *
 * The CHAMPION is deliberately NOT a sleeve here: it is an INVESTOR on its own
 * dedicated account (see champion-book.js / alpaca-adapter CHAMPION_USER) — the
 * allocator only governs the TRADING account.
 */

const MIN_N = { intraday: 30, overnight: 20, options: 30 };
const CAP_PCT = { intraday: 20, overnight: 60, options: 1 };   // of equity (options = premium)
const FLOOR_PCT = { intraday: 2, overnight: 5, options: 0.25 }; // exploration budget while unproven

/** One sleeve's evidence → a non-negative Kelly-lite score. Pure. */
function sleeveScore({ n = 0, avg = 0, sd = 0 }, minN) {
  if (!(n > 0) || !(sd > 0)) return 0;
  const kelly = Math.max(0, avg / (sd * sd));           // per-night fraction (Kelly)
  return kelly * Math.min(1, n / Math.max(1, minN));    // shrink by evidence depth
}

/**
 * allocate({ equity, evidence, regime }) → per-sleeve budgets.
 *   evidence: { intraday|overnight|options: { n, avg, sd } } — avg/sd in DECIMAL
 *     per-trade returns from each sleeve's own live ledger.
 *   regime:  'up' | 'down' | null (the shared SPY read — team information).
 * Pure and deterministic; returns pct-of-equity and dollars per sleeve + why.
 */
function allocate({ equity = 0, evidence = {}, regime = null } = {}) {
  const out = { equity, regime, sleeves: {}, cash_pct: 100 };
  const scores = {};
  for (const s of Object.keys(CAP_PCT)) {
    const ev = evidence[s] || { n: 0, avg: 0, sd: 0 };
    scores[s] = sleeveScore(ev, MIN_N[s]);
    out.sleeves[s] = { evidence: ev, score: +scores[s].toFixed(4) };
  }
  // Regime damper: the intraday sleeve is long-biased and OOS-unproven — in a
  // downtrend it gets its floor only, regardless of its (in-sample) score.
  if (regime === 'down') scores.intraday = 0;

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  let used = 0;
  for (const s of Object.keys(CAP_PCT)) {
    const proven = (evidence[s] && evidence[s].n >= MIN_N[s] && evidence[s].avg > 0);
    let pct;
    if (totalScore > 0 && scores[s] > 0) {
      // Proportional Kelly-lite share of a 100% budget, capped per sleeve.
      pct = Math.min(CAP_PCT[s], (scores[s] / totalScore) * 100);
      pct = Math.max(pct, FLOOR_PCT[s]);        // never starve an active sleeve fully
    } else {
      // Unproven / zero-score sleeves keep only the exploration floor.
      pct = FLOOR_PCT[s];
    }
    if (regime === 'down' && s === 'intraday') pct = FLOOR_PCT.intraday;
    pct = +pct.toFixed(2);
    out.sleeves[s].pct = pct;
    out.sleeves[s].usd = +(equity * pct / 100).toFixed(2);
    out.sleeves[s].proven = !!proven;
    out.sleeves[s].why = proven
      ? `ledger-proven (n=${evidence[s].n} ≥ ${MIN_N[s]}, avg>0) — Kelly-lite share, cap ${CAP_PCT[s]}%`
      : (regime === 'down' && s === 'intraday')
        ? 'regime damper: SPY downtrend → exploration floor only'
        : `unproven (n=${(evidence[s] && evidence[s].n) || 0} < ${MIN_N[s]} or avg≤0) → exploration floor ${FLOOR_PCT[s]}%`;
    used += pct;
  }
  out.cash_pct = +Math.max(0, 100 - used).toFixed(2);
  return out;
}

// ── ledger readers (each sleeve's OWN live evidence — the shared-info bus) ────
function _overnightEvidence() {
  try {
    const ot = require('./overnight-trader');
    const fs = require('fs');
    const rows = fs.readFileSync(ot.LEDGER, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter((r) => r && r.phase === 'exit' && Number.isFinite(r.pl_pct_est));
    const rets = rows.map((r) => r.pl_pct_est / 100);
    return _mvs(rets);
  } catch (_e) { return { n: 0, avg: 0, sd: 0 }; }
}
function _optionsEvidence() {
  try {
    const os_ = require('./options-shadow');
    const m = os_.status().measured || {};
    const o = m.overall || m;
    // The shadow reports pct-of-premium; scale to pct-of-allocated-premium terms.
    return { n: o.n || 0, avg: (o.avg_pl_pct_of_premium || 0) / 100, sd: (o.sd_pl_pct_of_premium || 100) / 100 };
  } catch (_e) { return { n: 0, avg: 0, sd: 0 }; }
}
function _intradayEvidence() {
  try {
    const { scorecard } = require('./trader-scorecard');
    const sc = scorecard();
    const rows = (sc && (sc.confirmed || sc.all)) || [];
    const rets = rows.map((r) => Number(r.pl_pct)).filter(Number.isFinite).map((x) => x / 100);
    return _mvs(rets);
  } catch (_e) { return { n: 0, avg: 0, sd: 0 }; }
}
function _mvs(rets) {
  const n = rets.length;
  if (!n) return { n: 0, avg: 0, sd: 0 };
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1)) || 0;
  return { n, avg: +avg.toFixed(5), sd: +sd.toFixed(5) };
}
/** Shared regime read (SPY vs SMA50 + MACD — the same math the sleeves use). */
async function _regime() {
  try {
    const yahoo = require('./market-data-yahoo');
    const r = await yahoo.getBars('SPY', '1d');
    const closes = ((r && r.bars) || []).map((b) => b.close).filter((x) => x > 0);
    if (closes.length < 70) return null;
    const ot = require('./overnight-trader');
    // fadeGate/capitulationGate both key on the downtrend condition — reuse the
    // engine's own exported gate rather than re-deriving.
    const g = ot.uptrendGate(closes, 'any');
    return g.pass ? 'up' : 'down';
  } catch (_e) { return null; }
}

/** Live allocation for the trading account: evidence + regime + equity → budgets. */
async function currentAllocation({ equity = null } = {}) {
  let eq = equity;
  if (eq == null) {
    try {
      const alpaca = require('./alpaca-adapter');
      const a = await alpaca.getAccount('local-owner').catch(() => null);
      eq = (a && (Number(a.equity) || Number(a.portfolio_value))) || 100000;
    } catch (_e) { eq = 100000; }
  }
  const [regime] = await Promise.all([_regime()]);
  return allocate({
    equity: eq,
    regime,
    evidence: { intraday: _intradayEvidence(), overnight: _overnightEvidence(), options: _optionsEvidence() },
  });
}

/** Engine hook: the allocator's pct for one sleeve (explicit env caps still win in
 *  the engine — this is the DEFAULT the engine uses when the operator didn't pin). */
async function budgetPctFor(sleeve) {
  const a = await currentAllocation();
  return (a.sleeves[sleeve] && a.sleeves[sleeve].pct) || FLOOR_PCT[sleeve] || 0;
}

module.exports = { allocate, sleeveScore, currentAllocation, budgetPctFor, MIN_N, CAP_PCT, FLOOR_PCT };
