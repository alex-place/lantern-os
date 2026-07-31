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
// `take_profit_R` belongs here too: it fires at a POSITIVE R-multiple target, so it
// can only ever close a winner. It was missing, so its structural 100% was counted
// into riskExitWinRate — the one number that is supposed to be honest. On the dev
// ledger that alone reported "riskExitWinRate 100%" off 5 profit-taking exits.
const PROFIT_ONLY_REASONS = new Set(['momentum_died', 'take_profit', 'take_profit_R']);

// Statuses where NO position change occurred, so no P&L was realized. An exit the
// broker rejected is an attempt, not a trade — counting it fabricates both a trade
// and its P&L. On the dev ledger one unclosable 0.8-share SOXS remnant re-decided 44
// times, each row booking ~+$9: 44 phantom wins and ~$400 of P&L that never existed.
const NO_FILL_STATUSES = new Set(['error', 'frozen', 'rejected', 'cancelled', 'canceled']);

function _round(n) { return Math.round(n * 100) / 100; }

/**
 * Collapse re-decisions of the SAME open position into one round-trip.
 *
 * An exit row is written when the decision fires, and a decision that doesn't
 * actually flatten the position fires again on the next scan — same symbol, same
 * avg entry, same qty, each row re-booking the position's whole unrealized P&L as
 * if it were realized. One 838.8-share SOXS position produced five `placed` rows
 * worth ~$86k of profit that never existed; the same position later produced 44
 * more as an unclosable remnant.
 *
 * A genuine re-entry that reproduces an 8-decimal average entry price AND the exact
 * share count is not a thing that happens, so keying on (symbol, entry, qty) is safe.
 * The LAST row wins — it's the decision closest to the real outcome.
 */
function dedupeRoundTrips(rows) {
  const lastIdxFor = new Map();
  rows.forEach((e, i) => {
    const entry = Number(e.entry);
    const qty = Number(e.qty);
    // No entry/qty to key on → can't prove it's a duplicate, so keep it.
    const key = (Number.isFinite(entry) && Number.isFinite(qty))
      ? `${String(e.symbol || '').toUpperCase()}|${entry.toFixed(6)}|${qty}`
      : `__unique_${i}`;
    lastIdxFor.set(key, i);
  });
  const keep = new Set(lastIdxFor.values());
  return rows.filter((_e, i) => keep.has(i));
}

/**
 * Compute a scorecard from an array of exit rows. Pure + deterministic.
 * @param {Array<{pnl:number, pnl_pct:number, reason:string, symbol:string, status:string}>} exits
 */
function computeScorecard(exits) {
  const priced = (exits || []).filter((e) => e && typeof e.pnl === 'number' && Number.isFinite(e.pnl));
  // Drop the attempts that never moved a position — they realized nothing. Reported
  // separately as failedAttempts so the exclusion is visible, not silent.
  const failedAttempts = priced.filter((e) => NO_FILL_STATUSES.has(String(e.status || '').toLowerCase()));
  const filled = priced.filter((e) => !NO_FILL_STATUSES.has(String(e.status || '').toLowerCase()));
  const rows = dedupeRoundTrips(filled);
  const duplicateExits = filled.length - rows.length;
  // Reconstructed rows: a position that left the book with no autopilot exit (a
  // protective stop filling, a manual close). Valued from the last observed mark
  // rather than a broker fill — real outcomes, estimated prices.
  const estimated = rows.filter((e) => e.estimated === true || String(e.status || '').toLowerCase() === 'reconstructed');
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
    // Attempts the broker never filled — excluded from every number above.
    failedAttempts: failedAttempts.length,
    // Re-decisions of an already-open position, collapsed into their round-trip.
    duplicateExits,
    // How much of the above is priced off a last-observed mark instead of a fill.
    estimatedTrades: estimated.length,
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
    note: 'confirmed = broker-accepted fills (booked). all = every exit decision incl. needs_confirmation/dry_run/reconstructed (strategy view, not necessarily real money). Rejected/frozen attempts realize nothing and are excluded from both — see failedAttempts. estimatedTrades are external closes (a protective stop filling, a manual close) valued off the last observed mark, not a broker fill.',
  };
}

module.exports = { computeScorecard, readExits, scorecard, reasonFamily, DEFAULT_LOG };
