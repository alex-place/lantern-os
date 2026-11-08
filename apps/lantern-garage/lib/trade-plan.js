'use strict';
/**
 * lib/trade-plan.js — A TRADE PLAN ON EVERY ENTRY, JOURNAL ONLY (2026-11-08, operator: "every entry should still carry a written
 * plan: what we expect to happen, what we do if it happens, and what we do if it doesn't. That includes the in-between cases,
 * like a trade that never reaches its take-profit or its stop").
 *
 * The engine has no language model, so the plan comes from rules. It is written once, right after the entry, and nothing acts
 * on it:
 *   thesis       why the trade exists: the sleeve's signal (the leg's noise-band break, the close-IBS washout, the overnight book
 *                above its trend, the month-end bond book, or the brain's own entry), the signal's own reading, and the market
 *                context the entry tags keep (lib/entry-tags.js readContext: gamma and news from the shared files; nothing is
 *                fetched for the plan). The full entry_tags row joins on order_id.
 *   expected     the planned exit time and the expected move by then: the median |return| of the traded fund over the same clock
 *                window in the 14 prior sessions (at least 10 with both prices). Entry signs forecast the SIZE of a move, not its
 *                side, and a fund's own median move forecasts it as well as they do (ledger tier0-entry-signs-volume-residual,
 *                tier0-realistic-target-stop-fraction), so the plan uses the plain median. The target is the entry x (1 + move):
 *                a reading, not an order.
 *   if_expected  the sleeve's own exit rule as it is configured right now (the de-carry, the carry, the max hold, the sale bar).
 *   if_wrong     the stop the brain placed and the sleeve's invalidation rule (the leg's band exit; the 8 / 10 % broker stops).
 *   if_neither   THE IN-BETWEEN BRANCH: the checkpoints (the leg at + 30 / 60 / 120 minutes before 15:50; close-IBS at the next
 *                session's 10:00 / 12:00 / 14:00; the month-end book at + 1 / + 2 sessions), each with the expected move by then
 *                and the two levels a time/progress rule would read: below the entry (not in profit) and below half the
 *                expected move (behind plan). Its action is HOLD: no such rule passed its static test on the armed design's
 *                replays (ledger plan-tier0-in-between-time-progress-2010-2026, kept local like every ledger row), so the branch is
 *                journaled to be scored forward and acts on nothing. The overnight book has no in-between: the market is
 *                closed between its 15:55 buy and its 09:40 sale.
 *
 * TRADER_TRADE_PLAN=shadow turns it on (any other value is off). One trade_plan row per placed entry under the user
 * 'trade-plan' (never entry/exit, so no P&L reader counts it), after the order; never awaited; a failure still writes the row,
 * with plan_why. A pass more than 10 minutes off the real clock (a replay) writes nothing, unless TWO_SLEEVE_FAKE_NOW is set
 * (the runner's dry rehearsal).
 */
const cal = require('./market-calendar');

const VERSION = 1;
const LOOKBACK = 14;                 // prior sessions' windows, as the noise band counts them
const MIN_WINDOWS = 10;              // with both prices
const BAR_MIN = 5;
const LEG_LAST_CHECK = 950;          // no leg checkpoint at or after 15:50: the de-carry and the late gate own that time
const LEG_CHECKS = [30, 60, 120];    // minutes after the entry
const C_CHECKS = [600, 720, 840];    // the next session's 10:00, 12:00, 14:00
const T_CHECKS = [1, 2];             // sessions after the entry, at the entry clock
const O_SELL_CLOCK = 580;            // the 09:40 price (the bar starting 09:35), lib/two-sleeve/overnight-scan.js SELL_BAR
const TESTED = 'plan-tier0-in-between-time-progress-2010-2026';
const CLOCK_SKEW_MS = 10 * 60000;

const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const knob = (env) => String((env || process.env).TRADER_TRADE_PLAN || '').trim().toLowerCase();
const enabled = (env) => knob(env) === 'shadow';
const median = (v) => { const a = [...v].sort((x, y) => x - y); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };
const num = (v, d) => { const x = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(x) ? x : d; };

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

/** The sleeve's exit rules as configured right now (read from the env while this sleeve's env is the process env). */
function rulesOf(kind, env = process.env) {
  const stopPct = num(env.TRADER_STOP_MIN_PCT, null);
  const r = { stop_pct: stopPct };
  if (kind === 'M') {
    r.decarry_min = num(env.TRADER_DECARRY_MIN, 950);
    r.decarry = env.TRADER_EOD_DECARRY !== '0';
    r.carry_downday_spy_pct = (() => { const v = num(env.TRADER_CARRY_DOWNDAY_SPY_PCT, 0); return v < 0 ? v : null; })();
    r.carry_symbols = String(env.TRADER_CARRY_DOWNDAY_SYMBOLS || 'SQQQ,SOXS,SPXS,TZA,FAZ').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    r.late_gate = String(env.TRADER_NOISE_LATE_GATE || '').trim() === '1';
    r.eod_flat = String(env.TRADER_EOD_FLAT || 'off').trim().toLowerCase();
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

/** The planned exit by kind: { day, clock, delta, why } (delta = sessions after the entry day). */
function plannedExit(kind, entryDay, entryClock, rules) {
  if (kind === 'M') { const off = cal.closeOffset(entryDay); const clock = Math.max(entryClock + BAR_MIN, (rules.decarry_min || 950) - off); return { day: entryDay, clock, delta: 0, why: `the de-carry at ${hhmm(clock)}` }; }
  if (kind === 'C') { const d = sessionAfter(entryDay, Math.max(1, rules.max_hold_sessions || 1)); const clock = d ? (rules.sale_min || 950) - cal.closeOffset(d) : null; return { day: d, clock, delta: Math.max(1, rules.max_hold_sessions || 1), why: `the max-hold sale at the ${hhmm(clock || 950)} price` }; }
  if (kind === 'O') { const d = sessionAfter(entryDay, 1); return { day: d, clock: O_SELL_CLOCK, delta: 1, why: 'the 09:40 sale' }; }
  if (kind === 'T') { const left = sessionsLeft(entryDay); const d = left > 0 ? sessionAfter(entryDay, left) : null; return { day: d, clock: d ? entryClock + cal.closeOffset(entryDay) - cal.closeOffset(d) : null, delta: left, why: `the month's last session (${left} after the entry)` }; }
  return { day: null, clock: null, delta: null, why: 'the brain\'s own exits' };
}

/** The in-between checkpoints by kind, before the planned exit. */
function checkpointsOf(kind, entryDay, entryClock, exit) {
  const out = [];
  if (kind === 'M') {
    const last = LEG_LAST_CHECK - cal.closeOffset(entryDay);
    for (const m of LEG_CHECKS) { const clock = entryClock + m; if (clock < last && (exit.clock == null || clock < exit.clock)) out.push({ id: `M+${m}`, day: entryDay, clock, delta: 0 }); }
  } else if (kind === 'C') {
    const d = sessionAfter(entryDay, 1);
    if (d) for (const clock of C_CHECKS) if (clock < cal.closeMin(d) - 10 && !(exit.day === d && exit.clock != null && clock >= exit.clock)) out.push({ id: `C@${hhmm(clock)}`, day: d, clock, delta: 1 });
  } else if (kind === 'T') {
    for (const k of T_CHECKS) { if (exit.delta != null && k >= exit.delta) continue; const d = sessionAfter(entryDay, k); if (d) out.push({ id: `T+${k}`, day: d, clock: entryClock + cal.closeOffset(entryDay) - cal.closeOffset(d), delta: k }); }
  }
  return out;
}

/**
 * The plan for one entry (pure). entry = { symbol, price, qty, stop, now, order_id, account }; signal = the scan signal the brain
 * entered on; scan = the scan (for the leg's band); bars = the traded fund's 5m bars (the brain's own feed); ctx = readContext().
 */
function buildPlan({ entry, signal, scan = null, bars = null, ctx = null, env = process.env, barsWhy = null } = {}) {
  const e = entry || {};
  const kind = kindOf(signal);
  const now = Number(e.now) || Date.now();
  const et = cal.etOf(now);
  // the entry clock: the bar the decision read (the scans stamp it hh:mm), else the clock rounded down to the bar grid
  const dc = (signal && signal.decision_context) || {};
  const stamp = dc.noise_bar || dc.close_ibs_bar || dc.overnight_bar || dc.monthend_bar || null;
  const fromStamp = stamp && /^\d\d:\d\d$/.test(stamp) ? Number(stamp.slice(0, 2)) * 60 + Number(stamp.slice(3)) : null;
  const entryClock = fromStamp != null && Math.abs(fromStamp - et.min) <= 15 ? fromStamp : et.min - (et.min % BAR_MIN);
  const price = Number(e.price);
  const rules = rulesOf(kind, env);
  const exit = plannedExit(kind, et.day, entryClock, rules);
  const S = bars ? sessionsOf(bars) : null;
  const plan = { event: 'trade_plan', v: VERSION, mode: 'shadow', kind, symbol: String(e.symbol || '').toUpperCase(), account: e.account || null, order_id: e.order_id != null ? String(e.order_id) : null,
    entry: { at: new Date(now).toISOString(), day: et.day, clock: hhmm(entryClock), price: round(price, 4), qty: Number(e.qty) || null, notional: price > 0 && e.qty ? Math.round(price * e.qty) : null,
      stop: e.stop != null && Number.isFinite(Number(e.stop)) ? round(Number(e.stop), 4) : null },
    thesis: { ...thesisOf(kind, String(e.symbol || '').toUpperCase(), signal, scan), context: contextOf(ctx, e.order_id) } };
  // expected path
  const expected = { exit_by: isoAt(exit.day, exit.clock), exit_rule: exit.why, basis: `the median |return| of ${plan.symbol} over the same window in the ${LOOKBACK} prior sessions (at least ${MIN_WINDOWS})` };
  if (!S) expected.why = barsWhy || 'no bars';
  else if (exit.day == null || exit.clock == null) expected.why = 'no planned exit time';
  else {
    const m = expectedMove(S, { entryDay: et.day, entryClock, startClock: entryClock, endClock: exit.clock, delta: exit.delta });
    if (m.move != null) Object.assign(expected, { move: m.move, n: m.n, target: price > 0 ? round(price * (1 + m.move), 4) : null });
    else expected.why = m.why;
  }
  plan.expected = expected;
  plan.if_expected = ifExpectedOf(kind, rules, exit);
  plan.if_wrong = ifWrongOf(kind, rules, plan.entry.stop, signal);
  // the in-between branch
  const checks = [];
  for (const ck of checkpointsOf(kind, et.day, entryClock, exit)) {
    const row = { id: ck.id, at: isoAt(ck.day, ck.clock), not_in_profit_below: round(price, 4) };
    if (S) {
      const m = expectedMove(S, { entryDay: et.day, entryClock, startClock: entryClock, endClock: ck.clock, delta: ck.delta });
      if (m.move != null) Object.assign(row, { expected_move: m.move, behind_plan_below: price > 0 ? round(price * (1 + 0.5 * m.move), 4) : null, tighten_stop: `price at the check x (1 - ${round(0.5 * m.move, 5)})` });
      else row.why = m.why;
    } else row.why = barsWhy || 'no bars';
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

function ifExpectedOf(kind, r, exit) {
  if (kind === 'M') return { rule: `held while ${'the proxy'} stays outside its noise band, sold ${exit.why}`
    + (r.carry_downday_spy_pct != null ? `; an inverse wrapper (${r.carry_symbols.join(',')}) is carried overnight instead when SPY's session is at or below ${r.carry_downday_spy_pct} %` : '')
    + (r.late_gate ? '; the late-reversal gate sells at the 15:30 price on days its gate is on' : '')
    + (r.eod_flat === 'weekend' ? '; flat before a weekend' : '') };
  if (kind === 'C') return { rule: `held to ${exit.why} of the next session (max hold ${r.max_hold_sessions || 1} session)` };
  if (kind === 'O') return { rule: `sold at ${exit.why} of the next session` };
  if (kind === 'T') return { rule: `held to ${exit.why}` };
  return { rule: 'the brain\'s own exits' };
}
function ifWrongOf(kind, r, stop, signal) {
  const out = { stop, stop_pct: r.stop_pct };
  if (kind === 'M') out.invalidation = 'the proxy\'s completed bar back inside its noise band, or through to the other side: the leg\'s signal exit sells at once';
  else if (kind === 'C') out.invalidation = 'none beyond the stop: holding to the next session is the measured optimum (tier0-c-exit-session-band-break REVERSED)';
  else if (kind === 'O') out.invalidation = 'none beyond the stop and the 09:40 sale';
  else if (kind === 'T') out.invalidation = 'none beyond the stop';
  else { const pl = (signal && signal.plan) || {}; out.invalidation = pl.stop != null ? `the brain's plan stop ${pl.stop}` : 'the brain\'s own exits'; }
  return out;
}

/** Should a pass at `now` write a plan? Replays (off the real clock) do not; the runner's dry rehearsal does. */
function liveClock(now, env = process.env) {
  if (String(env.TWO_SLEEVE_FAKE_NOW || '').trim()) return true;
  return Math.abs((Number(now) || Date.now()) - Date.now()) <= CLOCK_SKEW_MS;
}

/**
 * Write one plan for a placed entry; never awaited by the caller. opts = { log(row), getBars(sym, tf), readContext(), env }.
 * The env is captured by the caller synchronously (the engine swaps env per sleeve), so a late bars read cannot see another
 * sleeve's knobs.
 */
async function write(entry, opts = {}) {
  const { log, getBars, readContext = null, env = process.env } = opts;
  if (typeof log !== 'function') return null;
  if (!liveClock(entry && entry.now, env)) return null;
  let bars = null, barsWhy = null, ctx = null;
  try { const r = typeof getBars === 'function' ? await getBars(entry.symbol, '5m') : null; bars = r && Array.isArray(r.bars) ? r.bars : Array.isArray(r) ? r : null; if (!bars || !bars.length) { barsWhy = (r && r.error) ? `bars read failed: ${r.error}` : 'no bars from the feed'; bars = null; } } catch (e2) { barsWhy = `bars read failed: ${e2 && e2.message}`; bars = null; }
  try { ctx = typeof readContext === 'function' ? readContext() : null; } catch (_e) { ctx = null; }
  let row;
  try { row = buildPlan({ entry, signal: opts.signal, scan: opts.scan, bars, ctx, env, barsWhy }); }
  catch (e3) { row = { event: 'trade_plan', v: VERSION, mode: 'shadow', symbol: String((entry && entry.symbol) || '').toUpperCase(), order_id: entry && entry.order_id != null ? String(entry.order_id) : null, plan_why: `plan failed: ${e3 && e3.message}` }; }
  try { log(row); } catch (_e) { /* journal only */ }
  return row;
}

module.exports = { buildPlan, write, enabled, knob, kindOf, sessionsOf, priceAt, expectedMove, plannedExit, checkpointsOf, rulesOf, liveClock, msOf, sessionsLeft,
  VERSION, LOOKBACK, MIN_WINDOWS, LEG_CHECKS, C_CHECKS, T_CHECKS, LEG_LAST_CHECK, TESTED };
