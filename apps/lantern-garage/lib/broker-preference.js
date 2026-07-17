'use strict';

/**
 * broker-preference.js — per-user broker choice (ADR-0027).
 *
 * Lets each signed-in user pick which connected broker executes their trades:
 * 'alpaca', 'ibkr', or 'auto' (follow the server default — BROKER_PREFER env,
 * else IBKR-first). One tiny JSON file per user, same dir convention as the
 * other per-user stores; nothing secret lives here, just the choice.
 *
 * Resolved by broker-facade.preferredBroker(userId), which every broker
 * resolution site (autopilot facade, manual orders, positions endpoint) calls —
 * so flipping the preference re-routes ALL trading surfaces at once, and the
 * non-preferred broker always remains the automatic fallback.
 */

const fs = require('fs');
const path = require('path');

// Resolve relative to THIS module (apps/lantern-garage/data) — NOT process cwd —
// same rationale as ibkr-credentials.js: servers started from different dirs must
// see the same store. Explicit BROKER_PREF_DIR wins (tests use it).
const DIR = process.env.BROKER_PREF_DIR
  ? path.resolve(process.env.BROKER_PREF_DIR)
  : path.join(__dirname, '..', 'data', 'broker-preference');

const VALID = new Set(['alpaca', 'ibkr', 'auto']);

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/** The user's stored choice: 'alpaca' | 'ibkr' | 'auto' (default when unset/unreadable).
 *  A null/undefined userId (anonymous request) is always 'auto' — anonymous visitors
 *  share no identity, so a stored choice would leak between them. */
function get(userId) {
  if (userId == null) return 'auto';
  try {
    const v = JSON.parse(fs.readFileSync(_file(userId), 'utf8')).broker;
    return VALID.has(v) ? v : 'auto';
  } catch (_e) { return 'auto'; }
}

/** Persist a choice. Returns false on an invalid value or missing identity (caller 4xxs). */
function set(userId, broker) {
  if (userId == null || !VALID.has(broker)) return false;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify({ broker, updatedAt: new Date().toISOString() }));
  return true;
}

module.exports = { get, set, VALID };
