'use strict';
/**
 * trend-shadow.js — THE TREND-DAY SHADOW (2026-09-30). Journal only: it places no order, holds no
 * position and changes no other rule.
 *
 * The book buys washouts, so a session that rallies without a dip gives it nothing to buy (SOXL
 * 2026-09-22: +10.4% open to close from the opening print). A second rule was measured for those
 * days: at the first of a few checkpoints at which a name sits in the top fifth of its session
 * range AND that range is at least the name's own median absolute daily move (60 prior sessions),
 * buy at that price and sell at 15:50. On SOXL, through the replay engine: +0.200% per entry on the
 * 13 scored windows and +0.180% on the 30 unseen quarters (964 entries, positive in 30 quarters of
 * 42), with the stop 8% away. Across other names it does not pay. The replay is gross of costs and
 * fills at bar closes; this shadow journals what the rule would have done LIVE, at live prices, so
 * the decision to arm it rests on more than bars.
 *
 * Rules (checkpoints are 5m bar START minutes, ET; the bar starting 10:25 closes at 10:30):
 *   v0  10:30 / 11:30 / 13:00          the candidate as measured
 *   v1  10:00 / 10:30 / 11:30 / 13:00  the closest variant (higher mean on both surfaces, one fewer
 *                                     positive quarter on each: under the bar, recorded for data)
 *
 * Rows (in the trade journal, never 'entry'/'exit', so no P&L reader counts them):
 *   trend_shadow_check  every checkpoint read, fired or not (proves the shadow ran)
 *   trend_shadow_entry  a rule fires: the live quote when the read is fresh, else the bar close
 *   trend_shadow_exit   the 8% stop (on a completed bar's low) or the 15:50 sale (the live quote)
 *
 * Enable: TRADER_TREND_SHADOW=SOXL (comma list; unset = off). State survives a restart in
 * trend-shadow-state.json beside the journal.
 */
const fs = require('fs');
const path = require('path');

const RULES = [
  { id: 'v0', checks: [625, 685, 775] },
  { id: 'v1', checks: [595, 625, 685, 775] },
];
const TOP = 0.8;              // top fifth of the session range
const RANGE_K = 1.0;          // range at least 1.0 x the median absolute daily move
const STOP_PCT = 0.08;        // the stop the replay used
const CLOSE_MIN = 950;        // 15:50 ET, when the 3x names are sold
const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;      // a bar is read 20 s after it closes (feed lag)
const FRESH_MS = 3 * 60000;   // within 3 minutes of the checkpoint the live quote is the entry
const MISSING_BAR_MIN = 20;   // a checkpoint bar still absent 20 minutes later is journaled as missing

const _FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function etOf(ms) {
  const p = _FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Today's regular-session bars from a market-data bar list: [{ t, min, h, l, c }] sorted by start. */
function sessionBars(rawBars, day) {
  const out = [];
  for (const b of rawBars || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c), h = Number(b.high != null ? b.high : b.h), l = Number(b.low != null ? b.low : b.l);
    if (!Number.isFinite(t) || !(c > 0) || !(h > 0) || !(l > 0)) continue;
    const e = etOf(t);
    if (e.day !== day || e.min < 570 || e.min >= 960) continue;
    out.push({ t, min: e.min, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The name's own scale: the median |close-to-close move| over the 60 sessions completed before
 * `day`, from daily bars. null when history is short or holds a move no split-adjusted series makes.
 */
function medianDailyMove(rawDaily, day, { n = 60, maxMove = 0.6 } = {}) {
  const closes = [];
  const seen = new Set();
  for (const b of rawDaily || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c);
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const d = etOf(t).day;
    if (d >= day || seen.has(d)) continue;          // today's bar is partial: completed sessions only
    seen.add(d); closes.push({ d, c });
  }
  closes.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (closes.length < n + 1) return null;
  const tail = closes.slice(-(n + 1));
  const moves = [];
  for (let i = 1; i < tail.length; i++) {
    const r = tail[i].c / tail[i - 1].c - 1;
    if (Math.abs(r) > maxMove) return null;
    moves.push(Math.abs(r));
  }
  moves.sort((a, b) => a - b);
  return n % 2 ? moves[(n - 1) / 2] : (moves[n / 2 - 1] + moves[n / 2]) / 2;
}

/** The read at one checkpoint: the session so far, up to and including the bar that starts at `checkMin`. */
function checkpointRead(bars, checkMin, mad, { top = TOP, rangeK = RANGE_K } = {}) {
  const bar = bars.find((b) => b.min === checkMin);
  if (!bar) return { ok: false, why: 'no bar' };
  const upTo = bars.filter((b) => b.t <= bar.t);
  const hi = Math.max(...upTo.map((b) => b.h)), lo = Math.min(...upTo.map((b) => b.l));
  if (!(hi > lo)) return { ok: false, why: 'no range', bar };
  const ibs = (bar.c - lo) / (hi - lo);
  const range = (hi - lo) / lo;
  if (!(mad > 0)) return { ok: false, why: 'no daily history', bar, ibs, range };
  const ok = ibs >= top && range >= rangeK * mad;
  const why = ok ? 'top of a wide range' : ibs < top ? `IBS ${ibs.toFixed(2)} < ${top}` : `range ${(100 * range).toFixed(2)}% < ${rangeK} x ${(100 * mad).toFixed(2)}%`;
  return { ok, why, bar, ibs, range, hi, lo };
}

function createTrendShadow({ symbols, log, stateFile, getBars, getQuote, rules = RULES, stopPct = STOP_PCT, closeMin = CLOSE_MIN } = {}) {
  const syms = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const checks = [...new Set(rules.flatMap((r) => r.checks))].sort((a, b) => a - b);
  let state = null;
  let inFlight = false;
  const madCache = new Map();   // `${sym}:${day}` -> number | null

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_e) { state = null; }
    if (!state || typeof state !== 'object') state = { day: null, checked: {}, pos: {} };
    state.checked = state.checked || {}; state.pos = state.pos || {};
    return state;
  }
  function save() {
    if (!stateFile) return;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_e) { /* journal-only: never break a pass */ }
  }
  async function quoteOf(sym) {
    try { const q = await getQuote(sym); return Number(q) > 0 ? Number(q) : null; } catch (_e) { return null; }
  }
  function closePos(p, exitPx, why, now) {
    const ret = exitPx / p.entry - 1;
    log({ event: 'trend_shadow_exit', symbol: p.sym, rule: p.rule, check: p.check, entry_px: round(p.entry), exit_px: round(exitPx), ret_pct: round(100 * ret, 3),
      mae_pct: round(100 * (p.low / p.entry - 1), 3), mfe_pct: round(100 * (p.high / p.entry - 1), 3), why, held_min: Math.round((now - p.entry_t) / 60000), shadow: true });
    p.closed = true;
  }

  async function tickInner(now) {
    const e = etOf(now);
    const st = load();
    if (st.day !== e.day) {
      // a position the previous session never closed (no pass between 15:50 and 16:05): close it at
      // that session's 15:50 bar from the bar history, flagged late
      for (const p of Object.values(st.pos)) {
        if (p.closed) continue;
        let px = null;
        try { const bars = sessionBars((await getBars(p.sym, '5m')).bars, p.day); const b = bars.find((x) => x.min === closeMin) || bars[bars.length - 1]; px = b ? b.c : null; } catch (_e) { px = null; }
        if (px > 0) closePos(p, px, 'close_late', now);
        else { log({ event: 'trend_shadow_exit', symbol: p.sym, rule: p.rule, check: p.check, entry_px: round(p.entry), exit_px: null, why: 'no_close_seen', shadow: true }); p.closed = true; }
      }
      state = { day: e.day, checked: {}, pos: {} };
      save();
    }
    if (e.min < 570 || e.min >= 965) return;
    for (const sym of syms) {
      const due = checks.filter((c) => e.min >= c + 5 && !state.checked[`${sym}:${c}`]);
      const open = Object.values(state.pos).filter((p) => p.sym === sym && !p.closed);
      if (!due.length && !open.length) continue;
      let bars;
      try { bars = sessionBars((await getBars(sym, '5m')).bars, e.day); } catch (_e) { continue; }
      if (due.length) {
        // the daily scale, once per session; a failed fetch is retried on the next two passes
        const mkey = `${sym}:${e.day}`;
        let mc = madCache.get(mkey) || { value: null, tries: 0 };
        if (mc.value == null && mc.tries < 3) {
          let m = null;
          try { m = medianDailyMove((await getBars(sym, '1d')).bars, e.day); } catch (_e) { m = null; }
          mc = { value: m, tries: mc.tries + 1 };
          madCache.set(mkey, mc);
        }
        const mad = mc.value;
        for (const c of due) {
          const bar = bars.find((b) => b.min === c);
          if (!bar) {
            if (e.min >= c + 5 + MISSING_BAR_MIN) { log({ event: 'trend_shadow_check', symbol: sym, check: hhmm(c + 5), qualifies: false, why: 'no bar', shadow: true }); state.checked[`${sym}:${c}`] = true; save(); }
            continue;   // the feed has not delivered the bar yet: read it on a later pass
          }
          const barEnd = bar.t + BAR_MS;
          if (now < barEnd + SETTLE_MS) continue;
          if (mad == null && mc.tries < 3) continue;   // wait up to three passes for the daily history
          const read = checkpointRead(bars, c, mad);
          const fresh = now - barEnd <= FRESH_MS;
          const quote = fresh ? await quoteOf(sym) : null;
          const fires = read.ok ? rules.filter((r) => r.checks.includes(c) && !state.pos[`${r.id}:${sym}`]).map((r) => r.id) : [];
          log({ event: 'trend_shadow_check', symbol: sym, check: hhmm(c + 5), qualifies: read.ok, why: read.why,
            ibs: round(read.ibs, 3), range_pct: round(100 * read.range, 3), mad_pct: mad != null ? round(100 * mad, 3) : null,
            bar_close: round(bar.c), quote: round(quote), late: !fresh, fires, shadow: true });
          for (const id of fires) {
            const entry = quote > 0 ? quote : bar.c;
            const p = { rule: id, sym, day: e.day, check: hhmm(c + 5), entry, bar_close: bar.c, entry_t: now, entry_bar_t: bar.t, last_t: bar.t, stop: entry * (1 - stopPct), low: entry, high: entry, closed: false };
            state.pos[`${id}:${sym}`] = p;
            log({ event: 'trend_shadow_entry', symbol: sym, rule: id, check: p.check, entry_px: round(entry), bar_close: round(bar.c), quote: round(quote), late: !fresh,
              stop_px: round(p.stop), notional_pct: 18, shadow: true });
          }
          state.checked[`${sym}:${c}`] = true;
          save();
        }
      }
      // the open shadow positions: the stop on completed bars, then the 15:50 sale
      for (const p of Object.values(state.pos).filter((x) => x.sym === sym && !x.closed)) {
        for (const b of bars) {
          if (b.t <= p.last_t || b.t + BAR_MS + SETTLE_MS > now) continue;   // completed bars after the last one read
          p.last_t = b.t;
          if (b.l <= p.stop) { closePos(p, b.h < p.stop ? b.c : p.stop, 'stop', now); break; }
          p.low = Math.min(p.low, b.l); p.high = Math.max(p.high, b.h);
        }
        if (!p.closed && e.min >= closeMin) {
          const q = e.min < 960 ? await quoteOf(sym) : null;
          const b = bars.find((x) => x.min === closeMin) || bars[bars.length - 1];
          const px = q > 0 ? q : b ? b.c : null;
          if (px > 0) closePos(p, px, e.min < 960 && q > 0 ? 'close' : 'close_late', now);
        }
        save();
      }
    }
  }

  return {
    symbols: syms,
    /** One pass. Never throws, never awaits anything a trade waits on; overlapping passes skip. */
    async tick(now = Date.now()) {
      if (inFlight || !syms.length) return;
      inFlight = true;
      try { await tickInner(now); } catch (_e) { /* journal-only */ } finally { inFlight = false; }
    },
    _state: () => load(),
  };
}

// ─────────────────────────────── THE NOISE-AREA SHADOW (2026-10-01) ───────────────────────────────
// The rally-and-drop leg, journal only like the trend shadow above. The book buys washouts and loses
// on the days the market trends (the scenario map: drop days cost it more than its whole recent
// profit). This rule trades WITH the trend: the intraday momentum rule of Zarattini, Aziz and Barbon
// (2024, SSRN 4824172), long-only through 3x wrappers. For a proxy (SPY, QQQ, SMH):
//   sigma(m) = the mean over the 14 prior sessions of |close(m) / open - 1| at the same 5m bar start m
//   upper(m) = max(open, prevClose) x (1 + sigma(m))     lower(m) = min(open, prevClose) x (1 - sigma(m))
// with the open the 09:30 bar's midpoint, as the replay measured it. At the bars closing 10:00, 10:30,
// ..., 15:30 a flat pair "buys" its long wrapper when the proxy closes above upper, its inverse below
// lower; a held wrapper is "sold" at the first completed bar at which the proxy closes back inside on
// its side (no re-entry on that bar), at the 8% stop on the wrapper's bar lows, else at 15:50. One
// position per pair. Through the replay engine the leg's trades matched the anatomy's (ledger rows
// noise-area-momentum-wrappers, noise-leg-engine-*); net of costs its edge is thin and concentrated on
// volatile days, so every row also carries the two conditions the lab measured beside the rule:
//   vol20  SPY's 20-session annualized realized volatility (gate >= 16%: noise-leg-volatility-gate-anatomy)
//   agree  how many of the shadow's proxies close outside their bands on the same side (breadth)
// Rows: noise_shadow_check (each decision bar, per pair), noise_shadow_entry, noise_shadow_exit.
// Enable: TRADER_NOISE_SHADOW=SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ,SMH:SOXL:SOXS (unset = off). State survives
// a restart in noise-shadow-state.json beside the journal.
const NOISE_DECISIONS = Array.from({ length: 12 }, (_, k) => 595 + 30 * k);   // bar starts; closes 10:00 ... 15:30
const NOISE_LOOKBACK = 14;
const NOISE_MIN_HIST = 10;
const VOL_GATE = 0.16;

/** 'SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ' -> [{ proxy, up, dn }] (malformed entries dropped, proxies unique). */
function parseNoisePairs(spec) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const [proxy, up, dn] = part.split(':').map((x) => String(x || '').trim().toUpperCase());
    if (proxy && up && dn && !out.some((p) => p.proxy === proxy)) out.push({ proxy, up, dn });
  }
  return out;
}

/** Regular-session 5m bars of every session in a bar list: Map(day -> [{ t, min, h, l, c }] sorted). */
function sessionsOf(rawBars) {
  const by = new Map();
  for (const b of rawBars || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c), h = Number(b.high != null ? b.high : b.h), l = Number(b.low != null ? b.low : b.l);
    if (!Number.isFinite(t) || !(c > 0) || !(h > 0) || !(l > 0)) continue;
    const e = etOf(t);
    if (e.min < 570 || e.min >= 960) continue;
    if (!by.has(e.day)) by.set(e.day, []);
    by.get(e.day).push({ t, min: e.min, h, l, c });
  }
  for (const a of by.values()) a.sort((x, y) => x.t - y.t);
  return by;
}

/**
 * The noise band of `day` from a proxy's 5m bars: { open, prevClose, at(min) -> { upper, lower, sigma } | null },
 * or { why } when the history cannot make one: as the replay, 14 prior sessions, the previous one within 5
 * calendar days and the 14th within 28, at least 10 of them with a bar at that minute, a 09:30 bar today.
 */
function noiseBand(rawBars, day) {
  const by = sessionsOf(rawBars);
  const cur = by.get(day);
  if (!cur || !cur.length || cur[0].min !== 570) return { why: 'no 09:30 bar today' };
  const prior = [...by.keys()].filter((d) => d < day).sort();
  if (prior.length < NOISE_LOOKBACK) return { why: `${prior.length} prior sessions (< ${NOISE_LOOKBACK})` };
  const calDays = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
  const prev = prior[prior.length - 1];
  if (calDays(prev, day) > 5 || calDays(prior[prior.length - NOISE_LOOKBACK], day) > 28) return { why: 'a gap in the session history' };
  const sessions = prior.slice(-NOISE_LOOKBACK).map((d) => { const a = by.get(d); return { open: (a[0].h + a[0].l) / 2, byMin: new Map(a.map((b) => [b.min, b])) }; });
  const open = (cur[0].h + cur[0].l) / 2;
  const prevBars = by.get(prev), prevClose = prevBars[prevBars.length - 1].c;
  const hiRef = Math.max(open, prevClose), loRef = Math.min(open, prevClose);
  const memo = new Map();
  return {
    open, prevClose,
    at(min) {
      if (memo.has(min)) return memo.get(min);
      const mv = [];
      for (const s of sessions) { const b = s.byMin.get(min); if (b) mv.push(Math.abs(b.c / s.open - 1)); }
      let out = null;
      if (mv.length >= NOISE_MIN_HIST) { const sg = mv.reduce((x, y) => x + y, 0) / mv.length; out = { upper: hiRef * (1 + sg), lower: loRef * (1 - sg), sigma: sg }; }
      memo.set(min, out);
      return out;
    },
  };
}

/** Annualized realized volatility of log close-to-close returns over the n sessions before `day` (daily bars). */
function realizedVol(rawDaily, day, n = 20) {
  const closes = [];
  const seen = new Set();
  for (const b of rawDaily || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c);
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const d = etOf(t).day;
    if (d >= day || seen.has(d)) continue;          // completed sessions only
    seen.add(d); closes.push({ d, c });
  }
  closes.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (closes.length < n + 1) return null;
  const tail = closes.slice(-(n + 1));
  const r = [];
  for (let i = 1; i < tail.length; i++) r.push(Math.log(tail[i].c / tail[i - 1].c));
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1) * 252);
}

// The live bar feed keeps at most 2,600 5m bars INCLUDING the extended sessions (lib/market-data-yahoo.js
// MAX_BARS), about 14 sessions: one short of the band's 15 (14 prior + today), and the oldest session drops out as
// today's bars arrive (2026-10-01: QQQ and SMH had no band all day, SPY lost it from 12:30). A settled window of
// older bars (7 to 28 calendar days back, fixed per day, so the market-data module serves it from its 6-hour cache)
// is merged under the recent feed when `getHistory(sym, fromMs, toMs)` is given.
const HISTORY_FROM_DAYS = 28;
const HISTORY_TO_DAYS = 7;

function createNoiseShadow({ pairs, log, stateFile, getBars, getQuote, getHistory = null, stopPct = STOP_PCT, closeMin = CLOSE_MIN, volGate = VOL_GATE } = {}) {
  const P = Array.isArray(pairs) ? pairs : parseNoisePairs(pairs);
  let state = null;
  let inFlight = false;
  const volCache = new Map();   // day -> { value, tries }
  const histCache = new Map();  // `${sym}:${day}` -> { bars, tries }
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
  /** Older history under the recent feed, one row per bar start. */
  function withHistory(older, recent) {
    if (!older.length) return recent;
    const seen = new Set();
    const out = [];
    for (const b of [...older, ...recent]) {
      const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
      if (!Number.isFinite(t) || seen.has(t)) continue;
      seen.add(t); out.push(b);
    }
    return out.sort((a, b) => Date.parse(a.timestamp != null ? a.timestamp : a.t) - Date.parse(b.timestamp != null ? b.timestamp : b.t));
  }

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_e) { state = null; }
    if (!state || typeof state !== 'object') state = { day: null, cursor: {}, checked: {}, pos: {} };
    state.cursor = state.cursor || {}; state.checked = state.checked || {}; state.pos = state.pos || {};
    return state;
  }
  function save() {
    if (!stateFile) return;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_e) { /* journal-only: never break a pass */ }
  }
  async function quoteOf(sym) {
    try { const q = await getQuote(sym); return Number(q) > 0 ? Number(q) : null; } catch (_e) { return null; }
  }
  async function barsOf(sym, day) {
    try { return sessionBars((await getBars(sym, '5m')).bars, day); } catch (_e) { return null; }
  }
  function closePos(p, exitPx, why, now, exitCheck) {
    const ret = exitPx / p.entry - 1;
    log({ event: 'noise_shadow_exit', symbol: p.sym, proxy: p.proxy, side: p.side, check: p.check, exit_check: exitCheck || null,
      entry_px: round(p.entry), exit_px: round(exitPx), ret_pct: round(100 * ret, 3), why, held_min: Math.round((now - p.entry_t) / 60000),
      mae_pct: round(100 * (p.low / p.entry - 1), 3), mfe_pct: round(100 * (p.high / p.entry - 1), 3), vol20: p.vol20, gate: p.gate, agree: p.agree, shadow: true });
    p.closed = true;
  }

  async function tickInner(now) {
    const e = etOf(now);
    let st = load();
    if (st.day !== e.day) {
      // a position the previous session never closed (no pass after 15:50): its 15:50 bar, flagged late
      for (const p of Object.values(st.pos)) {
        if (p.closed) continue;
        const bars = await barsOf(p.sym, p.day);
        const b = bars && (bars.find((x) => x.min === closeMin) || bars[bars.length - 1]);
        if (b) closePos(p, b.c, 'close_late', now, hhmm(b.min + 5));
        else { log({ event: 'noise_shadow_exit', symbol: p.sym, proxy: p.proxy, side: p.side, check: p.check, entry_px: round(p.entry), exit_px: null, why: 'no_close_seen', shadow: true }); p.closed = true; }
      }
      st = state = { day: e.day, cursor: {}, checked: {}, pos: {} };
      save();
    }
    if (e.min < 570 || e.min >= 965) return;
    // the gate's reading, once per session (a failed fetch is retried on the next two passes)
    let vc = volCache.get(e.day) || { value: null, tries: 0 };
    if (vc.value == null && vc.tries < 3) {
      let v = null;
      try { v = realizedVol((await getBars('SPY', '1d')).bars, e.day); } catch (_e) { v = null; }
      vc = { value: v, tries: vc.tries + 1 };
      volCache.set(e.day, vc);
    }
    const vol20 = vc.value != null ? round(vc.value, 4) : null;
    const gate = vol20 != null ? vol20 >= volGate : null;
    // every proxy's session and band, read once per pass
    const R = {};
    for (const pr of P) {
      let raw = null;
      try { raw = (await getBars(pr.proxy, '5m')).bars; } catch (_e) { raw = null; }
      if (!raw) continue;
      raw = withHistory(await historyOf(pr.proxy, e.day), raw);
      R[pr.proxy] = { bars: sessionBars(raw, e.day), band: noiseBand(raw, e.day) };
    }
    const stateAt = (proxy, min) => {
      const r = R[proxy]; if (!r || !r.band.at) return null;
      const b = r.bars.find((x) => x.min === min); const lim = b && r.band.at(min);
      return lim ? (b.c > lim.upper ? 'up' : b.c < lim.lower ? 'dn' : 'in') : null;
    };
    for (const pr of P) {
      const r = R[pr.proxy];
      if (!r) continue;
      const done = r.bars.filter((b) => b.min >= 595 && b.min < closeMin && b.t > (st.cursor[pr.proxy] || 0) && b.t + BAR_MS + SETTLE_MS <= now);
      let wrapBars = null;
      for (const b of done) {
        const fresh = now - (b.t + BAR_MS) <= FRESH_MS;
        const p = st.pos[pr.proxy] && !st.pos[pr.proxy].closed ? st.pos[pr.proxy] : null;
        if (p) {
          // the open position: the stop on the wrapper's completed bars up to this one, then the band at this close
          wrapBars = wrapBars || await barsOf(p.sym, e.day);
          let stopped = false;
          for (const wb of wrapBars || []) {
            if (wb.t <= p.last_t || wb.t > b.t) continue;
            p.last_t = wb.t;
            if (wb.l <= p.stop) { closePos(p, wb.h < p.stop ? wb.c : p.stop, 'stop', now, hhmm(wb.min + 5)); stopped = true; break; }
            p.low = Math.min(p.low, wb.l); p.high = Math.max(p.high, wb.h);
          }
          if (!stopped) {
            const lim = r.band.at ? r.band.at(b.min) : null;
            const back = lim ? (p.side === 'up' ? b.c < lim.upper : b.c > lim.lower) : false;   // no reading: hold
            if (back) {
              const wb = (wrapBars || []).find((x) => x.min === b.min);
              const q = fresh ? await quoteOf(p.sym) : null;
              const px = q > 0 ? q : wb ? wb.c : null;
              if (!(px > 0)) { wrapBars = null; break; }   // no price for the wrapper yet: this bar again on the next pass
              closePos(p, px, 'band', now, hhmm(b.min + 5));
            }
          }
          st.cursor[pr.proxy] = b.t;
          save();
          continue;                                   // no entry on the bar that closed a position (as the replay)
        }
        if (NOISE_DECISIONS.includes(b.min) && b.min < closeMin && !st.checked[`${pr.proxy}:${b.min}`]) {
          const lim = r.band.at ? r.band.at(b.min) : null;
          const s = stateAt(pr.proxy, b.min);
          const agree = s === 'up' || s === 'dn' ? P.filter((q) => stateAt(q.proxy, b.min) === s).length : 0;
          const sym = s === 'up' ? pr.up : s === 'dn' ? pr.dn : null;
          let entry = null, quote = null, wb = null;
          if (sym) {
            wrapBars = await barsOf(sym, e.day);
            wb = (wrapBars || []).find((x) => x.min === b.min);
            quote = fresh ? await quoteOf(sym) : null;
            entry = quote > 0 ? quote : wb ? wb.c : null;
          }
          log({ event: 'noise_shadow_check', proxy: pr.proxy, check: hhmm(b.min + 5), state: s || 'no band', why: lim ? undefined : (r.band.why || 'no band at this bar'),
            close: round(b.c), upper: lim ? round(lim.upper) : null, lower: lim ? round(lim.lower) : null, sigma_pct: lim ? round(100 * lim.sigma, 3) : null,
            vol20, gate, agree, fires: sym && entry > 0 ? sym : null, late: !fresh, shadow: true });
          if (sym && entry > 0) {
            const np = { proxy: pr.proxy, sym, side: s, day: e.day, check: hhmm(b.min + 5), entry, entry_t: now, entry_bar_t: b.t, last_t: b.t,
              stop: entry * (1 - stopPct), low: entry, high: entry, vol20, gate, agree, closed: false };
            st.pos[pr.proxy] = np;
            log({ event: 'noise_shadow_entry', symbol: sym, proxy: pr.proxy, side: s, check: np.check, entry_px: round(entry), bar_close: wb ? round(wb.c) : null,
              quote: round(quote), late: !fresh, stop_px: round(np.stop), notional_pct: 18, vol20, gate, agree, shadow: true });
          }
          st.checked[`${pr.proxy}:${b.min}`] = true;
        }
        st.cursor[pr.proxy] = b.t;
        save();
      }
      // the 15:50 sale, by the clock as the brain's de-carry: the live quote, or after 16:00 the 15:50 bar
      const held = st.pos[pr.proxy] && !st.pos[pr.proxy].closed ? st.pos[pr.proxy] : null;
      if (held && e.min >= closeMin) {
        const q = e.min < 960 ? await quoteOf(held.sym) : null;
        let px = q > 0 ? q : null, why = 'close';
        if (!(px > 0)) { const wbs = await barsOf(held.sym, e.day); const b = wbs && (wbs.find((x) => x.min === closeMin) || wbs[wbs.length - 1]); px = b ? b.c : null; why = 'close_late'; }
        if (px > 0) { closePos(held, px, why, now, hhmm(Math.min(e.min, closeMin))); save(); }
      }
      // a decision bar the feed never delivered: said once, 20 minutes on
      for (const c of NOISE_DECISIONS) {
        if (c >= closeMin || st.checked[`${pr.proxy}:${c}`] || e.min < c + 5 + MISSING_BAR_MIN || r.bars.some((x) => x.min === c)) continue;
        log({ event: 'noise_shadow_check', proxy: pr.proxy, check: hhmm(c + 5), state: 'no bar', vol20, gate, shadow: true });
        st.checked[`${pr.proxy}:${c}`] = true;
        save();
      }
    }
  }

  return {
    pairs: P,
    /** One pass. Never throws, never awaits anything a trade waits on; overlapping passes skip. */
    async tick(now = Date.now()) {
      if (inFlight || !P.length) return;
      inFlight = true;
      try { await tickInner(now); } catch (_e) { /* journal-only */ } finally { inFlight = false; }
    },
    _state: () => load(),
  };
}

module.exports = { createTrendShadow, checkpointRead, medianDailyMove, sessionBars, RULES, etOf,
  createNoiseShadow, noiseBand, realizedVol, parseNoisePairs, NOISE_DECISIONS };
