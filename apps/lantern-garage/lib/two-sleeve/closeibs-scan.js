'use strict';
/**
 * lib/two-sleeve/closeibs-scan.js — the close-IBS sleeve as an engine sleeve's SCAN (2026-10-03, DRAFT: not armed).
 *
 * The internal-bar-strength effect at the close: an index fund that closes near the bottom of its session range tends to
 * recover by the next session. Measured on our own bar caches before any engine run (close_ibs_anatomy.js, ledger row
 * close-ibs-sleeve-engine): buy Mon-Thu at the close when the session IBS = (close - low) / (high - low) <= 0.15, sell at
 * the next session's first read >= 0.6 from 10:00, else at its close. Index ETFs earned +0.19% / +0.20% a trade net of the
 * live cost on the 13 recent windows / 30 older quarters, the 3x index longs +0.38% / +0.44%, positive in 10 of 13 years
 * and at every threshold from 0.05 to 0.40 (smaller as the threshold loosens). The stable sleeve never takes this setup
 * (its 15:00-16:00 entry block); the race sleeve takes part of it.
 *
 * This module only READS bars and says what the sleeve wants, in the signal shape the brains trade:
 *   - in the ENTRY WINDOW — Monday to Thursday, the session's latest COMPLETED 5m bar being the 15:45 or the 15:50 bar
 *     (so between 15:50:20 and 16:00 ET) — a name whose session IBS <= ibsMax is BULLISH / ENTER;
 *   - at any time, a name whose session IBS >= exitIbs is BEARISH / ENTER (the brain sells a held one; its IBS exit, its
 *     30-minute opening gate, its max hold and its weekend flat do the rest; the sleeve's env must set them);
 *   - otherwise NEUTRAL / SKIP, and no reading at all (no completed bar, a flat range) is NEUTRAL: a held name is held.
 * Every name is in every scan, so the feed guard never reads the sleeve as an absent symbol. No Friday entries: a Friday
 * close buy would ride the weekend, which the book never does. The replay of this rule is experiments/replay_two_sleeve_c.js
 * (sleeve C: clock 945-950 on the default clock = the 15:50 and 15:55 prices, the same two decision bars as here).
 */
const { sessionBars, etOf } = require('../trend-shadow');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;                 // a bar is read 20 s after it closes (feed lag), as the noise leg reads it
const DECISION_BARS = [945, 950];        // bar starts: the 15:45 bar (closes 15:50) and the 15:50 bar (closes 15:55)
const CLOSE_MIN = 960;                   // no entry decision at or after 16:00 ET

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function createCloseIbsScan({ symbols, getBars, ibsMax = 0.15, exitIbs = 0.6, decisionBars = DECISION_BARS } = {}) {
  const S = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (typeof getBars !== 'function') throw new Error('close-IBS scan: getBars(sym, tf) required');
  if (!(ibsMax > 0 && ibsMax < exitIbs)) throw new Error(`close-IBS scan: ibsMax ${ibsMax} must sit in (0, exitIbs ${exitIbs})`);

  async function rawOf(sym) {
    try { const r = await getBars(sym, '5m'); return (r && r.bars) || null; } catch (_e) { return null; }
  }

  /** One scan: { signals, closeIbs: { at, window, reads: [{ symbol, ibs, bar, why }] } }. Never throws. */
  async function scan(now = Date.now()) {
    const e = etOf(now);
    const dow = new Date(`${e.day}T12:00:00Z`).getUTCDay();     // 1 = Monday ... 5 = Friday
    const signals = [];
    const reads = [];
    let window = false;
    for (const sym of S) {
      const raw = await rawOf(sym);
      const done = raw ? sessionBars(raw, e.day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now) : [];
      const last = done.length ? done[done.length - 1] : null;
      const hi = done.length ? Math.max(...done.map((b) => b.h)) : null;
      const lo = done.length ? Math.min(...done.map((b) => b.l)) : null;
      const ibs = last && hi > lo ? (last.c - lo) / (hi - lo) : null;
      const inWindow = !!(last && dow >= 1 && dow <= 4 && decisionBars.includes(last.min) && e.min < CLOSE_MIN);
      if (inWindow) window = true;
      let direction = 'NEUTRAL', dec = 'SKIP';
      if (ibs != null && inWindow && ibs <= ibsMax) { direction = 'BULLISH'; dec = 'ENTER'; }
      else if (ibs != null && ibs >= exitIbs) { direction = 'BEARISH'; dec = 'ENTER'; }
      signals.push({
        symbol: sym, direction, entry_price: last ? last.c : null, price: last ? last.c : null, close_ibs: true,
        decision_context: { ibs: round(ibs, 3), spy_tape: 0, close_ibs_bar: last ? hhmm(last.min + 5) : null, close_ibs_window: inWindow },
        convergence: { decision: dec, p_win: 0.6 },
      });
      reads.push({ symbol: sym, ibs: round(ibs, 3), bar: last ? hhmm(last.min + 5) : null,
        why: !raw ? 'no bars' : !last ? 'no completed bar today' : ibs == null ? 'flat range' : undefined });
    }
    return { signals, closeIbs: { at: new Date(now).toISOString(), window, ibsMax, exitIbs, reads } };
  }

  return { symbols: S, scan };
}

module.exports = { createCloseIbsScan, DECISION_BARS, SETTLE_MS };
