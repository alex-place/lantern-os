'use strict';

/**
 * trader-heartbeat.js — the scan loop watching itself (#3525).
 *
 * WHAT A STALL LOOKS LIKE FROM OUTSIDE. routes/trading.js runs the autopilot as a
 * self-rescheduling setTimeout chain: each tick queues the next one only after the
 * previous finishes, so a slow 60s scan can never overlap itself. That shape is right and
 * it has exactly one failure mode — if a tick never finishes, or throws somewhere the
 * try/catch does not cover, the chain simply stops. There is no crash, no log line, and
 * no exit code. The process stays up, answers /api/status, serves the site, and trades
 * nothing. Both stalls seen the week of 2026-09-08 looked like that from the outside, and
 * the only thing that noticed was a watchdog on the operator's PC, outside the repo.
 *
 * WHY THIS LIVES INSIDE THE PROCESS. Production is Railway, not a VM with systemd (the
 * correction on #3525, after #3523). Railway's healthcheck gates a DEPLOY going live; it
 * does not restart a running service that stops answering — and a stalled trader answers
 * fine anyway, which is the whole problem. There is no external timer to lean on, so the
 * watchdog has to be in the process: notice, say so, and exit non-zero.
 *
 * WHAT CATCHES THE EXIT. In production the trader is a CHILD of lib/split-supervisor.js
 * (#3523), which already restarts an exited child after ~1s and resets its backoff once a
 * run lasts a minute — so exit(1) is a restart in about a second, and the platform is
 * never involved. railway.json is the outer net for the supervisor ITSELF dying, which is
 * why it now says ALWAYS: ON_FAILURE with three retries left the whole service down after
 * the third crash.
 *
 * In the unsplit 'all' role — the operator's two local boxes and the desktop app —
 * NOTHING catches the exit. That is the second reason this is off by default, and the
 * reason 'alert' exists as a posture of its own.
 *
 * A HEARTBEAT IS A COMPLETED SCAN, NOT A TICK. The loop also survives in a shape where it
 * keeps ticking and every scan throws — a wedged broker session does exactly that, and
 * the catch in _autoscanTick turns it into one log line a minute forever. Counting ticks
 * would call that healthy. So the beat is recorded where a scan cycle COMPLETES, and the
 * tick count is kept only as diagnosis.
 *
 * FIVE MINUTES, NOT TWO. #3525 asked for 2x the scan cadence. That number pages on a
 * working trader: the cadence is 60s and the scan itself takes 45-60s, so a HEALTHY loop
 * is normally silent for about 120s between completions and occasionally longer. The
 * default is five minutes, with a hard floor of 2x cadence so a hand-set value cannot go
 * below the loop's own rhythm.
 *
 * OFF BY DEFAULT, AND OFF MEANS OFF. This module can end the process, and the armed
 * traders on the operator's two local boxes run the same code as production. A watchdog
 * that shipped armed would get its first real-world test on a live account, so
 * TRADER_HEARTBEAT is unset everywhere until someone sets it — 'alert' to watch and mail,
 * '1' to also exit.
 *
 * THE BUDGET IS THE POINT. Restarting is only ever worth it if the stall is transient. A
 * loop broken by a bad deploy would restart forever otherwise, and each restart drops
 * whatever in-memory state the trader had mid-session. Restarts are counted in a rolling
 * hour in a file that survives the exit — an in-memory count would reset with the process
 * it just killed and cap nothing at all — and once the budget is spent the watchdog stops
 * restarting and only says so.
 */

const fs = require('fs');
const path = require('path');

// Same resolution rule as the other small stores: relative to THIS module, not cwd, so a
// server started from any directory reads the same ledger. The override is for tests.
const LEDGER = process.env.TRADER_HEARTBEAT_FILE
  ? path.resolve(process.env.TRADER_HEARTBEAT_FILE)
  : path.join(__dirname, '..', 'data', 'trading', 'heartbeat.json');

const HOUR_MS = 3600000;

const state = {
  startedAt: Date.now(),
  lastScanAt: null,     // a scan cycle COMPLETED — this is the heartbeat
  lastTickAt: null,     // the loop came round — diagnosis only, never the health signal
  scans: 0,
  ticks: 0,
  lastAlertAt: null,
};

/**
 * Config, read at call time rather than at require time, so a test can set the env after
 * loading the module and an operator's change lands on the next check.
 */
function config(env) {
  const e = env || process.env;
  const raw = String(e.TRADER_HEARTBEAT || '').trim().toLowerCase();
  const mode = (raw === '1' || raw === 'restart') ? 'restart'
    : (raw === 'alert' || raw === 'warn') ? 'alert'
      : 'off';
  const cadenceMs = Math.max(1000, parseInt(e.TRADER_AUTOSCAN_MS || '60000', 10) || 60000);
  const asked = parseInt(e.TRADER_HEARTBEAT_STALE_MS || '', 10);
  return {
    mode,
    cadenceMs,
    // The floor is the loop's own rhythm: below 2x cadence the watchdog fires on a trader
    // that is working.
    staleMs: Math.max(2 * cadenceMs, Number.isFinite(asked) && asked > 0 ? asked : 5 * 60000),
    checkMs: Math.max(5000, parseInt(e.TRADER_HEARTBEAT_CHECK_MS || '60000', 10) || 60000),
    maxRestarts: Math.max(1, parseInt(e.TRADER_HEARTBEAT_MAX_RESTARTS || '3', 10) || 3),
    windowMs: HOUR_MS,
    // Once the budget is spent the stall is permanent until a human looks. Without a
    // cooldown that is one mail per check, forever.
    cooldownMs: Math.max(60000, parseInt(e.TRADER_HEARTBEAT_COOLDOWN_MS || '', 10) || 15 * 60000),
    to: String(e.TRADER_HEARTBEAT_EMAIL || '').trim(),
  };
}

/** The loop completed a scan cycle. Called from routes/trading.js. */
function scanned(nowMs) {
  state.lastScanAt = nowMs == null ? Date.now() : nowMs;
  state.scans += 1;
  return state.lastScanAt;
}

/** The loop came round. Never treated as health — see the header. */
function ticked(nowMs) {
  state.lastTickAt = nowMs == null ? Date.now() : nowMs;
  state.ticks += 1;
  return state.lastTickAt;
}

/* ── the restart ledger ─────────────────────────────────────────────────────── */

function readRestarts(nowMs, windowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const win = windowMs || HOUR_MS;
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const list = Array.isArray(raw && raw.restarts) ? raw.restarts : [];
    return list.map(Number).filter((t) => Number.isFinite(t) && now - t < win).sort();
  } catch (_e) {
    // Missing or unreadable means an empty budget history. A fresh container legitimately
    // has none, and refusing to restart because a file could not be read would trade a
    // recoverable stall for a permanent one.
    return [];
  }
}

function recordRestart(nowMs, windowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const kept = readRestarts(now, windowMs).concat([now]);
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ restarts: kept }, null, 2));
  } catch (e) {
    // The exit still has to happen; losing the count only costs a wider budget.
    console.error('[trader-heartbeat] could not write the restart ledger:', e.message);
  }
  return kept;
}

/* ── the decision ───────────────────────────────────────────────────────────── */

/**
 * Pure. Everything it needs is an argument, so the four cases #3525 asks for are four
 * assertions and none of them need a clock, a mailer, or a process to kill.
 *
 * Actions: 'none' does nothing; 'alert' logs and mails; 'restart' logs, mails and exits
 * non-zero — a restart is always announced, never silent.
 */
function decide(input) {
  const i = input || {};
  if (i.mode !== 'alert' && i.mode !== 'restart') return { action: 'none', reason: 'disabled' };
  // Outside the session there is nothing to be late for: the loop idles on a five-minute
  // cadence by design, and restarting a trader at 03:00 helps nobody.
  if (!i.inSession) return { action: 'none', reason: 'market_closed' };
  // Before the first scan of this process, measure from boot — that is what "no scan has
  // completed" means for a trader that came up and never scanned at all.
  const ageMs = i.now - (i.lastScanAt || i.startedAt);
  if (ageMs < i.staleMs) return { action: 'none', reason: 'fresh', ageMs };
  if (i.mode === 'restart' && i.restarts < i.maxRestarts) {
    return { action: 'restart', reason: 'stale', ageMs };
  }
  const reason = i.mode === 'restart' ? 'restart_budget_spent' : 'stale';
  const muted = i.lastAlertAt != null && (i.now - i.lastAlertAt) < i.cooldownMs;
  if (muted) return { action: 'none', reason: reason + '_muted', ageMs };
  return { action: 'alert', reason, ageMs };
}

/* ── acting on it ───────────────────────────────────────────────────────────── */

function _defaults() {
  return {
    env: process.env,
    readRestarts,
    recordRestart,
    exit: (code) => process.exit(code),
    send: (opts, waitMs) => require('./mailer').sendMailBounded(opts, waitMs),
    configured: () => require('./mailer').mailerConfigured(),
  };
}

// Three different things can bring us here and they need three different first lines.
// A live run said "the restart budget is spent" while the budget was untouched and the
// real reason was that nobody had armed anything beyond 'alert'.
function _headline(v) {
  if (v.action === 'restart') return 'The trading loop stopped completing scans. Restarting the process.';
  if (v.reason === 'restart_budget_spent') {
    return 'The trading loop stopped completing scans and this hour’s restart budget is spent. NOT restarting.';
  }
  return 'The trading loop stopped completing scans. Watching only (TRADER_HEARTBEAT=alert), so nothing was restarted.';
}

function _body(v, c, now) {
  const mins = (v.ageMs / 60000).toFixed(1);
  const last = state.lastScanAt ? new Date(state.lastScanAt).toISOString() : 'never (since boot)';
  return [
    _headline(v),
    '',
    'last completed scan: ' + last + ' (' + mins + ' minutes ago)',
    'stale after:         ' + (c.staleMs / 60000).toFixed(1) + ' minutes',
    'ticks since boot:    ' + state.ticks + ' (completed scans: ' + state.scans + ')',
    'uptime:              ' + ((now - state.startedAt) / 60000).toFixed(1) + ' minutes',
    'reason:              ' + v.reason,
    '',
    'A loop that ticks without completing scans is usually a wedged broker session.',
    'A loop that stopped ticking is usually an unhandled rejection in the scan chain.',
  ].join('\n');
}

/**
 * One check. Returns the decision either way, so a caller (and a test) can see what it
 * concluded without reading logs. Never throws: a watchdog that can take the process down
 * by failing is worse than no watchdog.
 */
async function check(nowMs, deps) {
  const now = nowMs == null ? Date.now() : nowMs;
  const d = Object.assign(_defaults(), deps || {});
  const c = config(d.env);
  let v;
  try {
    v = decide({
      mode: c.mode,
      inSession: typeof d.inSession === 'function' ? !!d.inSession(now) : !!(_inSession && _inSession(now)),
      lastScanAt: state.lastScanAt,
      startedAt: state.startedAt,
      now,
      staleMs: c.staleMs,
      restarts: d.readRestarts(now, c.windowMs).length,
      maxRestarts: c.maxRestarts,
      lastAlertAt: state.lastAlertAt,
      cooldownMs: c.cooldownMs,
    });
  } catch (e) {
    console.error('[trader-heartbeat] check failed:', e.message);
    return { action: 'none', reason: 'check_failed' };
  }
  if (v.action === 'none') return v;

  const text = _body(v, c, now);
  console.error('[trader-heartbeat] ' + text.split('\n')[0]
    + ' (' + (v.ageMs / 60000).toFixed(1) + ' min since the last completed scan)');
  state.lastAlertAt = now;
  // Mail BEFORE the exit, and bounded — an unbounded send would hang the process it is
  // supposed to be restarting, and an unawaited one would never leave.
  // Every path that does not mail says WHY. An address set with no mailer behind it is
  // the likeliest misconfiguration of the two and was the one that used to be silent.
  if (!c.to) {
    console.error('[trader-heartbeat] no TRADER_HEARTBEAT_EMAIL set — this stall was logged, not mailed');
  } else if (!d.configured()) {
    console.error('[trader-heartbeat] TRADER_HEARTBEAT_EMAIL is set but no mailer is configured'
      + ' (RESEND_API_KEY / SMTP) — this stall was logged, not mailed');
  } else {
    try {
      await d.send({
        to: c.to,
        subject: 'Trader stalled — ' + (v.action === 'restart' ? 'restarting'
          : v.reason === 'restart_budget_spent' ? 'restart budget spent' : 'watching only'),
        text,
      }, 8000);
    } catch (e) {
      console.error('[trader-heartbeat] alert mail failed:', e.message);
    }
  }
  if (v.action === 'restart') {
    d.recordRestart(now, c.windowMs);
    d.exit(1);
  }
  return v;
}

/* ── the timer ──────────────────────────────────────────────────────────────── */

let _timer = null;
let _inSession = null;

/**
 * Start watching. `inSession` is REQUIRED and injected: the trading loop already owns the
 * one definition of US market hours, and a second copy here would be a second thing to
 * keep right. Without it the watchdog refuses to start rather than guessing.
 */
function start(opts) {
  const o = opts || {};
  if (_timer) return _timer;
  const c = config();
  if (c.mode === 'off') return null;
  if (typeof o.inSession !== 'function') {
    console.error('[trader-heartbeat] TRADER_HEARTBEAT is set but no inSession predicate was passed — not starting');
    return null;
  }
  _inSession = o.inSession;
  state.startedAt = Date.now();
  _timer = setInterval(() => { check(undefined, { inSession: _inSession }).catch(() => {}); }, c.checkMs);
  // Never hold the process open on the watchdog's account.
  if (_timer.unref) _timer.unref();
  console.info('[trader-heartbeat] watching the scan loop — ' + c.mode
    + ' after ' + (c.staleMs / 60000).toFixed(1) + ' min, max ' + c.maxRestarts + ' restarts/hour'
    + (c.to ? ', mailing ' + c.to : ', no mail configured'));
  return _timer;
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  return true;
}

/** For /api/status and for tests. No secrets, no addresses. */
function status() {
  const c = config();
  const now = Date.now();
  return {
    mode: c.mode,
    watching: !!_timer,
    lastScanAt: state.lastScanAt ? new Date(state.lastScanAt).toISOString() : null,
    ageMs: now - (state.lastScanAt || state.startedAt),
    staleMs: c.staleMs,
    scans: state.scans,
    ticks: state.ticks,
    restartsThisHour: readRestarts(now, c.windowMs).length,
    maxRestarts: c.maxRestarts,
  };
}

/** Tests only — the module keeps process-lifetime state by design. */
function _reset(now) {
  state.startedAt = now == null ? Date.now() : now;
  state.lastScanAt = null;
  state.lastTickAt = null;
  state.scans = 0;
  state.ticks = 0;
  state.lastAlertAt = null;
  stop();
}

module.exports = {
  scanned,
  ticked,
  decide,
  check,
  start,
  stop,
  status,
  config,
  readRestarts,
  recordRestart,
  _reset,
  _state: state,
};
