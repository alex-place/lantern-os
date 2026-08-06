#!/usr/bin/env node
'use strict';
/**
 * trader-watchdog.js — durable health check for the live day-trader.
 *
 * WHY THIS EXISTS (2026-08-05). The trader was verified healthy mid-morning and
 * then silently did nothing for the rest of the session. A point-in-time check
 * proves nothing about the next six hours, and the failure modes that have
 * actually cost trading days are all INVISIBLE without something watching:
 *
 *   1. the account lock held by a DISARMED (exit-only) process, locking the
 *      armed trader out — this is what cost the 2026-08-05 open
 *   2. the server answering HTTP while its scan loop is dead or stalled
 *   3. entries silently refused by the broker (entry_blocked rows)
 *
 * None of these raise an error. All of them look exactly like "a quiet market",
 * which is why they survived a manual check and ran for hours.
 *
 * RUNS OUTSIDE THE CHECKOUT. Deploy a copy somewhere a `git merge`/reset can
 * never touch (the operator box uses C:\dev\trader-watchdog.js) and point a
 * scheduler at it every ~5 min during market hours. A watchdog that lives inside
 * the tree it is watching cannot report on that tree being broken.
 *
 * READ-ONLY with respect to trading: it never places, cancels, or modifies an
 * order, and never writes into the data directory it reads.
 *
 * Paths/account come from env so this is not machine-specific:
 *   WATCHDOG_STABLE_ROOT   checkout serving the live trader
 *   WATCHDOG_LOCK_DIR      shared account-lock dir (matches TRADER_LOCK_DIR)
 *   WATCHDOG_ACCOUNT       broker account id to assert the lock for
 *   WATCHDOG_OUT / WATCHDOG_ALERTS   output JSONL / alert log
 *   WATCHDOG_URL           health endpoint (default http://127.0.0.1:4177/api/status)
 *   WATCHDOG_FORCE_OPEN    1|0 — test hook, overrides the market-hours clock
 *
 * Exit code is always 0: a scheduler treating "trader is broken" as a task
 * failure would bury the signal in Task Scheduler history instead of the log.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const CFG = {
  stable: process.env.WATCHDOG_STABLE_ROOT || 'C:/dev/lantern-os-stable',
  lockDir: process.env.WATCHDOG_LOCK_DIR || process.env.TRADER_LOCK_DIR || 'C:/dev/trader-locks',
  account: process.env.WATCHDOG_ACCOUNT || 'DUR193395',
  out: process.env.WATCHDOG_OUT || 'C:/dev/trader-watchdog.jsonl',
  alerts: process.env.WATCHDOG_ALERTS || 'C:/dev/trader-watchdog-ALERTS.log',
  url: process.env.WATCHDOG_URL || 'http://127.0.0.1:4177/api/status',
};

// The scan writes state every cycle (~60s), so 5 min of silence is a stall, not
// slowness. The lock is re-stamped every scan; 3 min without means a dead holder.
const STALE_STATE_MS = Number(process.env.WATCHDOG_STALE_STATE_MS) || 5 * 60 * 1000;
const STALE_LOCK_MS = Number(process.env.WATCHDOG_STALE_LOCK_MS) || 3 * 60 * 1000;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { return null; } }

function get(url, ms = 5000) {
  return new Promise((res) => {
    const rq = http.get(url, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', () => res(0));
    rq.setTimeout(ms, () => { rq.destroy(); res(0); });
  });
}

/** Regular trading hours (09:30-16:00 ET, weekdays) against the box's clock. */
function marketOpenNow(now = new Date()) {
  if (process.env.WATCHDOG_FORCE_OPEN === '1') return true;
  if (process.env.WATCHDOG_FORCE_OPEN === '0') return false;
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

/** Tally today's ledger rows into counts + per-tier entry counts. */
function summarise(rows) {
  const today = { entry: 0, exit: 0, skip: 0, entry_blocked: 0, error: 0 };
  const tiers = {};
  for (const r of rows || []) {
    if (!r) continue;
    if (today[r.event] != null) today[r.event] += 1;
    if (r.status === 'error') today.error += 1;
    if (r.event === 'entry' && r.tier) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
  }
  return { today, tiers };
}

/**
 * PURE decision core — all the judgement, no I/O, so the failure modes this
 * exists to catch can be proven in tests instead of by breaking production.
 */
function evaluate({ open, httpStatus, lock, lockAgeMs, stateAgeMs, stateMissing, today }) {
  const problems = [];
  if (httpStatus !== 200) problems.push(`server not answering (http ${httpStatus})`);
  if (open) {
    if (!lock) problems.push('no account lock held during market hours - trader is not scanning');
    else {
      // THE 2026-08-05 FAILURE: exit-only process holding the armed trader out.
      if (lock.armed !== true) problems.push(`account lock held by DISARMED pid ${lock.pid} - armed trader is locked out`);
      if (lockAgeMs != null && lockAgeMs > STALE_LOCK_MS) {
        problems.push(`lock heartbeat stale (${Math.round(lockAgeMs / 1000)}s) - holder may be dead`);
      }
    }
  }
  if (stateMissing) problems.push('trader-state.json missing');
  else if (open && stateAgeMs != null && stateAgeMs > STALE_STATE_MS) {
    problems.push(`scan loop stalled - state not written for ${Math.round(stateAgeMs / 60000)}min`);
  }
  if (today && today.entry_blocked > 0) {
    problems.push(`${today.entry_blocked} entry_blocked rows today - orders are being refused`);
  }
  return { verdict: problems.length ? 'PROBLEM' : 'ok', problems };
}

async function main() {
  const now = new Date();
  const open = marketOpenNow(now);
  const httpStatus = await get(CFG.url);

  const lock = readJson(path.join(CFG.lockDir, `${CFG.account}.lock.json`));
  const lockAgeMs = lock ? now.getTime() - Number(lock.heartbeat || 0) : null;

  const statePath = path.join(CFG.stable, 'data/lantern-garage/trading/trader-state.json');
  let stateAgeMs = null, stateMissing = false;
  try { stateAgeMs = now.getTime() - fs.statSync(statePath).mtimeMs; } catch (_e) { stateMissing = true; }

  let rows = [];
  try {
    const day = now.toISOString().slice(0, 10);
    rows = fs.readFileSync(path.join(CFG.stable, 'data/lantern-garage/trading/autopilot-trades.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter((r) => r && String(r.ts || '').startsWith(day));
  } catch (_e) { /* no ledger yet is not itself a fault */ }

  const { today, tiers } = summarise(rows);
  const { verdict, problems } = evaluate({ open, httpStatus, lock, lockAgeMs, stateAgeMs, stateMissing, today });

  const rec = {
    ts: now.toISOString(), market_open: open, http: httpStatus,
    lock_pid: lock ? lock.pid : null,
    lock_armed: lock ? lock.armed === true : null,
    lock_age_s: lockAgeMs == null ? null : Math.round(lockAgeMs / 1000),
    state_age_s: stateAgeMs == null ? null : Math.round(stateAgeMs / 1000),
    today, tiers, verdict, problems,
  };
  try {
    fs.mkdirSync(path.dirname(CFG.out), { recursive: true });
    fs.appendFileSync(CFG.out, JSON.stringify(rec) + '\n');
  } catch (_e) { /* logging must never break the check */ }
  if (problems.length) {
    try { fs.appendFileSync(CFG.alerts, `${now.toISOString()}  ${problems.join(' | ')}\n`); } catch (_e) { /* ditto */ }
  }
  console.log(verdict, JSON.stringify(rec));
}

module.exports = { evaluate, summarise, marketOpenNow, CFG, STALE_STATE_MS, STALE_LOCK_MS };

if (require.main === module) main();
