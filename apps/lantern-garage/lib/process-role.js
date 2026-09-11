'use strict';
/**
 * process-role.js — which half of the app this process runs (#3523).
 *
 * Production is one Railway service, and Railway can't share a volume between two
 * services, so the website and the trader split into two Node processes inside the SAME
 * service (lib/split-supervisor.js, started by start.js when LANTERN_SPLIT=1). They share
 * the disk; they don't share an event loop, and one crashing doesn't take the other down.
 * LANTERN_ROLE says which half this process is:
 *   all     (default) everything, exactly as before: the local boxes and the desktop app.
 *   web     the site, the APIs, the UI data collectors, MCP, the job worker. No trading loops.
 *   trader  the trading loops (autoscan, fast exits, overnight sleeve, Sigma schedule,
 *           brake monitor, Kalshi stop-loss monitor), served on a loopback port.
 */
const ROLES = ['all', 'web', 'trader'];

function role(env = process.env) {
  const raw = String(env.LANTERN_ROLE || '').trim().toLowerCase();
  if (!raw) return 'all';
  // A typo must not quietly become 'all': in split mode that would be a second trader.
  if (!ROLES.includes(raw)) throw new Error(`LANTERN_ROLE must be one of ${ROLES.join(', ')} (got "${env.LANTERN_ROLE}")`);
  return raw;
}
const runsWeb = (env = process.env) => role(env) !== 'trader';
const runsTrader = (env = process.env) => role(env) !== 'web';

/** The web process must not start the trading loops routes/trading.js schedules when it
 *  loads; TRADER_AUTOSCAN=0 is that module's own kill switch. Call before it is required. */
function applyRoleEnv(env = process.env) {
  const r = role(env);
  if (r === 'web') env.TRADER_AUTOSCAN = '0';
  return r;
}

/** Where the web process reaches the trader. The supervisor sets LANTERN_TRADER_URL. */
function traderUrl(env = process.env) {
  return env.LANTERN_TRADER_URL || `http://127.0.0.1:${env.LANTERN_TRADER_PORT || 4190}`;
}

module.exports = { ROLES, role, runsWeb, runsTrader, applyRoleEnv, traderUrl };
