'use strict';
/**
 * lib/trade-plan.js — A TRADE PLAN ON EVERY ENTRY, JOURNAL ONLY (2026-11-08, operator: "every entry should still carry a written
 * plan: what we expect to happen, what we do if it happens, and what we do if it doesn't. That includes the in-between cases,
 * like a trade that never reaches its take-profit or its stop"; then, on the first build: "the plan doesn't feel intricate
 * enough and if it is it doesn't seem to be following it well").
 *
 * The engine has no language model, so the plan comes from rules. It is written once, right after the entry, and nothing acts
 * on it. Version 2 states EVERY rule that can close the trade, with the price or time it acts at, and what usually happens:
 *   thesis       why the trade exists: the sleeve's signal (the leg's noise-band break, the close-IBS washout, the overnight book
 *                above its trend, the month-end bond book, or the brain's own entry), the signal's own reading, and the market
 *                context the entry tags keep (lib/entry-tags.js readContext: gamma and news from the shared files; nothing is
 *                fetched for that). The full entry_tags row joins on order_id.
 *   expected     the planned exit (the EARLIEST scheduled exit: the de-carry, the Friday weekend flat, the max hold, the 09:40
 *                sale, the month's last close) and the expected move by then: the median |return| of the traded fund over the
 *                same clock window in the 14 prior sessions (at least 10 with both prices). Entry signs forecast the SIZE of a
 *                move, not its side, and a fund's own median move forecasts it as well as they do (ledger
 *                tier0-entry-signs-volume-residual, tier0-realistic-target-stop-fraction). The target is the entry x (1 + move):
 *                a reading, not an order.
 *   exits        every rule that can close it, as configured right now, each with its level: the leg's band exit with the
 *                proxy's band at each half hour (lib/trend-shadow.js noiseBand, the scan's own band) and the wrapper price that
 *                roughly matches; the broker stop; the max-loss cap with its price and WHEN it acts (it also sells in the
 *                extended hours unless TRADER_MAX_LOSS_RTH_ONLY=1; the replay never does that, so such a sale is marked
 *                in_replay false); the de-carry; the down-day carry; the late-reversal gate; the Friday weekend flat; the max
 *                hold; the 09:40 sale; the month-end calendar.
 *   scenarios    what usually happens: the sleeve's last closed trades in its own journal (up to 120), by the branch that closed
 *                them (the band exit, the late gate, the de-carry, a carry, the stop, the cap, the max hold, ...): the share, the
 *                mean result, the win rate and the median minutes held. The same classifier scores the forward read.
 *                A branch the sleeve's CURRENT configuration can no longer produce (C's signal exit under TRADER_IBS_EXIT=1.01,
 *                a rule switched off) stays in the history, labelled retired with the reason; `current` and share_current
 *                give the same trades without them, what usually happens under today's rules.
 *   today        the sleeve's entries earlier the same session (a re-entry flag on the same fund, and what the earlier tries made).
 *   gates        (version 3) what each entry rule said about this entry, armed or only recorded, so every rule is scored trade
 *                by trade on real fills: the leg's context gate LE (the signal's own read), the calm-VIX skip of inverse leg
 *                entries CVI (the prior close's VIX ranked against its 252 sessions; offline, no knob), the overnight bond gate G1
 *                (the scan's own read), close-IBS's L25 (the IBS bar, with the trades it added past the old 0.15 bar) and its
 *                news gate C1 (the scan's own read). Each: status (armed / shadow / offline), verdict (pass / would_refuse /
 *                no_reading), the rule, the reading, the ledger row that scores it. Nothing here refuses anything.
 *   if_neither   THE IN-BETWEEN BRANCH: checkpoints (the leg at + 30 / 60 / 120 minutes before 15:50; close-IBS at the next
 *                session's 10:00 / 12:00 / 14:00; the month-end book at + 1 / + 2 sessions), each with the expected move by then
 *                and the two levels a time/progress rule would read (below the entry; below half the expected move). Its action
 *                is HOLD: no such rule passed its static test on the armed design's replays (ledger
 *                plan-tier0-in-between-time-progress-2010-2026, kept local like every ledger row). The overnight book has no
 *                in-between: the market is closed between its 15:55 buy and its 09:40 sale.
 *   if_expected / if_wrong   the same rules in a sentence each, for a reader.
 *
 * TRADER_TRADE_PLAN=shadow turns it on (any other value is off). One trade_plan row per placed entry under the user
 * 'trade-plan' (never entry/exit, so no P&L reader counts it), after the order; never awaited; a failure still writes the row,
 * with plan_why. A pass more than 10 minutes off the real clock (a replay) writes nothing, unless TWO_SLEEVE_FAKE_NOW is set
 * (the runner's dry rehearsal). Reads per entry: the traded fund's 5m bars; for the leg, the proxy's live and settled 5m bars;
 * the sleeve's own journal (entry and exit rows only); for an inverse leg entry, ^VIX's daily closes (once a day).
 */
const cal = require('./market-calendar');
const { noiseBand, NOISE_DECISIONS } = require('./trend-shadow');

const VERSION = 3;
const LOOKBACK = 14;                 // prior sessions' windows, as the noise band counts them
const MIN_WINDOWS = 10;              // with both prices
const BAR_MIN = 5;
const LEG_LAST_CHECK = 950;          // no leg checkpoint at or after 15:50: the de-carry and the late gate own that time
const LEG_CHECKS = [30, 60, 120];    // minutes after the entry
const C_CHECKS = [600, 720, 840];    // the next session's 10:00, 12:00, 14:00
const T_CHECKS = [1, 2];             // sessions after the entry, at the entry clock
const O_SELL_CLOCK = 580;            // the 09:40 price (the bar starting 09:35), lib/two-sleeve/overnight-scan.js SELL_BAR
const LATE_GATE_CLOCK = 930;         // the late-reversal gate sells at the 15:30 price (lib/two-sleeve/noise-scan.js)
const HISTORY_N = 120;               // closed trades read for the scenarios
const HIST_FROM_DAYS = 28, HIST_TO_DAYS = 7;   // the settled 5m window the noise scan merges under the live feed
const LEVERAGE = 3;                  // the leg's wrappers
const PROXY_OF = { UPRO: 'SPY', SPXL: 'SPY', SPXS: 'SPY', TQQQ: 'QQQ', SQQQ: 'QQQ', SOXL: 'SMH', SOXS: 'SMH' };
const INVERSE = new Set(['SPXS', 'SQQQ', 'SOXS', 'TZA', 'FAZ', 'SH', 'PSQ', 'SDS', 'QID']);
const TESTED = 'plan-tier0-in-between-time-progress-2010-2026';
const CLOCK_SKEW_MS = 10 * 60000;
let _vixDaily = null;                // { day, bars }: ^VIX's dailies, read once a day for the calm-VIX gate

const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const knob = (env) => String((env || process.env).TRADER_TRADE_PLAN || '').trim().toLowerCase();
const enabled = (env) => knob(env) === 'shadow';
const median = (v) => { const a = [...v].sort((x, y) => x - y); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const num = (v, d) => { const x = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(x) ? x : d; };
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();   // 5 = Friday

/** The plan's kind from the signal the brain entered on: 'M' leg, 'C' close-IBS, 'O' overnight, 'T' month-end, 'S' the brain's own. */
function kindOf(signal) {
  const s = signal || {};
  if (s.noise_leg) return 'M';
  if (s.close_ibs) return 'C';
  if (s.overnight) return 'O';
  if (s.monthend) return 'T';
  return 'S';
}

/** Regular-session closes by day and bar start: { days: [day], at: Map(day -> Map(startMin -> close)) }. */
function sessionsOf(rawBars) {
  const at = new Map();
  for (const b of rawBars || []) {
    const t = Date.parse(b.timestamp != null ? b.timestamp : b.t);
    const c = Number(b.close != null ? b.close : b.c);
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const e = cal.etOf(t);
    if (!cal.inRegularSession(e.day, e.min)) continue;
    let m = at.get(e.day); if (!m) at.set(e.day, m = new Map());
    m.set(e.min, c);
  }
  return { days: [...at.keys()].sort(), at };
}
/** The price at a clock: the close of the bar starting five minutes before it (the scans' and the replay's own stamp). */
const priceAt = (S, day, clock) => { const m = S.at.get(day); const v = m && m.get(clock - BAR_MIN); return v > 0 ? v : null; };

/**
 * The expected move from (session j, startClock) to (session j + delta, endClock): the median |return| over the LOOKBACK most
 * recent windows that end before the entry (entryDay, entryClock), at least MIN_WINDOWS of them with both prices.
 * -> { move, n, of } or { why }.
 */
function expectedMove(S, { entryDay, entryClock, startClock, endClock, delta }) {
  const w = [];
  for (let j = 0; j + delta < S.days.length; j++) {
    const start = S.days[j], end = S.days[j + delta];
    if (!(start < entryDay)) break;
    if (!(end < entryDay || (end === entryDay && endClock < entryClock))) continue;
    const a = priceAt(S, start, startClock), b = priceAt(S, end, endClock);
    w.push(a && b ? Math.abs(b / a - 1) : null);
  }
  const last = w.slice(-LOOKBACK), vals = last.filter((v) => v != null);
  if (last.length < MIN_WINDOWS || vals.length < MIN_WINDOWS) return { why: `${vals.length} of ${last.length} prior windows have both prices (need ${MIN_WINDOWS})`, n: vals.length };
  return { move: round(median(vals), 5), n: vals.length, of: last.length };
}

/** The session `k` trading days after `day` (k >= 1), by the exchange calendar. */
function sessionAfter(day, k) { let d = day; for (let i = 0; i < k; i++) { d = cal.nextTradingDay(d); if (!d) return null; } return d; }
/** Sessions left in `day`'s month after `day` (the month's last session = 0). */
function sessionsLeft(day) { let n = 0, d = day; for (let i = 0; i < 31; i++) { const x = cal.nextTradingDay(d); if (!x || x.slice(0, 7) !== day.slice(0, 7)) break; n++; d = x; } return n; }
/** Epoch ms of an ET clock on a day. */
function msOf(day, min) {
  for (const off of [4, 5]) {
    const t = Date.parse(`${day}T00:00:00Z`) + (min + off * 60) * 60000;
    const e = cal.etOf(t); if (e.day === day && e.min === min) return t;
  }
  return null;
}
const isoAt = (day, min) => { const t = day && min != null ? msOf(day, min) : null; return t ? new Date(t).toISOString() : null; };
const before = (a, b) => a.day < b.day || (a.day === b.day && a.clock < b.clock);   // (day, clock) order

/** The sleeve's exit rules as configured right now (read from the env while this sleeve's env is the process env). */
function rulesOf(kind, env = process.env) {
  const r = { stop_pct: num(env.TRADER_STOP_MIN_PCT, null), loss_cap_pct: num(env.TRADER_MAX_LOSS_PCT, 8),
    loss_cap_rth_only: String(env.TRADER_MAX_LOSS_RTH_ONLY || '').trim() === '1',
    eod_flat: String(env.TRADER_EOD_FLAT || 'off').trim().toLowerCase(), eod_flat_min: num(env.TRADER_EOD_FLAT_MIN, num(env.TRADER_DECARRY_MIN, 950)) };
  if (kind === 'M') {
    r.decarry_min = num(env.TRADER_DECARRY_MIN, 950);
    r.decarry = env.TRADER_EOD_DECARRY !== '0';
    r.carry_downday_spy_pct = (() => { const v = num(env.TRADER_CARRY_DOWNDAY_SPY_PCT, 0); return v < 0 ? v : null; })();
    r.carry_symbols = String(env.TRADER_CARRY_DOWNDAY_SYMBOLS || 'SQQQ,SOXS,SPXS,TZA,FAZ').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    r.late_gate = String(env.TRADER_NOISE_LATE_GATE || '').trim() === '1';
  } else if (kind === 'C') {
    r.max_hold_sessions = num(env.TRADER_MAX_HOLD_SESSIONS, 0);
    r.ibs_max = num(env.TRADER_CLOSE_IBS_MAX, null);
    r.ibs_exit = num(env.TRADER_IBS_EXIT, null);
    r.sale_min = num(env.TRADER_EOD_FLAT_MIN, num(env.TRADER_DECARRY_MIN, 950));
  } else if (kind === 'O') {
    r.trend_n = num(env.TRADER_OVERNIGHT_TREND_N, 200);
  } else if (kind === 'T') {
    r.max_hold_sessions = num(env.TRADER_MAX_HOLD_SESSIONS, 0);
  }
  return r;
}

/** The thesis line and the signal's own reading, by kind. */
function thesisOf(kind, symbol, signal, scan) {
  const dc = (signal && signal.decision_context) || {};
  if (kind === 'M') {
    const pair = scan && scan.noise && Array.isArray(scan.noise.pairs) ? scan.noise.pairs.find((p) => p && p.proxy === dc.noise_proxy) : null;
    const side = dc.noise_side === 'dn' ? 'below' : 'above';
    return { signal: 'noise_band_break',
      why: `${dc.noise_proxy || 'the proxy'} closed ${side} its noise band at the ${dc.noise_bar || '?'} decision bar; long ${symbol}, the ${dc.noise_side === 'dn' ? 'inverse' : 'long'} wrapper`,
      reading: { proxy: dc.noise_proxy || null, side: dc.noise_side || null, bar: dc.noise_bar || null, proxy_close: pair ? pair.close : null,
        upper: pair ? pair.upper : null, lower: pair ? pair.lower : null, late_gate: dc.noise_late_gate != null ? dc.noise_late_gate : null,
        context_gate: dc.noise_context || null, wrapper_ibs: dc.ibs != null ? dc.ibs : null } };
  }
  if (kind === 'C') return { signal: 'close_ibs_washout', why: `${symbol} closed in the bottom of its session range (IBS ${dc.ibs != null ? dc.ibs : '?'}) at the ${dc.close_ibs_bar || '?'} bar; bought for the rebound into the next session`, reading: { ibs: dc.ibs != null ? dc.ibs : null, bar: dc.close_ibs_bar || null } };
  if (kind === 'O') return { signal: 'overnight_above_trend', why: `${symbol} above its trend at the ${dc.overnight_bar || '?'} bar; bought for the overnight move`, reading: { bar: dc.overnight_bar || null, above: dc.overnight_above != null ? dc.overnight_above : null } };
  if (kind === 'T') return { signal: 'monthend_bonds', why: `${symbol} bought ${dc.monthend_role === 'entry' ? 'with three sessions left in the month' : 'by the month-end book'} for the month-end drift`, reading: { role: dc.monthend_role || null, bar: dc.monthend_bar || null } };
  const pl = (signal && signal.plan) || {};
  return { signal: 'brain', why: `${symbol}: the brain's own entry (${(signal && signal.direction) || '?'})`, reading: { p_win: signal && signal.convergence ? signal.convergence.p_win : null, target1: pl.target1 != null ? pl.target1 : null, target2: pl.target2 != null ? pl.target2 : null, hold_days: pl.hold_days != null ? pl.hold_days : null } };
}

/** The compact market context from the entry-tags reading ({ gamma, news }), or its reason. */
function contextOf(ctx, orderId) {
  const out = { tags_ref: orderId != null ? String(orderId) : null };
  if (!ctx) { out.why = 'no entry-tags reading'; return out; }
  const g = ctx.gamma || {};
  out.gamma = g.tercile ? { tercile: g.tercile, rank: g.rank, as_of: g.as_of } : { why: g.why || 'no reading' };
  const n = ctx.news || {};
  if (n.overnight || n.session) {
    const ty = (w, k) => (w && w.types && w.types[k] ? w.types[k].tercile || null : null);
    const pick = (w) => (w ? { tercile: w.tercile || null, hours: w.hours != null ? w.hours : null, shock: ty(w, 'SHOCK'), rates: ty(w, 'RATES') } : null);
    out.news = { overnight: pick(n.overnight), session: pick(n.session), mix: n.mix || null };
  } else out.news = { why: n.why || 'no reading' };
  return out;
}

// ---- what each entry rule said about this entry (journal only) ----------------------------------------------------------------
const CVI_N = 252, CVI_MIN = Math.ceil(0.8 * CVI_N), CVI_CUT = 0.33;   // tier0-leg-inverse-skip-calm-vix-neighbours-2026-11: rank252 < 0.33
const VIX_DAYS = 400;                                                 // calendar days of ^VIX dailies read: more than 253 sessions
const L25_OLD_MAX = 0.15;                                             // close-IBS's IBS bar before L25 (the scan worker's default)
const GATE_LEDGER = { LE: 'live-engine-winrate-gates-shadow-2026-11', G1: 'live-engine-winrate-gates-shadow-2026-11',
  L25: 'live-engine-l25-c1-armed-2026-11', C1: 'live-engine-l25-c1-armed-2026-11', CVI: 'live-inverse-skip-calm-vix-forward-read-2027-01' };
const gateStatus = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return s === '1' ? 'armed' : s === 'shadow' ? 'shadow' : 'off'; };
/**
 * The calm-VIX read for an entry on `day`: the prior session's VIX close ranked against the 252 closes before it (the share
 * strictly lower, at least 80 % of them present), as the skip's static test ranked it. dailyBars = Yahoo-shaped ^VIX daily bars.
 */
function vixCalmRead(dailyBars, day) {
  const by = new Map();
  for (const b of dailyBars || []) {
    const t = Date.parse(b && (b.timestamp != null ? b.timestamp : b.t)); const c = Number(b && (b.close != null ? b.close : b.c));
    if (!Number.isFinite(t) || !(c > 0)) continue;
    const d = cal.etOf(t).day; if (d < day) by.set(d, c);
  }
  const days = [...by.keys()].sort();
  if (!days.length) return { why: 'no VIX closes before the entry day' };
  const i = days.length - 1, prior = by.get(days[i]);
  let lt = 0, n = 0; for (let k = Math.max(0, i - CVI_N); k < i; k++) { n++; if (by.get(days[k]) < prior) lt++; }
  const base = { as_of: days[i], vix: round(prior, 2), n };
  return n >= CVI_MIN ? { ...base, rank: round(lt / n, 4), calm: lt / n < CVI_CUT } : { ...base, why: `${n} closes before it; the rank needs ${CVI_MIN}` };
}
/**
 * What each entry rule said about this entry, armed or only recorded: { id, status (armed | shadow | offline), verdict (pass |
 * would_refuse | no_reading), rule, reading, ledger }. The reads are the scans' own (the leg's signal, the overnight and close-IBS
 * replies), so an armed rule's would_refuse means the plan saw a read the scan did not act on: a parity question, not a decision.
 */
function gatesOf(kind, { signal, scan, env = process.env, symbol, vix = null } = {}) {
  const dc = (signal && signal.decision_context) || {};
  const out = [];
  if (kind === 'M') {
    const st = gateStatus(env.TRADER_NOISE_CONTEXT_GATE);
    if (st !== 'off') {
      const g = dc.noise_context || null;
      out.push({ id: 'LE', status: st, verdict: !g || g.score == null ? 'no_reading' : g.open ? 'pass' : 'would_refuse',
        rule: 'a leg break the market backs: prior-session dealer gamma (LOW +1, HIGH -1) plus the sectors moving with it (4 of 8 or fewer -1, 7 of 8 or more +1); a score below 0 takes no new entry',
        reading: g ? { score: g.score != null ? g.score : null, why: g.why || null } : { why: 'the signal carried no context read' }, ledger: GATE_LEDGER.LE });
    }
    if (INVERSE.has(symbol)) {
      out.push({ id: 'CVI', status: 'offline', verdict: !vix || vix.rank == null ? 'no_reading' : vix.calm ? 'would_refuse' : 'pass',
        rule: `no inverse leg entry when the prior close's VIX ranks below ${CVI_CUT} of the ${CVI_N} closes before it`,
        reading: vix || { why: 'no VIX read' }, ledger: GATE_LEDGER.CVI });
    }
  } else if (kind === 'O') {
    const st = gateStatus(env.TRADER_OVERNIGHT_BOND_GATE);
    if (st !== 'off') {
      const b = scan && scan.overnight && scan.overnight.bond ? scan.overnight.bond : null;
      out.push({ id: 'G1', status: st, verdict: !b || b.ret_pct == null ? 'no_reading' : b.open ? 'pass' : 'would_refuse',
        rule: 'no overnight entry when TLT at 15:55 is down 0.30 % or more on the day',
        reading: b ? { ret_pct: b.ret_pct, why: b.why || null } : { why: 'the scan carried no bond read' }, ledger: GATE_LEDGER.G1 });
    }
  } else if (kind === 'C') {
    const ci = scan && scan.closeIbs ? scan.closeIbs : null;
    const max = num(ci && ci.ibsMax, num(env.TRADER_CLOSE_IBS_MAX, L25_OLD_MAX)), ibs = num(dc.ibs, null);
    if (max > L25_OLD_MAX) out.push({ id: 'L25', status: 'armed', verdict: ibs == null ? 'no_reading' : ibs <= max ? 'pass' : 'would_refuse',
      rule: `close-IBS buys at an IBS of ${max} or less (the bar was ${L25_OLD_MAX})`,
      reading: { ibs, max, old_max: L25_OLD_MAX }, band: ibs == null ? null : ibs > L25_OLD_MAX ? 'added_by_l25' : 'inside_old_bar', ledger: GATE_LEDGER.L25 });
    if (String(env.TRADER_CLOSE_IBS_NEWS_GATE || '').trim() === '1') {
      const g = ci && ci.gate ? ci.gate : null;
      out.push({ id: 'C1', status: 'armed', verdict: !g ? 'no_reading' : !g.open ? 'would_refuse' : /^no reading/.test(String(g.why || '')) ? 'no_reading' : 'pass',
        rule: 'no close-IBS entry unless the session\'s SHOCK headlines rank HIGH or the prior session\'s dealer gamma is LOW',
        reading: g ? { why: g.why || null, shock: g.shock && g.shock.tercile ? g.shock.tercile : null, gamma: g.gamma && g.gamma.tercile ? g.gamma.tercile : null } : { why: 'the scan carried no news-gate read' },
        ledger: GATE_LEDGER.C1 });
    }
  }
  return out;
}

/** The sleeve's own planned exit by kind: { day, clock, delta, rule, why } (delta = sessions after the entry day). */
function plannedExit(kind, entryDay, entryClock, rules) {
  if (kind === 'M') { const off = cal.closeOffset(entryDay); const clock = Math.max(entryClock + BAR_MIN, (rules.decarry_min || 950) - off); return { day: entryDay, clock, delta: 0, rule: 'decarry', why: `the de-carry at ${hhmm(clock)}` }; }
  if (kind === 'C') { const d = sessionAfter(entryDay, Math.max(1, rules.max_hold_sessions || 1)); const clock = d ? (rules.sale_min || 950) - cal.closeOffset(d) : null; return { day: d, clock, delta: Math.max(1, rules.max_hold_sessions || 1), rule: 'max_hold', why: `the max-hold sale at the ${hhmm(clock || 950)} price` }; }
  if (kind === 'O') { const d = sessionAfter(entryDay, 1); return { day: d, clock: O_SELL_CLOCK, delta: 1, rule: 'sale_0940', why: 'the 09:40 sale' }; }
  if (kind === 'T') { const left = sessionsLeft(entryDay); const d = left > 0 ? sessionAfter(entryDay, left) : null; return { day: d, clock: d ? entryClock + cal.closeOffset(entryDay) - cal.closeOffset(d) : null, delta: left, rule: 'calendar', why: `the month's last session (${left} after the entry)` }; }
  return { day: null, clock: null, delta: null, rule: null, why: 'the brain\'s own exits' };
}

/**
 * The Friday weekend flat (auto-trader.js: TRADER_EOD_FLAT 'weekend' sells every held long from TRADER_EOD_FLAT_MIN to the close of a
 * Friday; 'all' does it every session): the first such window the trade would still be held in, before its planned exit, or null.
 */
function weekendFlatAt(entryDay, entryClock, exit, r) {
  if (!(r.eod_flat === 'weekend' || r.eod_flat === 'all') || !exit || !exit.day) return null;
  for (let d = entryDay, i = 0; d && d <= exit.day && i < 40; d = cal.nextTradingDay(d), i++) {
    if (!(r.eod_flat === 'all' || weekday(d) === 5)) continue;
    const clock = Math.max(r.eod_flat_min - cal.closeOffset(d), d === entryDay ? entryClock + 1 : 0);
    if (before({ day: d, clock }, exit) || (d === exit.day && clock === exit.clock)) return { day: d, clock, delta: cal.sessionsBetween(entryDay, d) };
  }
  return null;
}

/** The in-between checkpoints by kind, before the earliest exit. */
function checkpointsOf(kind, entryDay, entryClock, exit) {
  const out = [];
  if (kind === 'M') {
    const last = LEG_LAST_CHECK - cal.closeOffset(entryDay);
    for (const m of LEG_CHECKS) { const clock = entryClock + m; if (clock < last && (exit.clock == null || before({ day: entryDay, clock }, exit))) out.push({ id: `M+${m}`, day: entryDay, clock, delta: 0 }); }
  } else if (kind === 'C') {
    const d = sessionAfter(entryDay, 1);
    if (d) for (const clock of C_CHECKS) if (clock < cal.closeMin(d) - 10 && !(exit.day && !before({ day: d, clock }, exit))) out.push({ id: `C@${hhmm(clock)}`, day: d, clock, delta: 1 });
  } else if (kind === 'T') {
    for (const k of T_CHECKS) { if (exit.delta != null && k >= exit.delta) continue; const d = sessionAfter(entryDay, k); if (!d) continue; const clock = entryClock + cal.closeOffset(entryDay) - cal.closeOffset(d); if (exit.day && !before({ day: d, clock }, exit)) continue; out.push({ id: `T+${k}`, day: d, clock, delta: k }); }
  }
  return out;
}

/**
 * The leg's band exit levels: the proxy's noise band (lib/trend-shadow.js noiseBand, the scan's own) at each half-hour decision clock
 * after the entry and before the exit, on the trade's side (the long wrapper is sold on a completed bar at or under the UPPER line, the
 * inverse wrapper on one at or over the LOWER line), with the wrapper price that roughly matches (3 x the proxy's move from the entry
 * bar). proxyBars = the proxy's live + settled 5m bars. -> { proxy, side, proxy_at_entry, levels: [{ at, clock, proxy, wrapper_approx }] }
 * or { why }.
 */
function bandLevels(proxyBars, { proxy, side, day, entryClock, exitClock, entryPrice, leverage = LEVERAGE }) {
  if (!proxyBars || !proxyBars.length) return { why: 'no proxy bars' };
  const band = noiseBand(proxyBars, day);
  if (!band || typeof band.at !== 'function') return { why: (band && band.why) || 'no band' };
  const S = sessionsOf(proxyBars); const p0 = priceAt(S, day, entryClock);
  if (!p0) return { why: 'no proxy price at the entry bar' };
  const sgn = side === 'dn' ? -1 : 1; const levels = [];
  for (const start of NOISE_DECISIONS) {
    const clock = start + BAR_MIN;
    if (clock <= entryClock || (exitClock != null && clock >= exitClock)) continue;
    const b = band.at(start); if (!b) continue;
    const lvl = side === 'dn' ? b.lower : b.upper;
    levels.push({ at: isoAt(day, clock), clock: hhmm(clock), proxy: round(lvl, 4), wrapper_approx: entryPrice > 0 ? round(entryPrice * (1 + leverage * sgn * (lvl / p0 - 1)), 4) : null });
  }
  return { proxy, side, proxy_at_entry: round(p0, 4), rule: side === 'dn' ? `sold on a completed 5m bar of ${proxy} at or over its lower band` : `sold on a completed 5m bar of ${proxy} at or under its upper band`, levels };
}

/** Every rule that can close the trade, with its level. */
function exitsOf(kind, { r, symbol, price, stop, exit, flat, levels, entryDay, entryClock }) {
  const out = [];
  if (kind === 'M') out.push({ rule: 'band_exit', type: 'invalidation', when: levels && levels.rule ? levels.rule : 'a completed 5m bar of the proxy back inside its noise band or through it', levels: levels && levels.levels ? levels.levels : null, levels_why: levels && levels.why ? levels.why : undefined, in_replay: true });
  if (stop != null) out.push({ rule: 'stop', type: 'stop', price: stop, pct: r.stop_pct, acts: 'the broker stop, regular hours', in_replay: true });
  if (r.loss_cap_pct > 0 && price > 0) out.push({ rule: 'loss_cap', type: 'stop', price: round(price * (1 - r.loss_cap_pct / 100), 4), pct: r.loss_cap_pct,
    acts: r.loss_cap_rth_only ? 'regular hours only' : 'regular AND extended hours (04:00-09:30, 16:00-20:00)', in_replay: r.loss_cap_rth_only,
    note: r.loss_cap_rth_only ? undefined : 'the replay never sells in the extended hours: a cap sale there is outside the measured design' });
  if (kind === 'M') {
    if (r.late_gate && LATE_GATE_CLOCK - cal.closeOffset(entryDay) > entryClock) out.push({ rule: 'late_gate', type: 'time', at: isoAt(entryDay, LATE_GATE_CLOCK - cal.closeOffset(entryDay)), when: 'sold at the 15:30 price on a day the pair\'s late-reversal gate is on (read from the sessions before today)', in_replay: true });
    if (r.decarry) out.push({ rule: 'decarry', type: 'time', at: isoAt(exit.day, exit.clock), in_replay: true });
    if (r.carry_downday_spy_pct != null && r.carry_symbols.includes(symbol)) {
      const fri = flat && flat.day === entryDay;
      out.push({ rule: 'carry_downday', type: 'carry', when: `held overnight instead of the de-carry when SPY's regular session is at or below ${r.carry_downday_spy_pct} % at the de-carry; then the next session's band exit, stop or cap sells it`,
        applies: !fri, why: fri ? `before a weekend the weekend flat sells it at ${hhmm(flat.clock)}: no weekend carry` : undefined, in_replay: true });
    }
  }
  if (kind === 'C') out.push({ rule: 'max_hold', type: 'time', at: isoAt(exit.day, exit.clock), in_replay: true });
  if (kind === 'O') out.push({ rule: 'sale_0940', type: 'time', at: isoAt(exit.day, exit.clock), in_replay: true });
  if (kind === 'T') out.push({ rule: 'calendar', type: 'time', at: isoAt(exit.day, exit.clock), in_replay: true });
  if (flat) out.push({ rule: 'weekend_flat', type: 'time', at: isoAt(flat.day, flat.clock), when: r.eod_flat === 'all' ? 'flat into every close' : 'flat into Friday\'s close', in_replay: true });
  return out;
}

// ---- what usually happens: the sleeve's own closed trades ----------------------------------------------------------------------
const tOfRow = (r) => Date.parse(r && r.ts);
/** The branch that closed a trade, from its journal rows. Shared with the forward read. */
function branchOf(kind, entryRow, exitRow) {
  const reason = String((exitRow && exitRow.reason) || '');
  const te = tOfRow(entryRow), tx = tOfRow(exitRow);
  const multi = Number.isFinite(te) && Number.isFinite(tx) && cal.etOf(tx).day > cal.etOf(te).day;
  if (kind === 'M' && multi) return /^max_loss/.test(reason) ? 'carried_then_cap' : 'carried';
  if (/^max_loss/.test(reason)) return 'loss_cap';
  if (/^eod_flat_weekend|^eod_flat\b/.test(reason)) return 'weekend_flat';
  if (/^max_hold/.test(reason)) return 'max_hold';
  if (/^eod_decarry/.test(reason)) return 'decarry';
  if (/broker fill|stop/i.test(reason)) return 'stop';
  if (kind === 'M') { const m = Number.isFinite(tx) ? cal.etOf(tx).min : null; return m != null && m >= LATE_GATE_CLOCK && m < LATE_GATE_CLOCK + 5 ? 'late_gate' : 'band_exit'; }
  if (kind === 'O') return 'sale_0940';
  if (kind === 'T') return 'calendar';
  if (/^signal_exit/.test(reason)) return 'signal_exit';   // the brain's own signal exit (on close-IBS, gated by TRADER_IBS_EXIT)
  const tok = reason.trim().split(/[\s(]/)[0];
  return tok ? `other:${tok}` : 'other';                    // a reason no rule here names: shown as it is, never labelled retired
}
/**
 * Why the sleeve's CURRENT configuration can no longer produce this closing branch, or null when it can. The history keeps the
 * old exits (they are what happened) and labels them, so what usually happens can be read under today's rules.
 */
function retiredWhy(kind, branch, r, env = process.env) {
  if (!r) return null;
  switch (branch) {
    case 'loss_cap': return r.loss_cap_pct > 0 ? null : 'the loss cap is off now (TRADER_MAX_LOSS_PCT is 0)';
    case 'weekend_flat': return r.eod_flat === 'weekend' || r.eod_flat === 'all' ? null : `the weekend flat is off now (TRADER_EOD_FLAT is ${r.eod_flat})`;
    case 'max_hold': return num(env.TRADER_MAX_HOLD_SESSIONS, 0) > 0 ? null : 'no max hold now (TRADER_MAX_HOLD_SESSIONS is 0)';
    case 'late_gate': return kind !== 'M' || r.late_gate ? null : 'the late gate is off now (TRADER_NOISE_LATE_GATE is not 1)';
    case 'decarry': return kind !== 'M' || r.decarry ? null : 'the de-carry is off now (TRADER_EOD_DECARRY=0)';
    case 'carried': case 'carried_then_cap':
      if (kind !== 'M') return null;
      if (r.decarry && r.carry_downday_spy_pct == null) return 'no rule carries a leg trade now (the de-carry is on, the down-day carry is off): a carry now means a failed sale';
      return branch === 'carried_then_cap' && !(r.loss_cap_pct > 0) ? 'the loss cap is off now (TRADER_MAX_LOSS_PCT is 0)' : null;
    case 'signal_exit': { const x = num(env.TRADER_IBS_EXIT, 0); return x > 1 ? `the brain's signal exit cannot sell now: TRADER_IBS_EXIT=${x} waits for a session IBS above 1, which never happens` : null; }
    default: return null;   // band_exit, stop, sale_0940 and calendar are the sleeve's own rules; other:<reason> is shown as it is
  }
}
/** Closed trades from journal rows (entry and exit rows, any order): each exit paired with the latest entry of its symbol before it. */
function closedTrades(rows) {
  const xs = (rows || []).filter((r) => r && (r.event === 'entry' || r.event === 'exit') && r.user !== 'trade-plan' && Number.isFinite(tOfRow(r))).sort((a, b) => tOfRow(a) - tOfRow(b));
  const open = new Map(), out = [];
  for (const r of xs) {
    const sym = String(r.symbol || '').toUpperCase();
    if (r.event === 'entry') open.set(sym, r);
    else { const e = open.get(sym); if (e) { out.push({ entry: e, exit: r }); open.delete(sym); } }
  }
  return out;
}
/** The scenarios (the sleeve's last HISTORY_N closed trades before `now`, by branch) and today's context for `symbol`. */
function historyStats(kind, rows, { now, symbol, r = null, env = process.env }) {
  const all = closedTrades(rows).filter((t) => tOfRow(t.exit) < now);
  const last = all.slice(-HISTORY_N);
  const pct = (t) => { const p = Number(t.exit.pnl_pct); if (Number.isFinite(p)) return p; const a = Number(t.exit.entry), b = Number(t.exit.exit); return a > 0 && b > 0 ? 100 * (b / a - 1) : null; };
  const winRate = (p) => (p.length ? round(p.filter((v) => v > 0).length / p.length, 3) : null);
  const by = new Map();
  for (const t of last) { const k = branchOf(kind, t.entry, t.exit); if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
  // the exits today's configuration can no longer produce: kept, labelled
  const retired = new Map(); for (const k of by.keys()) { const w = retiredWhy(kind, k, r, env); if (w) retired.set(k, w); }
  const cur = last.filter((t) => !retired.has(branchOf(kind, t.entry, t.exit)));
  const branches = [...by.entries()].map(([branch, ts]) => {
    const p = ts.map(pct).filter((v) => v != null);
    const b = { branch, n: ts.length, share: round(ts.length / last.length, 3), mean_pct: round(mean(p), 3), win_rate: winRate(p),
      median_min: round(median(ts.map((t) => (tOfRow(t.exit) - tOfRow(t.entry)) / 60000)), 0) };
    if (retired.has(branch)) { b.retired = true; b.why = retired.get(branch); }
    else if (retired.size && cur.length) b.share_current = round(ts.length / cur.length, 3);
    return b;
  }).sort((a, b) => b.n - a.n);
  const pAll = last.map(pct).filter((v) => v != null);
  const scenarios = last.length
    ? { basis: `the sleeve's last ${last.length} closed trades in its own journal`, from: last[0].exit.ts, n: last.length, mean_pct: round(mean(pAll), 3), win_rate: winRate(pAll), branches }
    : { why: 'no closed trades in the journal yet', n: 0, branches: [] };
  if (retired.size) {
    const pCur = cur.map(pct).filter((v) => v != null);
    scenarios.retired_n = last.length - cur.length;
    scenarios.current = { basis: 'the same trades without the retired branches: what usually happens under today\'s rules', n: cur.length, mean_pct: round(mean(pCur), 3), win_rate: winRate(pCur) };
  }
  // today, before this entry
  const day = cal.etOf(now).day, sym = String(symbol || '').toUpperCase();
  const todays = (rows || []).filter((r) => r && r.event === 'entry' && r.user !== 'trade-plan' && tOfRow(r) < now - 1000 && cal.etOf(tOfRow(r)).day === day);
  const same = todays.filter((r) => String(r.symbol || '').toUpperCase() === sym);
  const closedToday = all.filter((t) => String(t.exit.symbol || '').toUpperCase() === sym && cal.etOf(tOfRow(t.exit)).day === day);
  const lastSame = closedToday[closedToday.length - 1];
  const today = { entries_before: todays.length, same_fund_before: same.length, reentry: same.length > 0,
    same_fund_closed_pnl: closedToday.length ? round(closedToday.reduce((s, t) => s + (Number(t.exit.pnl) || 0), 0), 2) : 0,
    last_same_exit: lastSame ? { at: lastSame.exit.ts, reason: String(lastSame.exit.reason || '').replace(/\s*\(.*$/, ''), pnl: Number(lastSame.exit.pnl) || 0 } : null };
  return { scenarios, today };
}

/**
 * The plan for one entry (pure). entry = { symbol, price, qty, stop, now, order_id, account }; signal = the scan signal the brain
 * entered on; scan = the scan (for the leg's band at the entry bar); bars = the traded fund's 5m bars; proxyBars = the leg proxy's
 * live + settled 5m bars; history = the sleeve's journal rows (entry and exit); ctx = readContext().
 */
function buildPlan({ entry, signal, scan = null, bars = null, proxyBars = null, history = null, ctx = null, env = process.env, barsWhy = null, proxyWhy = null, historyWhy = null, vixBars = null, vixWhy = null } = {}) {
  const e = entry || {};
  const kind = kindOf(signal);
  const now = Number(e.now) || Date.now();
  const et = cal.etOf(now);
  const symbol = String(e.symbol || '').toUpperCase();
  // the entry clock: the bar the decision read (the scans stamp it hh:mm), else the clock rounded down to the bar grid
  const dc = (signal && signal.decision_context) || {};
  const stamp = dc.noise_bar || dc.close_ibs_bar || dc.overnight_bar || dc.monthend_bar || null;
  const fromStamp = stamp && /^\d\d:\d\d$/.test(stamp) ? Number(stamp.slice(0, 2)) * 60 + Number(stamp.slice(3)) : null;
  const entryClock = fromStamp != null && Math.abs(fromStamp - et.min) <= 15 ? fromStamp : et.min - (et.min % BAR_MIN);
  const price = Number(e.price);
  const stop = e.stop != null && Number.isFinite(Number(e.stop)) ? round(Number(e.stop), 4) : null;
  const r = rulesOf(kind, env);
  const own = plannedExit(kind, et.day, entryClock, r);
  const flat = kind === 'S' ? null : weekendFlatAt(et.day, entryClock, own, r);
  const exit = flat && before(flat, own) ? { ...flat, rule: 'weekend_flat', why: `the Friday weekend flat at ${hhmm(flat.clock)} (before ${own.why})` } : own;
  const S = bars ? sessionsOf(bars) : null;
  const plan = { event: 'trade_plan', v: VERSION, mode: 'shadow', kind, symbol, account: e.account || null, order_id: e.order_id != null ? String(e.order_id) : null,
    entry: { at: new Date(now).toISOString(), day: et.day, clock: hhmm(entryClock), price: round(price, 4), qty: Number(e.qty) || null, notional: price > 0 && e.qty ? Math.round(price * e.qty) : null, stop },
    thesis: { ...thesisOf(kind, symbol, signal, scan), context: contextOf(ctx, e.order_id) } };
  // what each entry rule said (gatesOf keeps the calm-VIX read for an inverse leg entry only)
  const vix = kind === 'M' ? (vixBars ? vixCalmRead(vixBars, et.day) : { why: vixWhy || 'no VIX bars' }) : null;
  plan.gates = gatesOf(kind, { signal, scan, env, symbol, vix });
  // expected path
  const expected = { exit_by: isoAt(exit.day, exit.clock), exit_rule: exit.why, basis: `the median |return| of ${symbol} over the same window in the ${LOOKBACK} prior sessions (at least ${MIN_WINDOWS})` };
  if (!S) expected.why = barsWhy || 'no bars';
  else if (exit.day == null || exit.clock == null) expected.why = 'no planned exit time';
  else {
    const m = expectedMove(S, { entryDay: et.day, entryClock, startClock: entryClock, endClock: exit.clock, delta: exit.delta });
    if (m.move != null) Object.assign(expected, { move: m.move, n: m.n, target: price > 0 ? round(price * (1 + m.move), 4) : null });
    else expected.why = m.why;
  }
  plan.expected = expected;
  // every exit rule, with its level
  let levels = null;
  if (kind === 'M') {
    const proxy = dc.noise_proxy || PROXY_OF[symbol] || null;
    const side = dc.noise_side || (INVERSE.has(symbol) ? 'dn' : 'up');
    levels = proxy ? (proxyBars ? bandLevels(proxyBars, { proxy, side, day: et.day, entryClock, exitClock: exit.day === et.day ? exit.clock : null, entryPrice: price }) : { why: proxyWhy || 'no proxy bars' }) : { why: 'no proxy for this wrapper' };
  }
  plan.exits = exitsOf(kind, { r, symbol, price, stop, exit, flat, levels, entryDay: et.day, entryClock });
  // what usually happens, and today
  if (kind !== 'S') {
    if (Array.isArray(history)) { const h = historyStats(kind, history, { now, symbol, r, env }); plan.scenarios = h.scenarios; plan.today = h.today; }
    else { plan.scenarios = { why: historyWhy || 'no journal read', n: 0, branches: [] }; plan.today = null; }
  }
  plan.if_expected = ifExpectedOf(kind, r, exit, symbol);
  plan.if_wrong = ifWrongOf(kind, r, stop, signal, levels, price);
  // the in-between branch
  const checks = [];
  for (const ck of checkpointsOf(kind, et.day, entryClock, exit)) {
    const row = { id: ck.id, at: isoAt(ck.day, ck.clock), not_in_profit_below: round(price, 4) };
    if (S) {
      const m = expectedMove(S, { entryDay: et.day, entryClock, startClock: entryClock, endClock: ck.clock, delta: ck.delta });
      if (m.move != null) Object.assign(row, { expected_move: m.move, behind_plan_below: price > 0 ? round(price * (1 + 0.5 * m.move), 4) : null, tighten_stop: `price at the check x (1 - ${round(0.5 * m.move, 5)})` });
      else row.why = m.why;
    } else row.why = barsWhy || 'no bars';
    if (kind === 'M' && levels && Array.isArray(levels.levels)) { const lv = levels.levels.find((x) => x.clock === hhmm(ck.clock)); if (lv) row.band_exit_proxy = lv.proxy; }
    checks.push(row);
  }
  plan.if_neither = kind === 'O'
    ? { action: 'HOLD', why: 'no in-between: the market is closed between the 15:55 buy and the 09:40 sale (extended-hours stops lost money: tier0-overnight-ext-hours-stop)', checks: [] }
    : kind === 'S'
      ? { action: 'HOLD', why: 'the brain\'s own exits manage it; no in-between rule has been tested for this sleeve', checks: [] }
      : { action: 'HOLD', why: `journal only: no time/progress rule passed its static test (${TESTED})`, tested: TESTED,
        rule_read: 'at each check: not_in_profit = price < not_in_profit_below; behind_plan = price < behind_plan_below', checks };
  return plan;
}

function ifExpectedOf(kind, r, exit, symbol) {
  if (kind === 'M') return { rule: `held while the proxy stays outside its noise band, sold ${exit.why}`
    + (r.carry_downday_spy_pct != null && r.carry_symbols.includes(symbol) ? `; carried overnight instead when SPY's session is at or below ${r.carry_downday_spy_pct} %` : '')
    + (r.late_gate ? '; the late-reversal gate sells at the 15:30 price on days its gate is on' : '')
    + (r.eod_flat === 'weekend' ? '; flat before a weekend' : '') };
  if (kind === 'C') return { rule: `held to ${exit.why} of the next session (max hold ${r.max_hold_sessions || 1} session)` };
  if (kind === 'O') return { rule: `sold at ${exit.why} of the next session` };
  if (kind === 'T') return { rule: `held to ${exit.why}` };
  return { rule: 'the brain\'s own exits' };
}
function ifWrongOf(kind, r, stop, signal, levels, price) {
  const cap = r.loss_cap_pct > 0 && price > 0 ? `the ${r.loss_cap_pct} % loss cap at ${round(price * (1 - r.loss_cap_pct / 100), 4)} (${r.loss_cap_rth_only ? 'regular hours only' : 'it also sells in the extended hours'})` : null;
  const out = { stop, stop_pct: r.stop_pct, loss_cap: cap };
  if (kind === 'M') out.invalidation = levels && Array.isArray(levels.levels) && levels.levels.length
    ? `${levels.rule}: ${levels.levels.slice(0, 3).map((x) => `${x.clock} ${x.proxy}`).join(', ')}${levels.levels.length > 3 ? ' ...' : ''} (the leg's signal exit sells at once)`
    : 'the proxy\'s completed bar back inside its noise band, or through to the other side: the leg\'s signal exit sells at once';
  else if (kind === 'C') out.invalidation = 'none beyond the stop and the cap: holding to the next session is the measured optimum (tier0-c-exit-session-band-break REVERSED)';
  else if (kind === 'O') out.invalidation = 'none beyond the stop, the cap and the 09:40 sale';
  else if (kind === 'T') out.invalidation = 'none beyond the stop and the cap';
  else { const pl = (signal && signal.plan) || {}; out.invalidation = pl.stop != null ? `the brain's plan stop ${pl.stop}` : 'the brain\'s own exits'; }
  return out;
}

/** Should a pass at `now` write a plan? Replays (off the real clock) do not; the runner's dry rehearsal does. */
function liveClock(now, env = process.env) {
  if (String(env.TWO_SLEEVE_FAKE_NOW || '').trim()) return true;
  return Math.abs((Number(now) || Date.now()) - Date.now()) <= CLOCK_SKEW_MS;
}

/** Journal text -> its entry and exit rows (only those lines are parsed). */
function parseHistory(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    if (!l || !(l.includes('"event":"entry"') || l.includes('"event":"exit"'))) continue;
    try { const r = JSON.parse(l); if (r.event === 'entry' || r.event === 'exit') out.push(r); } catch (_e) { /* a torn line */ }
  }
  return out;
}

/**
 * Write one plan for a placed entry; never awaited by the caller. opts = { log(row), getBars(sym, tf), getHistory(sym, from, to),
 * getDaily(sym, from, to), readJournal() -> text, readContext(), env, signal, scan }. The env is captured by the caller synchronously (the engine swaps env per
 * sleeve), so a late read cannot see another sleeve's knobs.
 */
async function write(entry, opts = {}) {
  const { log, getBars, getHistory = null, readJournal = null, readContext = null, env = process.env } = opts;
  if (typeof log !== 'function') return null;
  if (!liveClock(entry && entry.now, env)) return null;
  const read = async (fn) => { try { const r = await fn(); return { bars: r && Array.isArray(r.bars) ? r.bars : Array.isArray(r) ? r : null, err: r && r.error ? r.error : null }; } catch (e) { return { bars: null, err: e && e.message }; } };
  let bars = null, barsWhy = null, proxyBars = null, proxyWhy = null, history = null, historyWhy = null, ctx = null;
  if (typeof getBars === 'function') {
    const b = await read(() => getBars(entry.symbol, '5m'));
    if (b.bars && b.bars.length) bars = b.bars; else barsWhy = b.err ? `bars read failed: ${b.err}` : 'no bars from the feed';
  } else barsWhy = 'no bars reader';
  if (kindOf(opts.signal) === 'M' && typeof getBars === 'function') {
    const dc = (opts.signal && opts.signal.decision_context) || {}; const proxy = dc.noise_proxy || PROXY_OF[String(entry.symbol || '').toUpperCase()];
    if (proxy) {
      const live = await read(() => getBars(proxy, '5m'));
      const day0 = Date.parse(`${cal.etOf(Number(entry.now) || Date.now()).day}T12:00:00Z`);
      const old = typeof getHistory === 'function' ? await read(() => getHistory(proxy, day0 - HIST_FROM_DAYS * 86400000, day0 - HIST_TO_DAYS * 86400000)) : { bars: [] };
      const seen = new Map(); for (const x of [...(old.bars || []), ...(live.bars || [])]) { const t = x && (x.timestamp != null ? x.timestamp : x.t); if (t != null) seen.set(String(Date.parse(t)), x); }
      proxyBars = [...seen.values()];
      if (!proxyBars.length) { proxyBars = null; proxyWhy = live.err ? `proxy bars read failed: ${live.err}` : 'no proxy bars from the feed'; }
    } else proxyWhy = 'no proxy for this wrapper';
  }
  if (typeof readJournal === 'function') { try { history = parseHistory(await readJournal()); } catch (e) { history = null; historyWhy = `journal read failed: ${e && e.message}`; } }
  try { ctx = typeof readContext === 'function' ? readContext() : null; } catch (_e) { ctx = null; }
  // the calm-VIX read: ^VIX's dailies, once a day, for an inverse leg entry only
  let vixBars = null, vixWhy = null;
  if (kindOf(opts.signal) === 'M' && INVERSE.has(String((entry && entry.symbol) || '').toUpperCase())) {
    const now0 = Number(entry.now) || Date.now(), day = cal.etOf(now0).day;
    if (_vixDaily && _vixDaily.day === day) vixBars = _vixDaily.bars;
    else if (typeof opts.getDaily === 'function') {
      const v = await read(() => opts.getDaily('^VIX', now0 - VIX_DAYS * 86400000, now0));
      if (v.bars && v.bars.length) { vixBars = v.bars; _vixDaily = { day, bars: v.bars }; } else vixWhy = v.err ? `VIX read failed: ${v.err}` : 'no VIX bars from the feed';
    } else vixWhy = 'no daily reader';
  }
  let row;
  try { row = buildPlan({ entry, signal: opts.signal, scan: opts.scan, bars, proxyBars, history, ctx, env, barsWhy, proxyWhy, historyWhy, vixBars, vixWhy }); }
  catch (e3) { row = { event: 'trade_plan', v: VERSION, mode: 'shadow', symbol: String((entry && entry.symbol) || '').toUpperCase(), order_id: entry && entry.order_id != null ? String(entry.order_id) : null, plan_why: `plan failed: ${e3 && e3.message}` }; }
  try { log(row); } catch (_e) { /* journal only */ }
  return row;
}

module.exports = { buildPlan, write, enabled, knob, kindOf, sessionsOf, priceAt, expectedMove, plannedExit, checkpointsOf, rulesOf, liveClock, msOf, sessionsLeft,
  weekendFlatAt, bandLevels, exitsOf, branchOf, retiredWhy, closedTrades, historyStats, parseHistory, gatesOf, gateStatus, vixCalmRead,
  _resetVixDaily: () => { _vixDaily = null; },
  VERSION, LOOKBACK, MIN_WINDOWS, LEG_CHECKS, C_CHECKS, T_CHECKS, LEG_LAST_CHECK, HISTORY_N, TESTED, CVI_N, CVI_CUT, L25_OLD_MAX, GATE_LEDGER };
