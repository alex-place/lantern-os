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

module.exports = { createTrendShadow, checkpointRead, medianDailyMove, sessionBars, RULES, etOf };
