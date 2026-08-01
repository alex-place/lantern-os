'use strict';

/**
 * trading-account-mode.js — the DEMO / PAPER / TRADE ladder (#2546).
 *
 * A different axis from `trader-mode.js`, and the two are easy to confuse:
 *   trader-mode   = WHICH STRATEGY runs   ('stock' day-trader | 'champion' allocation book)
 *   account-mode  = WHOSE MONEY it runs on ('demo' | 'paper' | 'trade')   ← this file
 * They compose: you can watch the champion strategy in demo, or run it on paper.
 *
 * THE LADDER, and what each rung is actually backed by:
 *
 *   demo   READ-ONLY. The simulated champion book (lib/champion-demo.js) — a deterministic
 *          fixture, NOT Alpaca, NOT a broker, NOT the user's money. A brand-new visitor sees
 *          a fully populated, working dashboard with zero setup and cannot place an order.
 *          This is the default, because the alternative for a new user is an empty screen.
 *
 *   paper  The user's OWN practice account. Either their BYOK Alpaca paper account (they
 *          pasted paper keys at POST /api/broker/alpaca/connect-keys — the destination), or,
 *          until they do, the per-user house practice ledger (lib/house-paper-broker.js).
 *          Orders are real orders against a real practice account; no real money.
 *
 *   trade  Live money. Requires BYOK LIVE keys AND the existing trading-guard arming. This
 *          module never grants it on its own — `canPlaceOrders` returning true for 'trade'
 *          means "the mode permits it", and trading-guard still decides whether the order
 *          actually goes out. Two independent gates, deliberately.
 *
 * THE LOAD-BEARING RULE: **demo can never place an order.** It is enforced here in one
 * function (`assertCanPlaceOrder`) rather than trusted to each call site, because "read-only"
 * that depends on every caller remembering to check is not read-only. Callers that place
 * orders must call it; the test suite pins that demo is refused.
 *
 * Mirrors trader-mode.js / broker-preference.js exactly — one small JSON file per user, a
 * per-browser cookie for request routing, nothing secret stored.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.ACCOUNT_MODE_DIR
  ? path.resolve(process.env.ACCOUNT_MODE_DIR)
  : path.join(__dirname, '..', 'data', 'account-mode');

const DEMO = 'demo';
const PAPER = 'paper';
const TRADE = 'trade';
const VALID = new Set([DEMO, PAPER, TRADE]);
// A new user lands in demo: a populated read-only dashboard beats an empty real one, and it
// is the only rung that is safe before we know anything about them.
const DEFAULT = DEMO;

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/**
 * The user's EXPLICIT choice, or null if they have never picked one.
 *
 * The distinction matters: "never chose" is not the same as "chose demo". Treating them the
 * same would put every existing user with a connected broker into demo and silently replace
 * their real account with a simulated fixture — a regression, not an on-ramp. Callers that
 * can see whether a broker is connected should use `resolve()` instead.
 */
function getExplicit(userId) {
  if (userId == null || userId === '') return null;
  try {
    const v = JSON.parse(fs.readFileSync(_file(userId), 'utf8')).mode;
    return VALID.has(v) ? v : null;
  } catch (_e) { return null; }
}

/** Stored choice, or the default. An anonymous caller is always demo — no identity, no risk. */
function get(userId) {
  return getExplicit(userId) || DEFAULT;
}

/**
 * The mode to actually apply, given what the user has connected.
 *
 * An explicit choice always wins. Otherwise demo is the on-ramp ONLY for a user with nothing
 * connected: someone who already linked a broker keeps seeing their own account, exactly as
 * before this ladder existed.
 */
function resolve(userId, { hasBroker = false } = {}) {
  const explicit = getExplicit(userId);
  if (explicit) return explicit;
  return hasBroker ? PAPER : DEMO;
}

/**
 * Persist a choice. Returns false on an invalid mode or missing identity (caller 4xxs).
 *
 * `trade` is refused unless the user actually has live broker credentials — otherwise a user
 * could sit in a mode that claims live trading while every order silently lands on paper,
 * which is the most dangerous possible mismatch between what the UI says and what is true.
 */
function set(userId, mode, { hasLiveCredentials = false } = {}) {
  if (userId == null || userId === '' || !VALID.has(mode)) return false;
  if (mode === TRADE && !hasLiveCredentials) return false;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify({ mode, updatedAt: new Date().toISOString() }));
  return true;
}

/** Read-only is a property of the mode, not of the caller's intentions. */
function isReadOnly(mode) { return (mode || DEFAULT) === DEMO; }

/** Does this mode permit placing orders at all? (trading-guard still decides separately.) */
function canPlaceOrders(mode) { return !isReadOnly(mode); }

/**
 * The single enforcement point. Returns null when the order may proceed, or a ready-to-send
 * rejection envelope when it may not. Shaped like the adapters' own rejections so a caller
 * can return it directly.
 */
function assertCanPlaceOrder(mode) {
  const m = VALID.has(mode) ? mode : DEFAULT;
  if (canPlaceOrders(m)) return null;
  return {
    status: 'rejected',
    dry: true,
    mode: m,
    readOnly: true,
    reason: 'Demo mode is read-only — it shows a simulated champion book, not your account. '
      + 'Switch to Paper to place practice trades.',
    nextStep: { action: 'switch_mode', to: PAPER, endpoint: '/api/trading/account-mode' },
  };
}

/**
 * Describe the user's current rung and how to climb it — everything a surface needs to render
 * the switch without making its own policy decisions.
 *
 * @param {object} opts
 *   hasPaperKeys  user connected BYOK Alpaca PAPER keys
 *   hasLiveKeys   user connected BYOK Alpaca LIVE keys
 */
function describe(userId, { hasPaperKeys = false, hasLiveKeys = false, hasBroker = null } = {}) {
  // Report the RESOLVED mode, not the raw default — telling a user with a connected broker
  // that they are in "demo" would contradict what the facade actually serves them.
  const connected = hasBroker == null ? (hasPaperKeys || hasLiveKeys) : hasBroker;
  const mode = resolve(userId, { hasBroker: connected });
  const backing = mode === DEMO ? 'champion-demo (simulated, read-only)'
    : mode === PAPER ? (hasPaperKeys ? 'your Alpaca paper account (BYOK)' : 'your house practice account')
      : 'your Alpaca live account';
  return {
    mode,
    readOnly: isReadOnly(mode),
    canPlaceOrders: canPlaceOrders(mode),
    backing,
    available: {
      demo: true,                    // always — it needs nothing
      paper: true,                   // always — the house ledger needs nothing either
      trade: !!hasLiveKeys,          // only with live BYOK keys
    },
    // Why `trade` is unavailable, so the UI can say something useful instead of greying a button.
    tradeBlockedReason: hasLiveKeys ? null
      : 'Connect Alpaca live keys to enable real-money trading. Paper keys stay on the Paper rung.',
  };
}

module.exports = {
  get, getExplicit, resolve, set, describe, isReadOnly, canPlaceOrders, assertCanPlaceOrder,
  VALID, DEFAULT, DEMO, PAPER, TRADE,
};
