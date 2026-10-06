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
 *
 * THE LATE-REVERSAL GATE, JOURNAL-ONLY (2026-10-05; operator: "build the journal-only shadow in the leg's scan"). The leg
 * sells at 15:50. From the 15:30 price to the 15:55 price the wrappers on the day's side REVERSE the day's move on the
 * 2022-2026 windows (-0.06% a session) and CONTINUE it on 2016-2021 (+0.04 to +0.07%). Selling the leg at 15:30 every day
 * is therefore a regime trade-off (ledger leg-closeout-1530-engine-30-quarters: 2018 turns negative); selling at 15:30
 * only while the pair's proxy has been reversing lately is not (ledger leg-early-sale-late-reversal-gate-engine-13-windows
 * and -30-quarters: +0.319 -> +0.366 and +0.140 -> +0.153 %/wk, worst weeks unchanged, every calendar year still
 * positive). The gate: the mean over the previous 60 sessions of sign(15:30 price / previous close - 1) x (15:55 price /
 * 15:30 price - 1) is negative. Its 2018 margin is thin (+0.4%), so it is journaled first and trades nothing. With
 * TRADER_NOISE_LATE_GATE_SHADOW=1 the scan keeps one observation per session per proxy in a state file, bootstrapped from
 * the settled history the feed can serve (about 40 sessions) and grown by one a day, and writes per proxy and session:
 *   late_gate_shadow   at the first read after the 15:30 bar: what the gate says (from sessions BEFORE today, 40- and
 *                      60-session means), the band state, and both wrappers' prices at that bar (the sale the rule would
 *                      make; the brain's 15:50 exit rows give the other leg of the comparison);
 *   late_drift_shadow  once the 15:55 bar is in: the day's own observation.
 * Signals are untouched by it.
 */
const { noiseBand, sessionBars, parseNoisePairs, NOISE_DECISIONS, etOf } = require('../trend-shadow');
const fs = require('fs');
const path = require('path');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;              // a bar is read 20 s after it closes (feed lag), as the shadow reads it
const ENTRY_WINDOW_MS = 3 * 60000;    // an entry is offered only within 3 minutes of its decision bar's close
const CLOSE_MIN = 950;                // 15:50 ET: the brain's de-carry sells the leg; no decision at or after it
// The live 5m feed holds ~14 sessions (lib/market-data-yahoo.js MAX_BARS incl. extended hours); the band needs 15.
// A settled window 7 to 28 calendar days back is merged under it (#3720, the same fix as the shadow).
const HISTORY_FROM_DAYS = 28;
const HISTORY_TO_DAYS = 7;
// The late-reversal gate (journal-only): the bar closing 15:30 (start 925) and the bar closing 15:55 (start 950).
const LATE_FROM_MIN = 925;
const LATE_TO_MIN = 950;
const LATE_LOOKBACKS = [40, 60];      // both reported: 60 is the rule the engine replay confirmed, 40 what the feed's reach allows at once
const LATE_MIN_FRAC = 0.8;            // 48 of 60 sessions before the 60-session reading exists
const LATE_KEEP = 400;                // observations kept per proxy in the state file
// The older settled history, merged once a day under the scan's own 28 -> 7 day window, fetched in SLICES: the 5m feed's
// reach is under 60 calendar days (a window starting 60 days back comes back empty, 58 works) and one call returns at
// most ~2,600 bars (~13-14 sessions with extended hours), so the single 70 -> 28 day window of the first build returned
// NOTHING live (dry rehearsal 2026-10-06) and the state could only grow by one session a day. Two slices of 17-18
// calendar days reach ~25 sessions; with the scan's own ~18 that is the 40-session reading from the first day.
const LATE_BOOT_SLICES = [[57, 40], [40, 22]];   // [from, to] in calendar days before the day

const tOf = (b) => Date.parse(b.timestamp != null ? b.timestamp : b.t);
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function createNoiseScan({ pairs, getBars, getHistory = null, entryWindowMs = ENTRY_WINDOW_MS, lateGate = null } = {}) {
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
  // ---- the late-reversal gate, journal-only (see the header). Nothing here touches a signal.
  const late = lateGate && typeof lateGate === 'object' ? lateGate : null;
  const lateLog = late && typeof late.log === 'function' ? late.log : () => {};
  let lateState = null;
  function lateLoad() {
    if (lateState) return lateState;
    try { lateState = late.stateFile ? JSON.parse(fs.readFileSync(late.stateFile, 'utf8')) : null; } catch (_e) { lateState = null; }
    if (!lateState || typeof lateState !== 'object') lateState = {};
    lateState.obs = lateState.obs && typeof lateState.obs === 'object' ? lateState.obs : {};
    lateState.logged = lateState.logged && typeof lateState.logged === 'object' ? lateState.logged : {};
    lateState.boot = lateState.boot && typeof lateState.boot === 'object' ? lateState.boot : {};
    return lateState;
  }
  function lateSave() {
    if (!late || !late.stateFile) return;
    try { fs.mkdirSync(path.dirname(late.stateFile), { recursive: true }); fs.writeFileSync(late.stateFile, JSON.stringify(lateState)); } catch (_e) { /* journal-only: never break a scan */ }
  }
  /** One observation per completed session in `raw`: { d, sr, p1530, p1555, prev }. Today only once its 15:55 bar has settled. */
  function lateObservations(raw, today, now) {
    const by = new Map();
    for (const b of raw || []) {
      const t = tOf(b); const c = Number(b.close != null ? b.close : b.c);
      if (!Number.isFinite(t) || !(c > 0)) continue;
      const e = etOf(t); if (e.min < 570 || e.min >= 960) continue;
      if (!by.has(e.day)) by.set(e.day, new Map());
      by.get(e.day).set(e.min, { t, c });
    }
    const days = [...by.keys()].sort();
    const calDays = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
    const out = [];
    for (let i = 1; i < days.length; i++) {
      const d = days[i], cur = by.get(d), prevBars = by.get(days[i - 1]);
      if (calDays(days[i - 1], d) > 5) continue;
      const a = cur.get(LATE_FROM_MIN), z = cur.get(LATE_TO_MIN);
      if (!a || !z) continue;
      if (d >= today && !(z.t + BAR_MS + SETTLE_MS <= now)) continue;
      const prevMin = Math.max(...prevBars.keys()); const prev = prevBars.get(prevMin).c;
      if (!(prev > 0)) continue;
      out.push({ d, sr: Math.sign(a.c / prev - 1) * (z.c / a.c - 1), p1530: a.c, p1555: z.c, prev });
    }
    return out;
  }
  /** Merge observations into the proxy's list (older ones kept as they are); true when something new arrived. */
  function lateAbsorb(proxy, obs) {
    const S = lateLoad(); const have = S.obs[proxy] || [];
    const seen = new Set(have.map((o) => o.d)); let added = false;
    for (const o of obs) if (!seen.has(o.d)) { have.push(o); seen.add(o.d); added = true; }
    if (added) { have.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0)); S.obs[proxy] = have.slice(-LATE_KEEP); }
    return added;
  }
  /** The gate as it reads for `day`, from the sessions BEFORE it: { n, m40, gate40, m60, gate60 } (null = not enough history). */
  function lateRead(proxy, day) {
    const prior = (lateLoad().obs[proxy] || []).filter((o) => o.d < day);
    const out = { n: prior.length };
    for (const N of LATE_LOOKBACKS) {
      const v = prior.slice(-N).map((o) => o.sr);
      const ok = v.length >= Math.ceil(LATE_MIN_FRAC * N);
      const m = ok ? v.reduce((x, y) => x + y, 0) / v.length : null;
      out['m' + N] = m == null ? null : round(100 * m, 4);
      out['gate' + N] = m == null ? null : m < 0;
    }
    return out;
  }
  const lateBootTries = new Map();   // `${proxy}:${day}` -> fetches tried
  /** Per pair and scan: absorb what the bars say; log the gate row after the 15:30 bar and the drift row after the 15:55 bar. */
  async function lateTick(pr, raw, e, now, last, prices) {
    if (!late) return null;
    const S = lateLoad(); let changed = false;
    const key = `${pr.proxy}:${e.day}`;
    if (S.boot[pr.proxy] !== e.day && typeof getHistory === 'function' && (lateBootTries.get(key) || 0) < 3) {
      lateBootTries.set(key, (lateBootTries.get(key) || 0) + 1);
      const dayStart = Date.parse(`${e.day}T12:00:00Z`);
      let older = [];
      for (const [from, to] of LATE_BOOT_SLICES) {
        try { const r = await getHistory(pr.proxy, dayStart - from * 86400000, dayStart - to * 86400000); if (r && Array.isArray(r.bars)) older = older.concat(r.bars); } catch (_e) { /* a slice the feed refused: the others still count */ }
      }
      // marked done only when something came back: an empty day is retried (3 tries), then again tomorrow
      if (older.length) { S.boot[pr.proxy] = e.day; changed = true; if (lateAbsorb(pr.proxy, lateObservations(merge(older, raw), e.day, now))) changed = true; }
    }
    if (lateAbsorb(pr.proxy, lateObservations(raw, e.day, now))) changed = true;
    const logged = S.logged[pr.proxy] || (S.logged[pr.proxy] = {});
    let read = null;
    if (last && last.min >= LATE_FROM_MIN) {
      read = lateRead(pr.proxy, e.day);
      if (logged.gate !== e.day) {
        logged.gate = e.day; changed = true;
        lateLog({ event: 'late_gate_shadow', proxy: pr.proxy, day: e.day, bar: hhmm(last.min + 5), state: prices.state, ...read,
          up: { symbol: pr.up, px: prices.up }, dn: { symbol: pr.dn, px: prices.dn }, shadow: true });
      }
    }
    const today = (S.obs[pr.proxy] || []).find((o) => o.d === e.day);
    if (today && logged.drift !== e.day) {
      logged.drift = e.day; changed = true;
      lateLog({ event: 'late_drift_shadow', proxy: pr.proxy, day: e.day, p1530: round(today.p1530), p1555: round(today.p1555), prev_close: round(today.prev),
        sr_pct: round(100 * today.sr, 4), n: (S.obs[pr.proxy] || []).length, shadow: true });
    }
    if (changed) lateSave();
    return read;
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
      const prices = { state, up: null, dn: null };
      for (const [sym, side] of [[pr.up, 'up'], [pr.dn, 'dn']]) {
        const w = await wrapperRead(sym, e.day, now);
        prices[side] = w.px;
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
      let lateInfo = null;
      try { lateInfo = await lateTick(pr, raw, e, now, last, prices); } catch (_e) { lateInfo = null; }   // journal-only: never a scan error
      read.push({ proxy: pr.proxy, state, bar: last ? hhmm(last.min + 5) : null, close: last ? round(last.c) : null,
        upper: lim ? round(lim.upper) : null, lower: lim ? round(lim.lower) : null, decision, why: why || undefined, late: lateInfo || undefined });
    }
    return { signals, noise: { at: new Date(now).toISOString(), pairs: read } };
  }

  return { pairs: P, scan, lateGate: late ? { read: lateRead, observations: lateObservations } : null };
}

module.exports = { createNoiseScan, ENTRY_WINDOW_MS, CLOSE_MIN, LATE_LOOKBACKS };
