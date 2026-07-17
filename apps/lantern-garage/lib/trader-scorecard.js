'use strict';

/**
 * trader-scorecard.js — MEASURE the stock autopilot's realized edge (Verify stage).
 *
 * The autopilot appends one `exit` row per closed long to autopilot-trades.jsonl,
 * each carrying the round-trip outcome: { symbol, pnl, pnl_pct, reason, status }.
 * This turns that raw log into an honest scorecard — win rate, expectancy, profit
 * factor, and a per-exit-reason breakdown — so a change to the exit logic (the 5m
 * momentum read, the ratcheting trail, an entry filter) can be judged on realized
 * P&L instead of vibes. Nothing here trades; it only reads and summarizes.
 *
 * HONESTY: exits are logged when the DECISION fires; the broker order may still be
 * `needs_confirmation`/`dry_run` rather than a confirmed fill. So we report BOTH a
 * headline over confirmed fills AND the full decisioned set, clearly labelled — we
 * never pass off an unconfirmed exit as booked cash.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');

// A confirmed fill is one the broker actually accepted/executed. Everything else
// (needs_confirmation, dry_run, error, null) is a DECISION the strategy made but
// that did not necessarily become real money.
const CONFIRMED = new Set(['placed', 'filled', 'submitted']);

/** Group a verbose reason string ("trailing_stop (−1.6% from peak …)") to its family. */
function reasonFamily(reason) {
  const r = String(reason || '').trim();
  const m = r.match(/^[a-z_]+/i);
  return (m && m[0]) || 'unknown';
}

// Profit-TAKING exits fire only while already in profit (auto-trader gates them on
// pnlPct > 0 / a positive target), so their win rate is ~100% BY CONSTRUCTION — a
// selection artifact, not an edge. Flag them so the per-reason win rate can't be
// misread. Only the RISK-capable exits (signal_exit, trailing_stop, stop) have a
// win rate that means anything.
const PROFIT_ONLY_REASONS = new Set(['momentum_died', 'take_profit']);

function _round(n) { return Math.round(n * 100) / 100; }

/**
 * Compute a scorecard from an array of exit rows. Pure + deterministic.
 * @param {Array<{pnl:number, pnl_pct:number, reason:string, symbol:string, status:string}>} exits
 */
function computeScorecard(exits) {
  const rows = (exits || []).filter((e) => e && typeof e.pnl === 'number' && Number.isFinite(e.pnl));
  const wins = rows.filter((e) => e.pnl > 0);
  const losses = rows.filter((e) => e.pnl < 0);
  const grossWin = wins.reduce((s, e) => s + e.pnl, 0);
  const grossLoss = losses.reduce((s, e) => s + e.pnl, 0); // negative
  const total = grossWin + grossLoss;

  // Per-exit-reason breakdown (which exit paths make vs lose money).
  const byReason = {};
  for (const e of rows) {
    const k = reasonFamily(e.reason);
    const b = byReason[k] || (byReason[k] = { trades: 0, wins: 0, pnl: 0 });
    b.trades += 1; b.wins += e.pnl > 0 ? 1 : 0; b.pnl = _round(b.pnl + e.pnl);
  }
  for (const k of Object.keys(byReason)) {
    byReason[k].winRate = byReason[k].trades ? _round((byReason[k].wins / byReason[k].trades) * 100) : 0;
    byReason[k].profitOnly = PROFIT_ONLY_REASONS.has(k);   // win rate here is structural, ignore it
  }

  // Risk-capable exits only (the ones that CAN lose) — the win rate that actually
  // reflects skill, unpolluted by the profit-taking exits' structural 100%.
  const risk = rows.filter((e) => !PROFIT_ONLY_REASONS.has(reasonFamily(e.reason)));
  const riskWins = risk.filter((e) => e.pnl > 0).length;

  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? _round((wins.length / rows.length) * 100) : 0,
    totalRealized: _round(total),
    avgWin: wins.length ? _round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? _round(grossLoss / losses.length) : 0,
    expectancy: rows.length ? _round(total / rows.length) : 0,   // avg $ per trade
    // Profit factor = gross wins / |gross losses|. Infinity when there are no losses.
    profitFactor: grossLoss < 0 ? _round(grossWin / Math.abs(grossLoss)) : (grossWin > 0 ? Infinity : 0),
    // The honest win rate: over exits that could have lost. Profit-taking exits
    // (momentum_died/take_profit) are excluded because they only ever close winners.
    riskExitTrades: risk.length,
    riskExitWinRate: risk.length ? _round((riskWins / risk.length) * 100) : 0,
    byReason,
  };
}

/** Read + parse the exit rows from a trades log (fail-soft → []). */
function readExits(logPath = DEFAULT_LOG) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (_e) { continue; }
    if (d && d.event === 'exit') out.push(d);
  }
  return out;
}

/**
 * Full scorecard from disk: a `confirmed` view (broker-accepted fills only — the
 * honest realized number) and an `all` view (every exit decision, incl. unconfirmed).
 */
function scorecard(logPath = DEFAULT_LOG) {
  const exits = readExits(logPath);
  const confirmed = exits.filter((e) => CONFIRMED.has(String(e.status || '').toLowerCase()));
  return {
    generatedAt: new Date().toISOString(),
    confirmed: computeScorecard(confirmed),   // broker-accepted fills — booked
    all: computeScorecard(exits),             // every exit decision — strategy view
    note: 'confirmed = broker-accepted fills (booked). all = every exit decision incl. needs_confirmation/dry_run (strategy view, not necessarily real money).',
  };
}

module.exports = { computeScorecard, readExits, scorecard, reasonFamily, DEFAULT_LOG };
