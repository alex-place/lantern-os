'use strict';

/**
 * trader-convergence.js — the stock autopilot's Verify/Converge stage.
 *
 * Every entry the trader makes is already a Convergence Record in everything
 * but name: a hypothesis ("this setup reaches R1 before its stop"), evidence
 * (IBS, p_win, room_r, tier, volume ratio), a confidence (p_win), and — a few
 * hours later — a result the market hands back for free. The stock autopilot
 * had never written one, across 118 entries and 24 sessions.
 *
 * WHAT THE STORE ACTUALLY LOOKED LIKE (measured 2026-08-14, 1,804 records in
 * data/convergence/records.jsonl — it is busy, not empty):
 *
 *   • the stock autopilot contributes ZERO
 *   • the only trader rows are 120 from `trader-sigma0`, crypto Σ₀ EV signals
 *     that stopped on 2026-07-03 — a different engine, six weeks cold
 *   • verified=true on 0 of 1,804 — the Verify stage has never once closed
 *     with a receipt, in the whole history of the store
 *
 * That last line is the real gap. Records were being written and never graded.
 *
 * WHY A TRADE FIXES IT: the honesty problem that made ~88% of live records thin
 * — unfalsifiable claims, `verified:true` with nothing to check — does not
 * arise here. The hypothesis names a price and a deadline, so it is refutable
 * by construction, and the verification artifact is a broker fill. `exec:<order_id>`
 * is as hard as evidence gets, and emitConvergenceRecord's own gate demands
 * exactly that before it will let `verified` stand. These should be the first
 * verified records the system has ever held.
 *
 * Uses the EXISTING store (lib/convergence-records.js — the same one the Kalshi
 * side grades into outcomes.jsonl) rather than opening a second one.
 *
 * Emission is best-effort throughout. A convergence record must never be able
 * to break or delay a trade — every call is wrapped, and a failure returns null.
 */

const { emitConvergenceRecord } = require('./convergence-records');

const n2 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '?');

/**
 * A redirected trade ledger with a NON-redirected record store is a test rig,
 * and emitting would write fixtures into the live convergence memory.
 *
 * This is not hypothetical: the first test run after #3286 shipped put 51
 * invented trades into production — "GLD long 19 @ 100.00", "NVDA @ 180.00",
 * "X @ 100.00" — indistinguishable downstream from real ones. Relying on every
 * future test to remember CONVERGENCE_RECORDS_FILE is exactly the kind of
 * discipline that fails silently, so the default is refusal: redirect the ledger
 * and you must redirect the records too, or nothing is written.
 *
 * Checked per call rather than cached, because tests set these vars at runtime.
 */
function _wouldPolluteLiveStore() {
  return !!process.env.TRADER_TRADES_LOG && !process.env.CONVERGENCE_RECORDS_FILE;
}

/**
 * symbol -> the open claim, so an exit can be graded against what was actually
 * predicted (target1, and the record it answers).
 *
 * Deliberately in-memory and best-effort: a restart loses the link, and an exit
 * then grades on what its own ledger row carries (entry, exit, pnl, reason),
 * which is still a complete outcome — only `target1_reached` degrades to null.
 * Persisting this would put a convergence concern into the trading hot path's
 * state file for a field that is nice to have, not load-bearing.
 */
const openHypotheses = new Map();

/**
 * State the entry as a falsifiable claim.
 *
 * "SOXS long 1490 @ 38.92 (tier B, IBS entry, p_win 0.57): reaches target1
 *  40.95 (+5.2%) before its 37.75 stop (-3.0%)"
 *
 * Returns the emitted record (with `.id`) or null.
 */
async function recordEntryHypothesis(entry = {}) {
  if (_wouldPolluteLiveStore()) return null;
  const sym = String(entry.symbol || '').toUpperCase();
  if (!sym) return null;
  const px = Number(entry.entry);
  const t1 = Number(entry.target1);
  const stop = Number(entry.stop);
  if (!(px > 0)) return null;

  const upPct = t1 > 0 ? ((t1 - px) / px) * 100 : null;
  const dnPct = stop > 0 ? ((stop - px) / px) * 100 : null;

  // A claim is only falsifiable if it names a real level. With no target1 the
  // old text read "reaches target1 0.00", which is not a hypothesis anyone can
  // grade — say what is actually being claimed instead.
  const goal = t1 > 0
    ? `reaches target1 ${n2(t1)}${upPct != null ? ` (${upPct >= 0 ? '+' : ''}${upPct.toFixed(1)}%)` : ''}`
    : 'closes profitably (no target1 set)';
  const risk = stop > 0
    ? ` before its stop ${n2(stop)}${dnPct != null ? ` (${dnPct.toFixed(1)}%)` : ''}`
    : ' (no protective stop recorded)';
  const hypothesis = `${sym} long ${entry.qty ?? '?'} @ ${n2(px)}`
    + ` (tier ${entry.tier || '?'}, p_win ${entry.p_win != null ? Number(entry.p_win).toFixed(3) : '?'}):`
    + ` ${goal}${risk}`;

  // The measured inputs the decision was actually made on — so a later reader
  // can tell a good call from a lucky one.
  const evidence = [
    `ibs_entry:${sym}`,
    entry.p_win != null ? `p_win:${Number(entry.p_win).toFixed(3)}` : null,
    entry.room_r != null ? `room_r:${entry.room_r}` : null,
    entry.vol_ratio != null ? `vol_ratio:${entry.vol_ratio}` : null,
    entry.spy_1d != null ? `spy_1d:${entry.spy_1d}` : null,
    entry.tier ? `tier:${entry.tier}` : null,
  ].filter(Boolean);

  const rec = await emitConvergenceRecord({
    hypothesis,
    evidence_ids: evidence,
    applied_evidence: evidence,
    // p_win is the engine's own stated probability. Using anything else here
    // would make the record unfalsifiable against its own forecast.
    confidence: Number(entry.p_win) || 0.5,
    reasoner: 'stock-autopilot',
    source: 'autopilot-trades.jsonl',
    verified: false,          // the market has not answered yet
    grounding_signals: evidence,
  });
  openHypotheses.set(sym, {
    cr_id: rec && rec.id, entry: px, target1: t1, stop,
    ts: rec ? rec.timestamp : new Date().toISOString(),
  });
  return rec;
}

/**
 * Grade the hypothesis once the position is closed. The broker fill is the
 * verification artifact, so this is the rare record that can legitimately
 * claim verified=true.
 */
async function recordExitOutcome(exit = {}, openedArg = null) {
  if (_wouldPolluteLiveStore()) return null;
  const sym = String(exit.symbol || '').toUpperCase();
  if (!sym) return null;
  // Prefer the claim we actually made; fall back to the exit row's own entry
  // price, which every exit carries.
  //
  // NOT deleted here. Exits are frequently PARTIAL — GLD closed 66 shares across
  // three fills on 2026-08-13 — and dropping the claim on the first one would
  // leave the rest ungraded against their own target. The entry for a symbol
  // simply overwrites it, so the map stays bounded by the watchlist.
  const opened = openedArg || openHypotheses.get(sym) || { entry: exit.entry };
  const pnl = Number(exit.pnl);
  const px = Number(exit.exit);
  const t1 = Number(opened.target1);
  const won = Number.isFinite(pnl) ? pnl > 0 : null;
  const hitTarget = t1 > 0 && px > 0 ? px >= t1 : null;

  const hypothesis = `${sym} long opened @ ${n2(opened.entry)} closed @ ${n2(px)}`
    + `: ${won === null ? 'outcome unknown' : won ? 'WON' : 'LOST'}`
    + `${Number.isFinite(pnl) ? ` ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}` : ''}`
    + ` via ${String(exit.reason || 'unknown').split('(')[0].trim()}`
    + `${hitTarget === null ? '' : hitTarget ? ' — target1 reached' : ' — target1 NOT reached'}`;

  // Only a real fill is a receipt. A decisioned-but-unconfirmed exit stays
  // unverified, matching how trader-scorecard.js separates the two.
  const filled = exit.status === 'filled' || exit.source === 'fill';
  const artifacts = [];
  if (filled && exit.order_id) artifacts.push(`exec:${exit.order_id}`);

  return emitConvergenceRecord({
    hypothesis,
    evidence_ids: [
      `exit_reason:${String(exit.reason || 'unknown').split('(')[0].trim()}`,
      Number.isFinite(pnl) ? `pnl:${pnl.toFixed(2)}` : null,
      Number.isFinite(Number(exit.pnl_pct)) ? `pnl_pct:${Number(exit.pnl_pct).toFixed(2)}` : null,
      opened.cr_id ? `hypothesis:${opened.cr_id}` : null,
    ].filter(Boolean),
    result: {
      won,
      pnl: Number.isFinite(pnl) ? pnl : null,
      exit_price: Number.isFinite(px) ? px : null,
      reason: exit.reason || null,
      target1_reached: hitTarget,
      opened_at: opened.ts || null,
    },
    // The outcome is a fact, not a forecast.
    confidence: won === null ? 0.5 : 1,
    reasoner: 'stock-autopilot',
    source: 'autopilot-trades.jsonl',
    verified: artifacts.length > 0,
    verified_by: artifacts,
    verification_notes: filled
      ? 'closed by a confirmed broker fill'
      : 'exit decisioned but fill unconfirmed — outcome not receipted',
  });
}

module.exports = { recordEntryHypothesis, recordExitOutcome };
