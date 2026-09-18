#!/usr/bin/env node
'use strict';
/**
 * scripts/two-sleeve-runner.js — the headless two-sleeve trader (#3656).
 *
 * ONE process, ONE broker account, TWO brains (the stable sleeve and the race sleeve), driven
 * by lib/two-sleeve/engine.js — the same core the replay harness validates. It replaces the
 * web server's autonomous scan loop for the account it manages: it takes the account lock
 * as the ARMED holder, so a web server on the same account (dashboard, journal) must run
 * disarmed (TRADER_AUTO_EXECUTE=0, TRADER_MANAGE_EXITS=0) and will stand down on the lock.
 *
 * Why headless: each sleeve's env map is applied to process.env around its tick. In a server
 * process an HTTP handler could read the wrong sleeve's knobs between awaits; in a process
 * whose only work is the tick loop, nothing else reads them.
 *
 * Config (TWO_SLEEVE_CONFIG, default data/lantern-garage/trading/two-sleeve/config.json):
 * {
 *   "userId": "local-owner",
 *   "order": ["S", "R"],
 *   "sleeves": [
 *     { "id": "S", "app": ".", "envFile": "C:/dev/lantern-os-stable/.env.local",
 *       "env": { "TRADER_MAX_CONCURRENT": "2", "TRADER_POSITION_PCT": "4", "TRADER_MAX_POSITION_PCT": "4" },
 *       "universe": ["SPY", "QQQ", ...] },
 *     { "id": "R", "app": "C:/dev/lantern-race/apps/lantern-garage", "envFile": "C:/dev/lantern-race/.env.local",
 *       "env": { "TRADER_MAX_CONCURRENT": "4", "TRADER_POSITION_PCT": "8", "TRADER_MAX_POSITION_PCT": "8",
 *                "TRADER_FRESHLOW_SIZE_MULT": "1.5", "TRADER_NO_FRIDAY_ENTRIES": "1" },
 *       "universe": [...] }
 *   ]
 * }
 * A sleeve's effective env = the TRADER_* lines of its envFile (journal/state/lock/arm keys
 * ignored) overlaid with its "env" map. Each brain is required with its OWN journal and state
 * file (data/lantern-garage/trading/two-sleeve/<id>.autopilot-trades.jsonl, <id>.state.json),
 * because both brains capture those paths at load. The engine journal (ownership, collisions,
 * ticks) is two-sleeve/engine.jsonl; a heartbeat file two-sleeve/heartbeat.json is rewritten
 * every tick for the watchdog and the dashboard.
 *
 * Flags: --dry  (everything runs, every order is journaled and REFUSED — no broker writes)
 *        --once (one tick, then exit — for a smoke)
 * Env:   TWO_SLEEVE_CONFIG, TRADER_AUTOSCAN_MS (60000), TRADER_AUTOSCAN_CLOSED_MS (300000),
 *        TRADER_EXTENDED_EXITS=1 (protective-only ticks pre/post market, as the server does).
 */
const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
// TWO_SLEEVE_ENV_ROOT: load .env.local/.env from another checkout (a box tree) while running
// this tree's code — the same override the replay harness offers (REPLAY_ENV_S).
const REPO = process.env.TWO_SLEEVE_ENV_ROOT ? path.resolve(process.env.TWO_SLEEVE_ENV_ROOT) : path.resolve(APP, '..', '..');

// ---- process env: the box's .env.local, exactly as server.js loads it ------------------------
(() => {
  let dotenv = null; try { dotenv = require('dotenv'); } catch (_e) { /* fall back to a manual parse */ }
  for (const [file, override] of [[path.join(REPO, '.env.local'), true], [path.join(REPO, '.env'), false]]) {
    if (!fs.existsSync(file)) continue;
    if (dotenv) { dotenv.config({ path: file, override }); continue; }
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || /^#/.test(line.trim())) continue;
      if (override || process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const ONCE = args.has('--once');
const CFG_FILE = process.env.TWO_SLEEVE_CONFIG || path.join(REPO, 'data', 'lantern-garage', 'trading', 'two-sleeve', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const DIR = path.dirname(CFG_FILE);
fs.mkdirSync(DIR, { recursive: true });
const USER = cfg.userId || process.env.TRADER_AUTO_USER || 'local-owner';
const AUTOSCAN_MS = parseInt(process.env.TRADER_AUTOSCAN_MS || '60000', 10);
const CLOSED_MS = parseInt(process.env.TRADER_AUTOSCAN_CLOSED_MS || '300000', 10);

const et = (ms = Date.now()) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const etMin = (ms) => { const d = et(ms); return d.getHours() * 60 + d.getMinutes(); };
const isWeekday = (ms) => { const w = et(ms).getDay(); return w >= 1 && w <= 5; };
const marketHours = (ms) => isWeekday(ms) && etMin(ms) >= 570 && etMin(ms) < 960;
const extendedHours = (ms) => isWeekday(ms) && ((etMin(ms) >= 240 && etMin(ms) < 570) || (etMin(ms) >= 960 && etMin(ms) < 1200));

const journalFile = path.join(DIR, 'engine.jsonl');
const journal = (row) => { try { fs.appendFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n'); } catch (_e) { /* never break a tick */ } };

// ---- sleeve env maps ------------------------------------------------------------------------
const IGNORE = /^TRADER_(TRADES_LOG|STATE_FILE|LOCK_DIR|LIVE|AUTO_EXECUTE|AUTO_USER|SESSION_REVIEW|MANAGE_EXITS|AUTOSCAN_MS|AUTOSCAN_CLOSED_MS|EXTENDED_EXITS|EXTENDED_HOURS)$/;
function envFromFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(TRADER_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !IGNORE.test(m[1])) out[m[1]] = m[2];
  }
  out.TRADER_ENTRY_JUDGE = out.TRADER_ENTRY_JUDGE || '0';
  return out;
}

// ---- brains: each with its own journal + state (captured at require time) --------------------
process.env.TRADER_AUTO_EXECUTE = DRY ? '0' : '1';
process.env.TRADER_MANAGE_EXITS = DRY ? '0' : '1';
const sleeves = (cfg.sleeves || []).map((s) => {
  const app = s.app && s.app !== '.' ? path.resolve(s.app) : APP;
  process.env.TRADER_TRADES_LOG = path.join(DIR, `${s.id}.autopilot-trades.jsonl`);
  process.env.TRADER_STATE_FILE = path.join(DIR, `${s.id}.state.json`);
  const brain = require(path.join(app, 'lib', 'auto-trader'));
  const env = { ...envFromFile(s.envFile), ...(s.env || {}) };
  return { id: s.id, brain, env, userId: USER, universe: Array.isArray(s.universe) && s.universe.length ? s.universe : null, app };
});
if (sleeves.length < 1) { console.error('[two-sleeve] no sleeves configured'); process.exit(2); }
// After the requires, the process-level journal/state env must not point at either sleeve.
delete process.env.TRADER_TRADES_LOG; delete process.env.TRADER_STATE_FILE;

// ---- broker, scanner, lock, engine ----------------------------------------------------------
const TradingAPIBridge = require(path.join(APP, 'lib', 'trading-api-bridge'));
const TraderAgent = require(path.join(APP, 'lib', 'trader-agent'));
const { brokerFacadeFor } = require(path.join(APP, 'lib', 'broker-facade'));
const accountLock = require(path.join(APP, 'lib', 'account-lock'));
const { createEngine } = require(path.join(APP, 'lib', 'two-sleeve', 'engine'));
const { createOwnership } = require(path.join(APP, 'lib', 'two-sleeve', 'ownership'));

const ibkrBridge = new TradingAPIBridge();
const agent = new TraderAgent({ cacheExpiry: parseInt(process.env.TRADER_CACHE_EXPIRY || '60000', 10), pythonTimeout: parseInt(process.env.TRADER_PYTHON_TIMEOUT || '30000', 10) });
// defaultOwner: the sleeve that ADOPTS positions nobody claimed (pre-existing holdings, a lost
// registry) and inherits untagged resting orders. Default = the first sleeve in tick order;
// set it to "R" when the engine takes over an account the race sleeve was already trading.
const DEFAULT_OWNER = cfg.defaultOwner || (cfg.order || ['S'])[0];
const ownership = createOwnership({ file: path.join(DIR, 'ownership.json'), defaultOwner: DEFAULT_OWNER, onEvent: (ev) => journal(ev) });

let resolved = null;      // { broker, accountId, facade }
let engine = null;
let lockNoticed = false;
const stats = { ticks: 0, scans: 0, lastTick: null, lastScanSignals: 0, lastError: null, started: new Date().toISOString(), pid: process.pid, dry: DRY };

function dryFacade(real) {
  return { ...real, placeIBKROrder: async (uid, o) => { journal({ event: 'dry_order', owner: o._owner, order: { ticker: o.ticker, side: o.side, qty: o.qty, type: o.type, stopPrice: o.stopPrice } }); return { status: 'error', reason: 'dry run — no broker writes' }; },
    cancelIBKROrder: async (uid, id) => { journal({ event: 'dry_cancel', orderId: id }); return { status: 'error', reason: 'dry run' }; } };
}

async function ensureEngine() {
  if (engine) return true;
  resolved = await brokerFacadeFor(USER, ibkrBridge).catch(() => null);
  if (!resolved || !resolved.accountId) { stats.lastError = 'no broker resolved'; return false; }
  const facade = DRY ? dryFacade(resolved.facade) : resolved.facade;
  engine = createEngine({ sleeves, order: cfg.order || sleeves.map((s) => s.id), facade, ownership, defaultOwner: DEFAULT_OWNER, journal });
  journal({ event: 'engine_start', broker: resolved.broker, accountId: resolved.accountId, order: engine.order, dry: DRY, sleeves: sleeves.map((s) => ({ id: s.id, app: s.app, universe: s.universe ? s.universe.length : 'all', env: s.env })) });
  console.info(`[two-sleeve] ${resolved.broker} ${resolved.accountId} — sleeves ${engine.order.join(' then ')}${DRY ? ' (DRY: no orders)' : ''}`);
  return true;
}

function heartbeat(extra) {
  try { fs.writeFileSync(path.join(DIR, 'heartbeat.json'), JSON.stringify({ ...stats, ...extra, accountId: resolved && resolved.accountId, ownership: ownership.snapshot().symbols, engine: engine ? engine.stats : null, at: new Date().toISOString() })); } catch (_e) { /* diagnostic only */ }
}

let stopping = false;
async function tick() {
  const now = Date.now();
  const mh = marketHours(now);
  const protectiveOnly = !mh && extendedHours(now) && process.env.TRADER_EXTENDED_EXITS === '1';
  let delay = (mh || protectiveOnly) ? AUTOSCAN_MS : CLOSED_MS;
  try {
    if (mh || protectiveOnly) {
      if (await ensureEngine()) {
        // A dry run places nothing, so it never contends for the account lock: it can shadow
        // an armed server on the same account, or run alone on a disarmed one. Armed runs
        // take the lock as the armed holder and stand down if another live process has it.
        const lock = DRY ? { acquired: true, reason: 'dry run — observing, no lock' } : accountLock.acquire(resolved.accountId, { armed: true });
        if (!lock.acquired) {
          if (!lockNoticed) { lockNoticed = true; console.info(`[two-sleeve] account ${resolved.accountId} managed by another process — standing down (${lock.reason})`); journal({ event: 'lock_refused', reason: lock.reason }); }
        } else {
          lockNoticed = false;
          agent.cache && (agent.cache['market_scan'] = null);
          const scan = await agent.scanMarket();
          stats.scans++; stats.lastScanSignals = Array.isArray(scan && scan.signals) ? scan.signals.length : 0;
          const res = await engine.tick(scan, { now, extended: !mh, protectiveOnly, userId: USER });
          stats.ticks++; stats.lastTick = new Date().toISOString();
          const skipped = Object.fromEntries(Object.entries(res).map(([id, r]) => [id, Array.isArray(r && r.skipped) ? r.skipped.length : (r && r.error ? 'error' : 0)]));
          journal({ event: 'tick', signals: stats.lastScanSignals, protectiveOnly, skipped, collisions: engine.stats.collisions });
        }
      }
    }
  } catch (e) {
    stats.lastError = String(e && e.message || e);
    console.error('[two-sleeve] tick failed:', stats.lastError);
    journal({ event: 'tick_error', error: stats.lastError });
  }
  heartbeat({ marketHours: mh, protectiveOnly, nextInMs: delay });
  if (ONCE || stopping) return;
  setTimeout(tick, delay);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; try { if (resolved && !DRY) accountLock.release(resolved.accountId); } catch (_e) {} journal({ event: 'engine_stop', signal: sig }); setTimeout(() => process.exit(0), 200); });
console.info(`[two-sleeve] runner pid ${process.pid} — config ${CFG_FILE}${DRY ? ' — DRY RUN' : ''}${ONCE ? ' — single tick' : ''}`);
tick();
