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
 *
 * TWO CHOICES, BOTH OFF BY DEFAULT (2026-11-03, the design L25 + C1, ledger tier2-l25-gates-without-quiet-43-windows):
 *   ONE_DECISION_BAR  decide on the 15:50 bar alone (read from 15:55:20): passed as decisionBars, TRADER_CLOSE_IBS_ONE_BAR=1 in the worker.
 *   the news gate     newsGateDir, TRADER_CLOSE_IBS_NEWS_GATE=1 in the worker: no entry unless the session's SHOCK headlines rank HIGH or
 *                     the prior session's dealer gamma ranks LOW. C's trades on the other days netted about nothing across 2016-2026.
 * The gate reads the files lib/entry-tags.js keeps (TRADER_ENTRY_TAGS_DIR) at the first scan of the entry window and fetches nothing. It never
 * touches a sell read or a held name. A reading it cannot trust is no reading and the gate stays OPEN, the sleeve trading as it would without
 * it: no file, no row for the day, a count too old or under 30 minutes, gamma not yet updated. Each decision day gets one close_ibs_gate row.
 */
const { sessionBars, etOf } = require('../trend-shadow');
const { closeOffset } = require('../market-calendar');
const { readContext } = require('../entry-tags');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;                 // a bar is read 20 s after it closes (feed lag), as the noise leg reads it
const DECISION_BARS = [945, 950];        // bar starts: the 15:45 bar (closes 15:50) and the 15:50 bar (closes 15:55)
const ONE_DECISION_BAR = [950];          // the 15:50 bar alone
const CLOSE_MIN = 960;                   // no entry decision at or after 16:00 ET
const NEWS_MAX_AGE_MS = 90 * 60000;      // an older count is no reading (it refreshes hourly, and 10 minutes after a failure)
// On a 13:00 early close (lib/market-calendar.js) the decision bars and the cut-off move with the close: the 12:45 and
// 12:50 bars, nothing at or after 13:00. The after-hours prints that follow are not session bars (sessionBars).

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * The news gate at `now`: { open, why, shock, gamma }, both readings journaled as read. Closed only on two good readings: SHOCK not HIGH and gamma
 * not LOW. Never throws. `read` is a seam for tests.
 */
function newsGate(dir, now, read = readContext) {
  let gamma, news;
  try { ({ gamma, news } = read(dir, now)); } catch (e) { return { open: true, why: `no reading (${String((e && e.message) || e).slice(0, 120)})`, shock: null, gamma: null }; }
  const s = (news && news.session) || null;
  const sh = (s && s.types && s.types.SHOCK) || null;
  const ageMs = s && s.to ? now - Date.parse(s.to) : null;
  const shockWhy = !s ? (news && news.why) || 'no news reading'
    : ageMs == null || !(ageMs <= NEWS_MAX_AGE_MS) ? `the news count runs to ${s.to || 'nothing'}`
      : !sh || !sh.tercile ? (news.types_why || s.why || 'no SHOCK rank') : null;
  const shockT = shockWhy ? null : sh.tercile;
  const gammaT = (gamma && gamma.tercile) || null;
  const out = {
    shock: sh ? { tercile: sh.tercile, rank: sh.rank, n: sh.n, to: s.to, ...(shockWhy ? { why: shockWhy } : {}) } : { tercile: null, why: shockWhy },
    gamma: gammaT ? { tercile: gammaT, rank: gamma.rank, as_of: gamma.as_of } : { tercile: null, why: (gamma && gamma.why) || 'no gamma reading' },
  };
  if (shockT === 'HIGH' || gammaT === 'LOW') return { open: true, why: [shockT === 'HIGH' && 'SHOCK HIGH', gammaT === 'LOW' && 'gamma LOW'].filter(Boolean).join(', '), ...out };
  if (!shockT || !gammaT) return { open: true, why: `no reading: ${[shockWhy, !gammaT && out.gamma.why].filter(Boolean).join('; ')}`, ...out };
  return { open: false, why: `SHOCK ${shockT}, gamma ${gammaT}`, ...out };
}

function createCloseIbsScan({ symbols, getBars, ibsMax = 0.15, exitIbs = 0.6, decisionBars = DECISION_BARS, newsGateDir = null, log = null } = {}) {
  const S = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (typeof getBars !== 'function') throw new Error('close-IBS scan: getBars(sym, tf) required');
  if (!(ibsMax > 0 && ibsMax < exitIbs)) throw new Error(`close-IBS scan: ibsMax ${ibsMax} must sit in (0, exitIbs ${exitIbs})`);
  let gateDay = null, gateRead = null;   // the day's one gate decision: read once, at the first scan of its entry window

  async function rawOf(sym) {
    try { const r = await getBars(sym, '5m'); return (r && r.bars) || null; } catch (_e) { return null; }
  }

  /** One scan: { signals, closeIbs: { at, window, reads: [{ symbol, ibs, bar, why }] } }. Never throws. */
  async function scan(now = Date.now()) {
    const e = etOf(now);
    const dow = new Date(`${e.day}T12:00:00Z`).getUTCDay();     // 1 = Monday ... 5 = Friday
    const signals = [];
    const reads = [];
    const offered = [], refused = [];
    let window = false, gate = null, firstReadBar = null;
    for (const sym of S) {
      const raw = await rawOf(sym);
      const done = raw ? sessionBars(raw, e.day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now) : [];
      const last = done.length ? done[done.length - 1] : null;
      const hi = done.length ? Math.max(...done.map((b) => b.h)) : null;
      const lo = done.length ? Math.min(...done.map((b) => b.l)) : null;
      const ibs = last && hi > lo ? (last.c - lo) / (hi - lo) : null;
      const off = closeOffset(e.day);
      const inWindow = !!(last && dow >= 1 && dow <= 4 && decisionBars.some((m) => m - off === last.min) && e.min < CLOSE_MIN - off);
      if (inWindow) window = true;
      if (inWindow && newsGateDir && !gate) {
        if (gateDay !== e.day) { gateDay = e.day; gateRead = newsGate(newsGateDir, now); firstReadBar = hhmm(last.min + 5); }
        gate = gateRead;
      }
      let direction = 'NEUTRAL', dec = 'SKIP', gated = false;
      if (ibs != null && inWindow && ibs <= ibsMax) {
        if (gate && !gate.open) { gated = true; refused.push(sym); }
        else { direction = 'BULLISH'; dec = 'ENTER'; offered.push(sym); }
      } else if (ibs != null && ibs >= exitIbs) { direction = 'BEARISH'; dec = 'ENTER'; }
      signals.push({
        symbol: sym, direction, entry_price: last ? last.c : null, price: last ? last.c : null, close_ibs: true,
        decision_context: { ibs: round(ibs, 3), spy_tape: 0, close_ibs_bar: last ? hhmm(last.min + 5) : null, close_ibs_window: inWindow },
        convergence: { decision: dec, p_win: 0.6 },
      });
      reads.push({ symbol: sym, ibs: round(ibs, 3), bar: last ? hhmm(last.min + 5) : null,
        why: !raw ? 'no bars' : !last ? 'no completed bar today' : ibs == null ? 'flat range' : gated ? `news gate: ${gate.why}` : undefined });
    }
    if (firstReadBar && typeof log === 'function') {
      try { log({ event: 'close_ibs_gate', day: e.day, at: new Date(now).toISOString(), bar: firstReadBar, open: gate.open, why: gate.why, shock: gate.shock, gamma: gate.gamma, offered, refused }); } catch (_e) { /* journal only */ }
    }
    return { signals, closeIbs: { at: new Date(now).toISOString(), window, ibsMax, exitIbs, reads, ...(gate ? { gate } : {}) } };
  }

  return { symbols: S, scan };
}

module.exports = { createCloseIbsScan, newsGate, DECISION_BARS, ONE_DECISION_BAR, NEWS_MAX_AGE_MS, SETTLE_MS };
