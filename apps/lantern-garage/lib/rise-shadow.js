'use strict';
/**
 * rise-shadow.js — THE AFTER-THE-RISE SHADOW (2026-10-30). Journal only: it places no order, refuses no entry and
 * changes no other rule.
 *
 * The operator's read (2026-10-29): "after a big rise there is usually a pullback". Measured that afternoon on seven
 * asset families over two decades, on the overnight book, the leg and the stable design's own replay trades (ledger
 * tier0-after-big-rise-pullback-2026-10-29), no lever held on both surfaces. One hint stayed open: the stable design's
 * entries made the session AFTER their name rose big lost $21 a trade on the 13 recent windows (154 of 2,026 entries,
 * 7.6 %; the others made $12) and nothing on the 30 older quarters (364 entries, -$3 against -$4). Skipping them adds
 * +0.020 %/wk recent and +0.003 older, deepens the older worst week (-4.09 -> -4.21 %) and adds a negative year: not
 * a rule. This shadow tags every live entry with that reading, so the live record can say whether the hint is real.
 * At ~0.7 flagged entries a week it proves live fidelity in weeks; the gap itself needs ~115 flagged entries.
 *
 * The reading is the replay's own: the completed daily closes before today; the prior session's close-to-close return
 * over the sample sd of the 20 returns before it (at least 10). would_skip = z >= 1.5; z >= 2 is recorded beside it
 * (in the replay the gap is gone there). A |return| over 60 % in the window is an unadjusted split: no reading.
 *
 * Rows (user 'rise-shadow', never 'entry'/'exit', so no P&L reader counts them):
 *   rise_shadow_check  once per session from 09:00 ET: every scanned tradelist name's reading (the tripwire, and the
 *                      base rate the entries are compared with)
 *   rise_shadow_entry  every entry the trader places: its name's reading and would_skip
 *
 * Enable: TRADER_RISE_SHADOW=1 (unset or 0 = off). The day of the last check row survives a restart in
 * rise-shadow-state.json beside the journal.
 */
const fs = require('fs');
const path = require('path');
const { isTradingDay } = require('./market-calendar');

const K = 1.5;                       // the hint's threshold, in trailing sds
const K2 = 2.0;                      // recorded beside it: the replay's gap is gone at 2
const N = 20;                        // returns in the trailing sd
const MIN_N = 10;                    // the replay's floor
const MAX_MOVE = 0.6;                // a bigger |daily return| is an unadjusted split, not a move
const CHECK_MIN = 540;               // 09:00 ET: the check row, before the open's scan rush
const HISTORY_MS = 70 * 86400000;    // 70 calendar days hold the 22 sessions a reading needs
const RETRY_MS = 5 * 60000;          // a daily fetch that brought nothing is asked again after 5 minutes

const _FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function etOf(ms) {
  const p = _FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/**
 * The prior session's rise in trailing sds, from daily bars: { prior_day, ret, sd, z, n }, or { why } when there is
 * no honest reading (short or flat history, a split-like move). Today's bar is partial and is never read.
 */
function riseReading(rawDaily, day, { n = N, minN = MIN_N, maxMove = MAX_MOVE } = {}) {
  const byDay = new Map();
  for (const b of rawDaily || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c);
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const d = etOf(t).day;
    if (d >= day) continue;                  // completed sessions only
    byDay.set(d, c);                         // a day listed twice keeps its last bar
  }
  const closes = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const L = closes.length - 1;
  if (L < minN + 1) return { why: 'short history', sessions: closes.length };
  const ret = closes[L][1] / closes[L - 1][1] - 1;
  const rets = [];
  for (let i = Math.max(1, L - n); i < L; i++) rets.push(closes[i][1] / closes[i - 1][1] - 1);
  if ([ret, ...rets].some((r) => Math.abs(r) > maxMove)) return { why: 'split-like move', prior_day: closes[L][0] };
  const m = rets.reduce((a, r) => a + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  if (!(sd > 0)) return { why: 'flat history', prior_day: closes[L][0] };
  return { prior_day: closes[L][0], ret, sd, z: ret / sd, n: rets.length };
}

function createRiseShadow({ log, stateFile, getDaily, k = K } = {}) {
  let state = null;
  let checking = null;
  let cacheDay = null;
  const cache = new Map();   // symbol -> { at, ok, p } for cacheDay

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_e) { state = null; }
    if (!state || typeof state !== 'object') state = { day: null };
    return state;
  }
  function save() {
    if (!stateFile) return;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_e) { /* journal-only: never break a pass */ }
  }
  /** One daily fetch per name per session, shared by the check row and the entries; an empty answer is asked again. */
  function readingOf(sym, day, now) {
    if (cacheDay !== day) { cache.clear(); cacheDay = day; }
    const hit = cache.get(sym);
    if (hit && (hit.ok !== false || now - hit.at < RETRY_MS)) return hit.p;
    const e = { at: now, ok: null, p: null };
    e.p = (async () => {
      let bars = [];
      try { const r = await getDaily(sym, now - HISTORY_MS, now); bars = (r && Array.isArray(r.bars)) ? r.bars : []; } catch (_e) { bars = []; }
      e.ok = bars.length > 0;
      return bars.length ? riseReading(bars, day) : { why: 'no daily bars' };
    })();
    cache.set(sym, e);
    return e.p;
  }
  const fields = (rd) => (rd && rd.z != null
    ? { prior_day: rd.prior_day, prior_ret_pct: round(100 * rd.ret), sd20_pct: round(100 * rd.sd), z: round(rd.z), n: rd.n, would_skip: rd.z >= k, z_ge_2: rd.z >= K2 }
    : { prior_day: (rd && rd.prior_day) || null, z: null, would_skip: null, why: (rd && rd.why) || 'no reading' });

  async function checkInner(now, symbols) {
    const e = etOf(now);
    const st = load();
    if (st.day === e.day || e.min < CHECK_MIN || !isTradingDay(e.day)) return;
    const syms = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))].sort();
    if (!syms.length) return;   // a pass with no scan: the next one writes the row
    const reads = await Promise.all(syms.map(async (s) => [s, await readingOf(s, e.day, now)]));
    const readings = {}, flagged = [], flagged2 = [], missing = [], priors = {};
    for (const [s, rd] of reads) {
      if (rd.z == null) { missing.push(s); readings[s] = { why: rd.why }; continue; }
      readings[s] = { z: round(rd.z), ret_pct: round(100 * rd.ret) };
      priors[rd.prior_day] = (priors[rd.prior_day] || 0) + 1;
      if (rd.z >= k) flagged.push(s);
      if (rd.z >= K2) flagged2.push(s);
    }
    const prior = Object.keys(priors).sort((a, b) => priors[b] - priors[a])[0] || null;
    log({ event: 'rise_shadow_check', day: e.day, prior_day: prior, k, names: syms.length, flagged, flagged_2: flagged2, missing, readings, shadow: true });
    state.day = e.day;
    save();
  }
  /** The once-a-session check row; a pass that finds one running leaves it alone. */
  function check(now, symbols) {
    if (checking) return checking;
    checking = checkInner(now, symbols).catch(() => {}).finally(() => { checking = null; });
    return checking;
  }
  /** One row per entry the trader placed: its name's reading at the entry. */
  async function tag({ symbol, account, qty, price, now }) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    const rd = await readingOf(sym, etOf(now).day, now);
    log({ event: 'rise_shadow_entry', symbol: sym, account: account || null, qty: Number(qty) || null, entry_px: round(Number(price), 4),
      notional: Number(qty) > 0 && Number(price) > 0 ? Math.round(qty * price) : null, k, ...fields(rd), shadow: true });
  }
  return { check, tag, readingOf };
}

module.exports = { createRiseShadow, riseReading, etOf, K, K2 };
