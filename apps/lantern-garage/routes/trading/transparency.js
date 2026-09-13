'use strict';
/**
 * routes/trading/transparency.js — the glass-factory dashboard's data feed (#3598).
 *
 * Loop stage: Verify. One read-only GET that assembles the trader's honesty
 * surface from files that already exist — nothing here is computed fresh or
 * promised, it is the record as written:
 *
 *   - the PREDICTION LEDGER (data/trading/prediction-ledger.jsonl, #3473): every
 *     backtest/lab verdict as a scored prediction, per-instrument hit rates,
 *     reversals included. The point of the page is that the misses stay visible.
 *   - the autopilot journal's SESSION rows (equity / day P&L / exits-by-reason):
 *     live fills, not backtest curves.
 *
 *   GET /api/trading/transparency → { generatedAt, scoreboard, outcomes,
 *     open_predictions, recent_verdicts, discipline, equity_strip, today }
 *
 * Same exposure class as routes/trading/scorecard.js — strategy/market math and
 * the operator's paper-book aggregates, no per-user or auth-sensitive data — so
 * it ships gated like its siblings; the public-vs-Pro decision (#3598) is a
 * one-line flip later, not a rewrite.
 */

const fs = require('fs');
const path = require('path');

const LEDGER = process.env.TRADER_PREDICTION_LEDGER
  || path.join(__dirname, '..', '..', '..', '..', 'data', 'trading', 'prediction-ledger.jsonl');
const JOURNAL = process.env.TRADER_TRADES_LOG
  || path.join(__dirname, '..', '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');

const BAD = new Set(['REVERSED', 'MISLEADING', 'INVALIDATED_BY_FIDELITY']);

function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) { return []; }
}

function ledgerView(rows, now = Date.now()) {
  const by = {};
  const outcomes = {};
  for (const r of rows) {
    const b = (by[r.instrument || '?'] = by[r.instrument || '?'] || { instrument: r.instrument || '?', n: 0, confirmed: 0, bad: 0, open: 0 });
    b.n++;
    const o = r.outcome || 'OPEN';
    outcomes[o] = (outcomes[o] || 0) + 1;
    if (o === 'CONFIRMED') b.confirmed++;
    else if (BAD.has(o)) b.bad++;
    else if (o === 'OPEN') b.open++;
  }
  const scoreboard = Object.values(by).map((b) => ({
    ...b, hit_rate: (b.confirmed + b.bad) > 0 ? Math.round(100 * b.confirmed / (b.confirmed + b.bad)) : null,
  })).sort((a, b) => b.n - a.n);
  const open_predictions = rows.filter((r) => (r.outcome || 'OPEN') === 'OPEN')
    .map((r) => ({ id: r.id, instrument: r.instrument, change: String(r.change || '').slice(0, 120), prediction: String(r.prediction || '').slice(0, 200), due: r.due || null }))
    .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
  const recent_verdicts = rows.filter((r) => r.scored)
    .sort((a, b) => String(b.scored).localeCompare(String(a.scored))).slice(0, 8)
    .map((r) => ({ id: r.id, instrument: r.instrument, outcome: r.outcome, scored: r.scored, evidence: String(r.evidence || '').slice(0, 240) }));
  const weekAgo = new Date(now - 7 * 864e5).toISOString().slice(0, 10);
  const discipline = {
    rows_total: rows.length,
    open: open_predictions.length,
    scored_last_7d: rows.filter((r) => r.scored && String(r.scored) >= weekAgo).length,
    reversals_total: rows.filter((r) => BAD.has(r.outcome)).length,
  };
  return { scoreboard, outcomes, open_predictions, recent_verdicts, discipline };
}

function journalView(rows) {
  const sessions = rows.filter((r) => r.event === 'session' && r.date && Number.isFinite(Number(r.equity)));
  const strip = sessions.slice(-15).map((s) => ({ date: s.date, equity: Math.round(Number(s.equity)), day_pnl: Math.round(Number(s.day_pnl) || 0) }));
  const last = sessions[sessions.length - 1] || null;
  const today = last ? {
    date: last.date, entries: last.entries ?? null, exits: last.exits ?? null,
    day_pnl: Math.round(Number(last.day_pnl) || 0), exits_by_reason: last.exits_by_reason || {},
    stops_fired: last.stops_fired ?? null,
  } : null;
  return { equity_strip: strip, today };
}

module.exports = async function transparencyRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/transparency' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    const ledger = ledgerView(readJsonl(LEDGER));
    const journal = journalView(readJsonl(JOURNAL));
    sendJson(res, { generatedAt: new Date().toISOString(), ...ledger, ...journal }, 200);
  } catch (e) {
    sendJson(res, { error: 'transparency_failed', reason: e.message }, 500);
  }
  return true;
};

module.exports._forTest = { ledgerView, journalView };
