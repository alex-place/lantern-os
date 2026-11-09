'use strict';
/**
 * lib/plan-watch.js — THE PLAN WATCHDOG, ALERT ONLY (2026-11-08, operator: "yes, build 1 and 2", where 1 = enforce the plan during
 * the session: check each open position against its plan every minute and raise an alert within a minute instead of at the next
 * review; it only alerts, and re-sending a missed exit needs the operator's OK).
 *
 * WHY. The trader follows its rules (75 of 77 exits 10-19..11-06 came from its own rules), but its execution has failed before in
 * ways nobody saw until a later review: the broker refused 15 exits 10-02..10-24 because a stop's cancel had not settled
 * (fixed in #3780), and one refused de-carry carried SOXS overnight by mistake. Those look like a quiet day until someone reads
 * the journal. The plan says what should be true of every position at every moment; this checks it.
 *
 * Once per brain pass (about a minute in the session, five in the extended hours), from the pass's OWN broker reads (positions
 * and the orders feed; no extra call), each OPEN plan of this sleeve (a trade_plan row whose entry has no exit after it) against
 * the position:
 *   overdue_exit       still held 3 minutes after the plan's exit time (expected.exit_by). A down-day carry the brain recorded
 *                      (a plan_carry row, or its own carry_downday skip row) moves it to the next session's de-carry.
 *   unprotected        the plan listed a stop and the working sell orders cover fewer shares than are held, 3 passes running
 *                      (the brain cancels a stop just before it sells, and re-protects a naked long on the next pass).
 *   size_mismatch      the broker's quantity is not the plan's, 2 passes running; short_position (fewer than 0) at once.
 *   missing_position   no position and no exit row, 3 passes running: a fault once the position was seen, info if it never
 *                      appeared (the entry may not have filled).
 *   exit_outside_plan  an exit closed it by a rule its plan did not list (trade-plan.js branchOf against the plan's exits); a
 *                      loss-cap sale in the extended hours is listed but outside the measured design: info.
 *   unplanned_position a held position with no open plan, 2 passes running: info (held from before the sleeve wrote plans, or
 *                      a plan that failed).
 * A condition is journaled once when it starts (plan_alert, user 'trade-plan', level fault | info) and once when it clears
 * (plan_alert_cleared, with the minutes it lasted); an exit_outside_plan is said once. A fault also appends one line to the
 * ALERTS file (the file existing is the alarm, as C:/dev/trader-watchdog.js does it). Nothing here places, cancels or changes an
 * order: acting on an alert is the operator's decision.
 *
 * TRADER_PLAN_WATCH=alert turns it on (any other value is off). It reads the plans TRADER_TRADE_PLAN=shadow writes. The journal
 * is read incrementally (new bytes only); a relaunch rebuilds the open plans and the alerts in force from the journal itself, so
 * nothing is said twice across a restart.
 */
const fs = require('fs');
const cal = require('./market-calendar');
const tp = require('./trade-plan');

const GRACE_MS = 3 * 60000;          // a planned exit has 3 minutes to leave the book (the brain retries a refused sell, #3780)
const PERSIST = { overdue_exit: 1, short_position: 1, size_mismatch: 2, unplanned_position: 2, unprotected: 3, missing_position: 3 };
const STALE_MS = 24 * 3600000;       // a plan whose position is gone is left alone a day after its exit time
const NO_EXIT_STALE_MS = 30 * 86400000;
const KEEP_MS = 45 * 86400000;       // journal rows older than this are dropped from memory
const EXIT_LOOKBACK_MS = 10 * 60000; // exits this long before the first check of a process are still read against their plans
const ERROR_EVERY_MS = 3600000;
// the order statuses auto-trader.js counts as working / finished (STOP_WORKING / STOP_TERMINAL), plus a rejection
const WORKING = /submit|pending|presubmit|open|accepted|new|working|held/i;
const TERMINAL = /cancel|fill|done|expire|reject/i;
const EVENTS = ['trade_plan', 'entry', 'exit', 'plan_alert', 'plan_alert_cleared', 'plan_carry'];
// which plan rules can produce each closing branch (the forward read's map, shared here so both read adherence the same way)
const ALT = { band_exit: ['band_exit'], late_gate: ['late_gate', 'band_exit'], decarry: ['decarry', 'weekend_flat'], carried: ['carry_downday'], stop: ['stop'],
  loss_cap: ['loss_cap'], weekend_flat: ['weekend_flat', 'max_hold', 'decarry'], max_hold: ['max_hold', 'weekend_flat'], sale_0940: ['sale_0940'], calendar: ['calendar'] };

const knob = (env) => String((env || process.env).TRADER_PLAN_WATCH || '').trim().toLowerCase();
const enabled = (env) => knob(env) === 'alert';
const symOf = (x) => String((x && (x.symbol || x.ticker)) || '').toUpperCase();
const tsOf = (r) => Date.parse(r && r.ts);

/** Did the plan list the rule that closed the trade, and is that rule inside the measured design? */
function adherenceOf(plan, entryRow, exitRow) {
  const branch = tp.branchOf(plan.kind, entryRow, exitRow);
  const names = new Set((plan.exits || []).filter((x) => x && x.applies !== false).map((x) => x.rule));
  const inPlan = branch === 'carried_then_cap' ? names.has('carry_downday') && names.has('loss_cap') : (ALT[branch] || []).some((w) => names.has(w));
  const ext = !cal.isRegularHours(tsOf(exitRow));
  const inDesign = inPlan && !((branch === 'loss_cap' || branch === 'carried_then_cap') && ext);
  return { branch, in_plan: inPlan, in_design: inDesign, extended_hours: ext,
    why: !inPlan ? `the plan listed no ${branch} rule` : !inDesign ? 'the loss cap sold in the extended hours: the replay never does' : undefined };
}

// ---- the journal, read incrementally ------------------------------------------------------------------------------------------
const _state = new Map();   // journal path -> state
function stateOf(file) {
  let st = _state.get(file);
  if (!st) {
    st = { offset: 0, tail: '', plans: [], entries: [], exits: [], carries: [], newExits: [], active: new Map(), done: new Set(),
      counts: new Map(), seen: new Set(), firstPlanAt: null, startedAt: null, busy: false, errAt: 0 };
    _state.set(file, st);
  }
  return st;
}
async function readNew(file, st) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    // a shorter file is a new one (rotated or rewritten): read it again from the start; the alerts in force come back with it
    if (size < st.offset) Object.assign(st, { offset: 0, tail: '', plans: [], entries: [], exits: [], carries: [], newExits: [], firstPlanAt: null });
    if (size === st.offset) return [];
    const len = size - st.offset, buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, st.offset);
    st.offset += bytesRead;
    const lines = (st.tail + buf.toString('utf8', 0, bytesRead)).split(/\r?\n/);
    st.tail = lines.pop();   // a line still being written waits for the next read
    const out = [];
    for (const l of lines) {
      const carrySkip = l.includes('"event":"skip"') && l.includes('carry_downday');   // the brain's own record of a carry decision
      if (!l || !(carrySkip || EVENTS.some((e) => l.includes(`"event":"${e}"`)))) continue;
      try { out.push(JSON.parse(l)); } catch (_e) { /* a torn line */ }
    }
    return out;
  } finally { await fh.close(); }
}
function ingest(st, rows) {
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.event === 'trade_plan') {
      if (r.entry && r.entry.at && r.symbol) {
        if (!st.plans.some((p) => p.symbol === r.symbol && p.entry.at === r.entry.at)) st.plans.push(r);
        const t = Date.parse(r.entry.at); if (Number.isFinite(t) && (st.firstPlanAt == null || t < st.firstPlanAt)) st.firstPlanAt = t;
      }
    } else if (r.event === 'entry' && r.user !== 'trade-plan') st.entries.push(r);
    else if (r.event === 'exit') { st.exits.push(r); st.newExits.push(r); }
    else if (r.event === 'plan_carry') st.carries.push(r);
    else if (r.event === 'skip' && /^carry_downday/.test(String(r.reason || r.why || ''))) {
      // the brain's skip row says the same ("eod_decarry suppressed: SPY -3.48% on the session"); written once per change of
      // reason, so it covers history and a relaunch, and plan_carry covers TRADER_LOG_SKIPS=0
      const m = String(r.reason || r.why).match(/SPY (-?\d+(?:\.\d+)?)%/);
      st.carries.push({ ts: r.ts, symbol: r.symbol, day: cal.etOf(tsOf(r)).day, spy_pct: m ? Number(m[1]) : null, src: 'skip' });
    }
    else if (r.event === 'plan_alert' && r.key) {
      if (r.once) st.done.add(r.key); else st.active.set(r.key, { since: tsOf(r), check: r.check, level: r.level, symbol: r.symbol });
    } else if (r.event === 'plan_alert_cleared' && r.key) st.active.delete(r.key);
  }
}
function trim(st, now) {
  const keep = (r) => !(tsOf(r) < now - KEEP_MS);
  st.entries = st.entries.filter(keep); st.exits = st.exits.filter(keep); st.carries = st.carries.filter(keep);
  st.plans = st.plans.filter((p) => !(Date.parse(p.entry.at) < now - KEEP_MS));
}

// ---- the checks ---------------------------------------------------------------------------------------------------------------
const exitOf = (st, P) => { const t0 = Date.parse(P.entry.at); return st.exits.find((x) => symOf(x) === P.symbol && tsOf(x) > t0) || null; };
/** The time the plan's exit is due: its own, or the next session's de-carry when the down-day carry held a leg trade. */
function dueOf(P, st) {
  const ex = P.expected && P.expected.exit_by ? Date.parse(P.expected.exit_by) : NaN;
  if (!Number.isFinite(ex)) return null;
  if (P.kind === 'M') {
    const day = cal.etOf(ex).day;
    const c = st.carries.find((x) => symOf(x) === P.symbol && (x.day ? x.day === day : cal.etOf(tsOf(x)).day === day) && tsOf(x) > Date.parse(P.entry.at));
    const next = c ? cal.nextTradingDay(day) : null;
    if (next) {
      const clock = cal.etOf(ex).min + cal.closeOffset(day) - cal.closeOffset(next);
      return { ms: tp.msOf(next, clock), why: `the next session's de-carry (the down-day carry held it: SPY ${c.spy_pct != null ? c.spy_pct : '?'} %)` };
    }
  }
  return { ms: ex, why: P.expected.exit_rule || 'the planned exit' };
}
/** The conditions true now, and the exits since the last pass that left their plan. Pure, given the state. */
function evaluate(st, { now, positions, orders }) {
  const held = new Map();
  for (const p of positions || []) {
    const s = symOf(p); let q = Number(p && p.qty);
    if (q > 0 && String((p && p.side) || '').toLowerCase() === 'short') q = -q;   // a short read as a side with a positive count
    if (s && Number.isFinite(q) && q !== 0) held.set(s, q);
  }
  const covered = new Map();
  for (const o of orders || []) {
    const side = String((o && o.side) || '').toLowerCase(), stt = String((o && o.status) || '');
    if (side !== 'sell' || !WORKING.test(stt) || TERMINAL.test(stt)) continue;
    const q = Math.abs(Number(o.qty != null ? o.qty : o.quantity) || 0) - Math.abs(Number(o.filled_qty != null ? o.filled_qty : o.filledQty) || 0);
    covered.set(symOf(o), (covered.get(symOf(o)) || 0) + Math.max(0, q));
  }
  const conds = [];
  const open = [];
  for (const P of st.plans) {
    if (exitOf(st, P)) continue;
    const q = held.get(P.symbol), due = dueOf(P, st);
    const lastMs = due ? due.ms + STALE_MS : Date.parse(P.entry.at) + NO_EXIT_STALE_MS;
    if (q == null && now > lastMs) continue;   // gone, a day past its exit: nothing left to watch
    // a newer plan on the same fund supersedes this one (its exit row may be missing)
    if (st.plans.some((x) => x !== P && x.symbol === P.symbol && Date.parse(x.entry.at) > Date.parse(P.entry.at) && Date.parse(x.entry.at) <= now)) continue;
    open.push(P);
    const at = P.entry.at, seenKey = `${at}:${P.symbol}`;
    const base = { symbol: P.symbol, plan_at: at, kind: P.kind || null };
    if (q != null) st.seen.add(seenKey);
    if (q == null) {
      if (Date.parse(at) > now - 60000) continue;   // the entry is still filling
      const seen = st.seen.has(seenKey);
      conds.push({ ...base, check: 'missing_position', level: seen ? 'fault' : 'info',
        why: seen ? 'the broker no longer shows the position and the journal has no exit for it' : 'the broker has not shown the position: the entry may not have filled' });
      continue;
    }
    const planned = Number(P.entry.qty);
    if (q < 0) conds.push({ ...base, check: 'short_position', level: 'fault', why: `the broker shows ${q} shares: short, and the engine only buys`, detail: { held: q, planned: planned || null } });
    else if (planned > 0 && Math.abs(q - planned) >= 1) conds.push({ ...base, check: 'size_mismatch', level: 'fault', why: `the broker holds ${q}, the plan ${planned}`, detail: { held: q, planned } });
    if (due && now > due.ms + GRACE_MS) conds.push({ ...base, check: 'overdue_exit', level: 'fault', why: `still held ${Math.round((now - due.ms) / 60000)} min after ${due.why}`, detail: { exit_by: new Date(due.ms).toISOString(), held: q } });
    const stopRule = (P.exits || []).find((x) => x && x.rule === 'stop' && x.price != null);
    if (stopRule && q > 0) {
      const w = covered.get(P.symbol) || 0;
      if (w + 1e-9 < q) conds.push({ ...base, check: 'unprotected', level: 'fault',
        why: w > 0 ? `working sell orders cover ${w} of ${q} shares` : `no working sell order covers the ${q} shares (the plan's stop: ${stopRule.price})`, detail: { held: q, covered: w, stop: stopRule.price } });
    }
  }
  const watched = new Set(open.map((P) => P.symbol));
  const day = cal.etOf(now).day;
  for (const [sym, q] of held) {
    if (watched.has(sym)) continue;
    const last = st.entries.filter((e) => symOf(e) === sym).slice(-1)[0] || null;
    const legacy = st.firstPlanAt == null || !last || tsOf(last) < st.firstPlanAt;
    conds.push({ symbol: sym, plan_at: null, kind: null, check: 'unplanned_position', level: 'info', key: `${day}:${sym}:unplanned_position`,
      why: legacy ? 'held from before this sleeve wrote plans' : 'held with no open plan (no plan row for its entry, or the plan failed)', detail: { held: q, entry_at: last ? last.ts : null } });
  }
  const events = [];
  const since = (st.startedAt || now) - EXIT_LOOKBACK_MS;
  for (const x of st.newExits) {
    if (!(tsOf(x) >= since)) continue;
    const sym = symOf(x), t = tsOf(x);
    const P = st.plans.filter((p) => p.symbol === sym && Date.parse(p.entry.at) < t).sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at))[0];
    if (!P || exitOf(st, P) !== x) continue;
    const ad = adherenceOf(P, { ts: P.entry.at }, x);
    if (ad.in_design) continue;
    events.push({ symbol: sym, plan_at: P.entry.at, kind: P.kind || null, check: 'exit_outside_plan', level: ad.in_plan ? 'info' : 'fault', why: ad.why, key: `${P.entry.at}:${sym}:exit:${x.ts}`,
      detail: { branch: ad.branch, exit_at: x.ts, reason: String(x.reason || '').replace(/\s*\(.*$/, ''), pnl: Number(x.pnl) || 0, extended_hours: ad.extended_hours } });
  }
  st.newExits = [];
  return { conds, events, open: open.length, held: held.size };
}

function appendAlert(file, now, sleeve, c) {
  if (!file) return;
  try { fs.appendFileSync(file, `${new Date(now).toISOString()}  ${sleeve || '?'} ${c.symbol} ${c.check}: ${c.why}\n`); } catch (_e) { /* alert only */ }
}
function emit(st, out, { now, log, alertsFile, sleeve }) {
  const said = [];
  const say = (row) => { try { log(row); said.push(row); } catch (_e) { /* journal only */ } };
  const live = new Set();
  for (const c of out.conds) {
    const key = c.key || `${c.plan_at}:${c.symbol}:${c.check}`;
    live.add(key);
    const n = (st.counts.get(key) || 0) + 1; st.counts.set(key, n);
    if (st.active.has(key) || n < (PERSIST[c.check] || 1)) continue;
    st.active.set(key, { since: now, check: c.check, level: c.level, symbol: c.symbol });
    say({ event: 'plan_alert', key, check: c.check, level: c.level, symbol: c.symbol, kind: c.kind, plan_at: c.plan_at, why: c.why, detail: c.detail, passes: n, sleeve });
    if (c.level === 'fault') appendAlert(alertsFile, now, sleeve, c);
  }
  for (const key of [...st.counts.keys()]) if (!live.has(key)) st.counts.delete(key);
  for (const [key, a] of [...st.active]) {
    if (live.has(key)) continue;
    st.active.delete(key);
    say({ event: 'plan_alert_cleared', key, check: a.check, symbol: a.symbol, since: Number.isFinite(a.since) ? new Date(a.since).toISOString() : null,
      lasted_min: Number.isFinite(a.since) ? Math.round((now - a.since) / 60000) : null, sleeve });
  }
  for (const e of out.events) {
    if (st.done.has(e.key)) continue;
    st.done.add(e.key);
    say({ event: 'plan_alert', key: e.key, check: e.check, level: e.level, symbol: e.symbol, kind: e.kind, plan_at: e.plan_at, why: e.why, detail: e.detail, once: true, sleeve });
    if (e.level === 'fault') appendAlert(alertsFile, now, sleeve, e);
  }
  return said;
}

/**
 * One check, from one brain pass. opts = { now, positions, orders, journal (the sleeve's journal path), log(row), alertsFile,
 * sleeve, env }. Never throws; returns { said, open, held } or null (off, busy, or a failed read, which is journaled once an hour).
 */
async function check({ now = Date.now(), positions = [], orders = [], journal = null, log = null, alertsFile = null, sleeve = null, env = process.env } = {}) {
  if (!journal || typeof log !== 'function' || !enabled(env)) return null;
  const st = stateOf(journal);
  if (st.busy) return null;   // the previous pass's check is still reading
  st.busy = true;
  try {
    if (st.startedAt == null) st.startedAt = now;
    ingest(st, await readNew(journal, st));
    trim(st, now);
    const out = evaluate(st, { now, positions, orders });
    const said = emit(st, out, { now, log, alertsFile, sleeve });
    return { said, open: out.open, held: out.held };
  } catch (e) {
    if (now - st.errAt > ERROR_EVERY_MS) { st.errAt = now; try { log({ event: 'plan_watch_error', error: String((e && e.message) || e).slice(0, 200), sleeve }); } catch (_e) { /* ditto */ } }
    return null;
  } finally { st.busy = false; }
}

module.exports = { check, enabled, knob, adherenceOf, evaluate, dueOf, ALT, GRACE_MS, PERSIST, _reset: () => _state.clear() };
