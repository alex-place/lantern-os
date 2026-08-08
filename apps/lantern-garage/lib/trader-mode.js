'use strict';

/**
 * trader-mode.js — per-user ACTIVE-TRADER choice (Phase 2 of the Alpaca-first work).
 *
 * One account, one active strategy. Each signed-in user picks which trader runs on
 * their connected (Alpaca) account:
 *   'stock'    — the day-trader: signal entries + their manual buy/sell (the default).
 *   'champion' — the Champion allocation book: the slow, diversified ETF-rebalance
 *                engine (lib/sigma-trader.js) run on THEIR own account.
 *
 * Only ONE is active per account at a time: the autopilot loop (routes/trading.js
 * `_autoscanTick`) reads this and, for a 'champion' user, PAUSES the day-trader and
 * runs the Champion plan instead. Mirrors broker-preference.js exactly — one tiny
 * JSON file per user, nothing secret, plus a per-browser cookie for request routing.
 */

const fs = require('fs');
const path = require('path');

// Resolve relative to THIS module (not cwd) — same rationale as the other per-user
// stores so a server started from any dir sees the same choice. TRADER_MODE_DIR wins.
const DIR = process.env.TRADER_MODE_DIR
  ? path.resolve(process.env.TRADER_MODE_DIR)
  : path.join(__dirname, '..', 'data', 'trader-mode');

// 'off' (#3212): the user's autopilot kill-switch. An 'off' account is never
// entered OR exited by the loop — fully hands-off, the user manages their own
// positions. Chosen over exits-only because a half-managed account is the most
// confusing possible state ("I turned it off, why did it sell?").
const VALID = new Set(['off', 'stock', 'champion']);
const DEFAULT = 'stock';

// SAFE POSTURE (#3212): a REAL signed-in user who never made a choice defaults
// to OFF — connecting a broker must never silently start an autonomous trader
// on someone's account; they flip it on themselves. The operator identities
// keep the historical 'stock' default (the single-user box the trader ships in,
// where connecting credentials IS the opt-in).
function defaultFor(userId) {
  return (userId == null || userId === '' || userId === 'local-owner') ? DEFAULT : 'off';
}

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/** The user's active trader: 'off' | 'stock' | 'champion'. Unset → defaultFor(). */
function get(userId) {
  if (userId == null) return DEFAULT;
  try {
    const v = JSON.parse(fs.readFileSync(_file(userId), 'utf8')).mode;
    return VALID.has(v) ? v : defaultFor(userId);
  } catch (_e) { return defaultFor(userId); }
}

/** Persist a choice. Returns false on an invalid value or missing identity (caller 4xxs). */
function set(userId, mode) {
  if (userId == null || !VALID.has(mode)) return false;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify({ mode, updatedAt: new Date().toISOString() }));
  return true;
}

module.exports = { get, set, VALID, DEFAULT, defaultFor };
