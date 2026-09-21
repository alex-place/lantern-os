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
 * file (<config dir>/<id>.autopilot-trades.jsonl, <id>.state.json), because both brains capture
 * those paths at load. The engine journal (ownership, collisions, ticks) is <config dir>/engine.jsonl;
 * a heartbeat file <config dir>/heartbeat.json is rewritten every tick for the watchdog and the dashboard.
 *
 * SCANS ARE PER SLEEVE (2026-09-21). Each sleeve's signals come from a forked scan worker
 * (lib/two-sleeve/scan-worker.js) that loads THAT sleeve's app tree under THAT sleeve's env file
 * and universe: the stable sleeve scans with this tree's signal engine at stable's thresholds,
 * the race sleeve with race's scan.js at race's. Monday's shared scan ran master's engine under
 * race's env and starved the stable sleeve of every stable-threshold signal. The workers report
 * their thresholds on boot (scan_worker_ready in engine.jsonl). TWO_SLEEVE_SCAN=shared restores
 * the single in-process scan for smokes only.
 *
 * THE BRAINS ARE ARMED IN EVERY MODE. `--dry` no longer exports TRADER_AUTO_EXECUTE=0 — on that
 * switch both brains return "nothing to do" before they read the account or journal a skip, which
 * is exactly how Monday's 400-tick dry session produced not one brain row. Dry-ness lives in the
 * facade: every write is refused and journaled (dry_order / dry_cancel), the reads pass through,
 * nothing else is exposed, and the runner never contends for the account lock.
 *
 * Flags: --dry  (everything runs, every order is journaled and REFUSED — no broker writes)
 *        --once (one tick, then exit — for a smoke)
 * Env:   TWO_SLEEVE_CONFIG, TWO_SLEEVE_ENV_ROOT (load another checkout's .env.local),
 *        TWO_SLEEVE_SCAN=per-sleeve|shared, TWO_SLEEVE_SCAN_TIMEOUT_MS (45000),
 *        TWO_SLEEVE_FAKE_NOW=<ISO> (dry runs only: pin the runner's clock for an after-hours smoke),
 *        TRADER_AUTOSCAN_MS (60000), TRADER_AUTOSCAN_CLOSED_MS (300000),
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
const { envFromFile, envForMode, dryFacade, tickSummary, ScanWorker } = require(path.join(APP, 'lib', 'two-sleeve', 'runner-support'));
const CFG_FILE = process.env.TWO_SLEEVE_CONFIG || path.join(REPO, 'data', 'lantern-garage', 'trading', 'two-sleeve', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const DIR = path.dirname(CFG_FILE);
fs.mkdirSync(DIR, { recursive: true });
const USER = cfg.userId || process.env.TRADER_AUTO_USER || 'local-owner';
const AUTOSCAN_MS = parseInt(process.env.TRADER_AUTOSCAN_MS || '60000', 10);
const CLOSED_MS = parseInt(process.env.TRADER_AUTOSCAN_CLOSED_MS || '300000', 10);
const SCAN_MODE = String(process.env.TWO_SLEEVE_SCAN || 'per-sleeve').toLowerCase() === 'shared' ? 'shared' : 'per-sleeve';
const SCAN_TIMEOUT_MS = parseInt(process.env.TWO_SLEEVE_SCAN_TIMEOUT_MS || '45000', 10);
// A clock pin for after-hours smokes — honored in DRY runs only, so an armed runner can never be
// talked into a session by a stale variable. The brains and the scans still see the real clock.
const FAKE_NOW = DRY && process.env.TWO_SLEEVE_FAKE_NOW ? Date.parse(process.env.TWO_SLEEVE_FAKE_NOW) : NaN;
const nowMs = () => (Number.isFinite(FAKE_NOW) ? FAKE_NOW : Date.now());

const et = (ms = Date.now()) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const etMin = (ms) => { const d = et(ms); return d.getHours() * 60 + d.getMinutes(); };
const isWeekday = (ms) => { const w = et(ms).getDay(); return w >= 1 && w <= 5; };
const marketHours = (ms) => isWeekday(ms) && etMin(ms) >= 570 && etMin(ms) < 960;
const extendedHours = (ms) => isWeekday(ms) && ((etMin(ms) >= 240 && etMin(ms) < 570) || (etMin(ms) >= 960 && etMin(ms) < 1200));

const journalFile = path.join(DIR, 'engine.jsonl');
const journal = (row) => { try { fs.appendFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n'); } catch (_e) { /* never break a tick */ } };

// ---- brains: ARMED in-process in every mode; each with its own journal + state (captured at require time)
const MODE = envForMode({ dry: DRY, sessionReview: process.env.TRADER_SESSION_REVIEW });
Object.assign(process.env, MODE);
const sleeves = (cfg.sleeves || []).map((s) => {
  const app = s.app && s.app !== '.' ? path.resolve(s.app) : APP;
  process.env.TRADER_TRADES_LOG = path.join(DIR, `${s.id}.autopilot-trades.jsonl`);
  process.env.TRADER_STATE_FILE = path.join(DIR, `${s.id}.state.json`);
  const brain = require(path.join(app, 'lib', 'auto-trader'));
  const env = { ...envFromFile(s.envFile), ...(s.env || {}) };
  return { id: s.id, brain, env, envFile: s.envFile, userId: USER, universe: Array.isArray(s.universe) && s.universe.length ? s.universe : null, app };
});
if (sleeves.length < 1) { console.error('[two-sleeve] no sleeves configured'); process.exit(2); }
// After the requires, the process-level journal/state env must not point at either sleeve.
delete process.env.TRADER_TRADES_LOG; delete process.env.TRADER_STATE_FILE;

// ---- scanners: one worker per sleeve, in that sleeve's tree under that sleeve's env -------------
const workers = {};
if (SCAN_MODE === 'per-sleeve') {
  for (const s of sleeves) workers[s.id] = new ScanWorker({ id: s.id, app: s.app, envFile: s.envFile, env: s.env, universe: s.universe || [], dir: DIR, timeoutMs: SCAN_TIMEOUT_MS, log: journal });
}
const stopWorkers = () => { for (const w of Object.values(workers)) { try { w.stop(); } catch (_e) { /* best effort */ } } };

// ---- broker, lock, engine ---------------------------------------------------------------------
const TradingAPIBridge = require(path.join(APP, 'lib', 'trading-api-bridge'));
const { brokerFacadeFor } = require(path.join(APP, 'lib', 'broker-facade'));
const accountLock = require(path.join(APP, 'lib', 'account-lock'));
const { createEngine } = require(path.join(APP, 'lib', 'two-sleeve', 'engine'));
const { createOwnership } = require(path.join(APP, 'lib', 'two-sleeve', 'ownership'));

const ibkrBridge = new TradingAPIBridge();
// The shared in-process scan survives only as a smoke mode (TWO_SLEEVE_SCAN=shared).
const sharedAgent = SCAN_MODE === 'shared'
  ? new (require(path.join(APP, 'lib', 'trader-agent')))({ cacheExpiry: parseInt(process.env.TRADER_CACHE_EXPIRY || '60000', 10), pythonTimeout: parseInt(process.env.TRADER_PYTHON_TIMEOUT || '30000', 10) })
  : null;
// defaultOwner: the sleeve that ADOPTS positions nobody claimed (pre-existing holdings, a lost
// registry) and inherits untagged resting orders. Default = the first sleeve in tick order;
// set it to "R" when the engine takes over an account the race sleeve was already trading.
const DEFAULT_OWNER = cfg.defaultOwner || (cfg.order || ['S'])[0];
const ownership = createOwnership({ file: path.join(DIR, 'ownership.json'), defaultOwner: DEFAULT_OWNER, onEvent: (ev) => journal(ev) });

let resolved = null;      // { broker, accountId, facade }
let facade = null;        // the engine's broker: the real facade, or the dry wall around it
let engine = null;
let lockNoticed = false;
const stats = { ticks: 0, scans: 0, lastTick: null, lastSignals: {}, lastError: null, started: new Date().toISOString(), pid: process.pid,
  dry: DRY, scan: SCAN_MODE, mode: MODE, fakeNow: Number.isFinite(FAKE_NOW) ? new Date(FAKE_NOW).toISOString() : null };

async function ensureEngine() {
  if (engine) return true;
  resolved = await brokerFacadeFor(USER, ibkrBridge).catch(() => null);
  if (!resolved || !resolved.accountId) { stats.lastError = 'no broker resolved'; return false; }
  facade = DRY ? dryFacade(resolved.facade, journal) : resolved.facade;
  engine = createEngine({ sleeves, order: cfg.order || sleeves.map((s) => s.id), facade, ownership, defaultOwner: DEFAULT_OWNER, journal });
  journal({ event: 'engine_start', broker: resolved.broker, accountId: resolved.accountId, order: engine.order, dry: DRY, scan: SCAN_MODE, mode: MODE, fakeNow: stats.fakeNow,
    sleeves: sleeves.map((s) => ({ id: s.id, app: s.app, envFile: s.envFile, universe: s.universe ? s.universe.length : 'all', env: s.env })) });
  console.info(`[two-sleeve] ${resolved.broker} ${resolved.accountId} — sleeves ${engine.order.join(' then ')}${DRY ? ' (DRY: no orders)' : ''} — scans ${SCAN_MODE}`);
  return true;
}

function heartbeat(extra) {
  try {
    fs.writeFileSync(path.join(DIR, 'heartbeat.json'), JSON.stringify({ ...stats, ...extra, accountId: resolved && resolved.accountId,
      ownership: ownership.snapshot().symbols, engine: engine ? engine.stats : null,
      intents: DRY && facade ? facade.intents : undefined,
      workers: Object.fromEntries(Object.entries(workers).map(([id, w]) => [id, w.status()])),
      at: new Date().toISOString() }));
  } catch (_e) { /* diagnostic only */ }
}

// Every sleeve's scan for this tick, fetched in parallel. A sleeve whose scan failed still ticks
// with no signals — its brain's stop reconciliation and exits must keep running when Yahoo does not.
async function scanAll() {
  const scans = {};
  if (SCAN_MODE === 'shared') {
    if (sharedAgent.cache) sharedAgent.cache.market_scan = null;
    const sc = await sharedAgent.scanMarket();
    for (const s of sleeves) scans[s.id] = sc;
    return scans;
  }
  await Promise.all(sleeves.map(async (s) => {
    try { scans[s.id] = await workers[s.id].scan(); }
    catch (e) {
      scans[s.id] = { signals: [], error: String((e && e.message) || e) };
      journal({ event: 'scan_error', sleeve: s.id, error: scans[s.id].error });
    }
  }));
  return scans;
}

let stopping = false;
async function tick() {
  const now = nowMs();
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
          const scans = await scanAll();
          stats.scans++;
          for (const s of sleeves) stats.lastSignals[s.id] = Array.isArray(scans[s.id] && scans[s.id].signals) ? scans[s.id].signals.length : 0;
          const res = await engine.tick((sl) => scans[sl.id] || { signals: [] }, { now, extended: !mh, protectiveOnly, userId: USER });
          stats.ticks++; stats.lastTick = new Date().toISOString();
          journal({ event: 'tick', protectiveOnly, sleeves: tickSummary(res, scans), collisions: engine.stats.collisions,
            intents: DRY && facade ? Object.keys(facade.intents).length : undefined });
        }
      }
    }
  } catch (e) {
    stats.lastError = String((e && e.message) || e);
    console.error('[two-sleeve] tick failed:', stats.lastError);
    journal({ event: 'tick_error', error: stats.lastError });
  }
  heartbeat({ marketHours: mh, protectiveOnly, nextInMs: delay });
  if (ONCE || stopping) { stopWorkers(); return; }
  setTimeout(tick, delay);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    try { if (resolved && !DRY) accountLock.release(resolved.accountId); } catch (_e) { /* best effort */ }
    journal({ event: 'engine_stop', signal: sig, ticks: stats.ticks });
    stopWorkers();
    process.exit(0);
  });
}
console.info(`[two-sleeve] runner pid ${process.pid} — config ${CFG_FILE}${DRY ? ' — DRY RUN' : ''}${ONCE ? ' — single tick' : ''} — scans ${SCAN_MODE}${stats.fakeNow ? ` — clock pinned ${stats.fakeNow}` : ''}`);
tick();
