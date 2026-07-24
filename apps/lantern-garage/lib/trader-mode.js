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

const VALID = new Set(['stock', 'champion']);
const DEFAULT = 'stock';

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/** The user's active trader: 'stock' | 'champion' (default 'stock' when unset). A
 *  null userId (anonymous) is always the default — no identity, no stored choice. */
function get(userId) {
  if (userId == null) return DEFAULT;
  try {
    const v = JSON.parse(fs.readFileSync(_file(userId), 'utf8')).mode;
    return VALID.has(v) ? v : DEFAULT;
  } catch (_e) { return DEFAULT; }
}

/** Persist a choice. Returns false on an invalid value or missing identity (caller 4xxs). */
function set(userId, mode) {
  if (userId == null || !VALID.has(mode)) return false;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify({ mode, updatedAt: new Date().toISOString() }));
  return true;
}

module.exports = { get, set, VALID, DEFAULT };
