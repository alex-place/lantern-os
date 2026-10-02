'use strict';
/**
 * lib/two-sleeve/noise-scan.js — the noise-area momentum leg as an engine sleeve's SCAN (2026-10-02).
 *
 * The leg the replay measured (experiments/replay_two_sleeve.js REPLAY_M_NOISE; ledger rows noise-leg-engine-13-windows,
 * noise-leg-engine-30-unseen-quarters, live-engine-plus-noise-leg): the noise area of Zarattini, Aziz and Barbon
 * (2024, SSRN 4824172) on a proxy, traded through its 3x wrappers. sigma(m) = the mean over the 14 prior sessions of
 * |close(m) / open - 1|; upper = max(open, prevClose) x (1 + sigma), lower = min(open, prevClose) x (1 - sigma).
 * The band itself is lib/trend-shadow.js noiseBand(), the same code the journal-only noise shadow runs.
 *
 * This module only READS bars and says what the leg wants, in the signal shape the brains already trade:
 *   - at a DECISION bar (the bars closing 10:00, 10:30 ... 15:30), within ENTRY_WINDOW_MS of its close, the wrapper on
 *     the proxy's side of the band is BULLISH / ENTER (the long wrapper above the band, the inverse below);
 *   - whenever the proxy's latest completed bar is back inside the band, or through to the other side, BOTH wrappers
 *     of the pair are BEARISH / ENTER: a held one is sold at once (the brain's signal exit; the sleeve's env must make
 *     that exit immediate: TRADER_PERSIST_SCANS=1, TRADER_EXIT_MIN_PWIN=0);
 *   - otherwise NEUTRAL / SKIP. No reading (no band yet, a feed gap) is NEUTRAL: a held wrapper is held.
 * The brain does the rest with its own machinery: the 8% stop (TRADER_STOP_MIN_PCT), the 15:50 sale (the de-carry),
 * the sizing (risk-based), the ownership bridge (a wrapper another sleeve holds is refused). Every wrapper of every
 * pair is in every scan, so the feed guard never reads the leg as an absent symbol.
 *
 * One deviation from the replay, stated: the replay waited for a FLAT pair before an entry (a pair flipping from above
 * to below its band inside one decision interval sold the long wrapper at that bar and bought the inverse at the NEXT
 * decision). The scan does not know the sleeve's positions, so on such a flip it offers both the exit and the entry in
 * the same window; the brain's direction lock and one-position-per-symbol rule still apply.
 */
const { noiseBand, sessionBars, parseNoisePairs, NOISE_DECISIONS, etOf } = require('../trend-shadow');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;              // a bar is read 20 s after it closes (feed lag), as the shadow reads it
const ENTRY_WINDOW_MS = 3 * 60000;    // an entry is offered only within 3 minutes of its decision bar's close
const CLOSE_MIN = 950;                // 15:50 ET: the brain's de-carry sells the leg; no decision at or after it
// The live 5m feed holds ~14 sessions (lib/market-data-yahoo.js MAX_BARS incl. extended hours); the band needs 15.
// A settled window 7 to 28 calendar days back is merged under it (#3720, the same fix as the shadow).
const HISTORY_FROM_DAYS = 28;
const HISTORY_TO_DAYS = 7;

const tOf = (b) => Date.parse(b.timestamp != null ? b.timestamp : b.t);
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function createNoiseScan({ pairs, getBars, getHistory = null, entryWindowMs = ENTRY_WINDOW_MS } = {}) {
  const P = Array.isArray(pairs) ? pairs : parseNoisePairs(pairs);
  if (typeof getBars !== 'function') throw new Error('noise scan: getBars(sym, tf) required');
  const histCache = new Map();   // `${sym}:${day}` -> { bars, tries }

  async function historyOf(sym, day) {
    if (typeof getHistory !== 'function') return [];
    const key = `${sym}:${day}`;
    let h = histCache.get(key) || { bars: null, tries: 0 };
    if (h.bars == null && h.tries < 3) {
      const dayStart = Date.parse(`${day}T12:00:00Z`);
      let bars = null;
      try { const r = await getHistory(sym, dayStart - HISTORY_FROM_DAYS * 86400000, dayStart - HISTORY_TO_DAYS * 86400000); bars = (r && r.bars) || null; } catch (_e) { bars = null; }
      h = { bars: bars && bars.length ? bars : null, tries: h.tries + 1 };
      histCache.set(key, h);
    }
    return h.bars || [];
  }
  function merge(older, recent) {
    if (!older.length) return recent;
    const seen = new Set(); const out = [];
    for (const b of [...older, ...recent]) { const t = tOf(b); if (!Number.isFinite(t) || seen.has(t)) continue; seen.add(t); out.push(b); }
    return out.sort((a, b) => tOf(a) - tOf(b));
  }
  async function rawOf(sym) {
    try { const r = await getBars(sym, '5m'); return (r && r.bars) || null; } catch (_e) { return null; }
  }
  /** The wrapper's latest completed price and its session IBS (for the brain's journal and sizing). */
  async function wrapperRead(sym, day, now) {
    const raw = await rawOf(sym);
    const bars = raw ? sessionBars(raw, day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now) : [];
    if (!bars.length) return { px: null, ibs: null };
    const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l)), c = bars[bars.length - 1].c;
    return { px: c, ibs: hi > lo ? round((c - lo) / (hi - lo), 3) : null };
  }

  /** One scan: { signals, noise: { at, pairs: [{ proxy, state, bar, upper, lower, decision, why }] } }. Never throws. */
  async function scan(now = Date.now()) {
    const e = etOf(now);
    const signals = [];
    const read = [];
    for (const pr of P) {
      let raw = await rawOf(pr.proxy);
      let why = raw ? null : 'no proxy bars';
      raw = merge(await historyOf(pr.proxy, e.day), raw || []);
      const done = sessionBars(raw, e.day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now);
      const last = done.length ? done[done.length - 1] : null;
      const band = raw.length ? noiseBand(raw, e.day) : { why: why || 'no bars' };
      const lim = last && band.at ? band.at(last.min) : null;
      if (!lim && !why) why = band.why || (last ? 'no band at this bar' : 'no completed bar today');
      const state = lim ? (last.c > lim.upper ? 'up' : last.c < lim.lower ? 'dn' : 'in') : null;
      const decision = !!(last && state && state !== 'in' && NOISE_DECISIONS.includes(last.min) && last.min < CLOSE_MIN
        && now - (last.t + BAR_MS) <= entryWindowMs);
      for (const [sym, side] of [[pr.up, 'up'], [pr.dn, 'dn']]) {
        const w = await wrapperRead(sym, e.day, now);
        let direction = 'NEUTRAL', dec = 'SKIP';
        if (state && state !== side) { direction = 'BEARISH'; dec = 'ENTER'; }              // back inside, or through: sell a held one
        else if (decision && state === side) { direction = 'BULLISH'; dec = 'ENTER'; }      // a decision bar outside the band on this side
        signals.push({
          symbol: sym, direction, entry_price: w.px, price: w.px, noise_leg: true,
          decision_context: { ibs: w.ibs, spy_tape: 0, noise: state, noise_proxy: pr.proxy, noise_side: side,
            noise_bar: last ? hhmm(last.min + 5) : null, noise_decision: decision },
          convergence: { decision: dec, p_win: 0.6 },
        });
      }
      read.push({ proxy: pr.proxy, state, bar: last ? hhmm(last.min + 5) : null, close: last ? round(last.c) : null,
        upper: lim ? round(lim.upper) : null, lower: lim ? round(lim.lower) : null, decision, why: why || undefined });
    }
    return { signals, noise: { at: new Date(now).toISOString(), pairs: read } };
  }

  return { pairs: P, scan };
}

module.exports = { createNoiseScan, ENTRY_WINDOW_MS, CLOSE_MIN };
