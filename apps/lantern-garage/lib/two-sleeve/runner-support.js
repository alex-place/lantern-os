'use strict';
/**
 * lib/two-sleeve/runner-support.js — the runner's pure parts, testable without a broker (#3656).
 *
 * Monday 2026-09-21, the first dry session on race's account: 400 ticks, zero errors, and not
 * one row from either brain. Two contracts had quietly failed inside scripts/two-sleeve-runner.js:
 *
 *   1. `--dry` exported TRADER_AUTO_EXECUTE=0 / TRADER_MANAGE_EXITS=0 to the whole process, and
 *      both brains return "nothing to do" on those switches BEFORE they read the account or
 *      journal a skip. The dry facade — the thing meant to catch every order — was unreachable,
 *      so "no dry orders" meant "no brain ran", not "the brains agreed with the market".
 *   2. ONE shared scan ran this tree's signal engine under the process env (race's .env.local,
 *      IBS 0.15, no P_MIN). The stable sleeve never saw a stable-threshold signal (stable's live
 *      brain bought TLT at IBS 0.29 at 14:12 while the runner counted 0 signals), and the race
 *      sleeve never saw race's own scan.js. convergence-ev's P_MIN is a module-load constant, so
 *      no amount of per-tick env swapping in one process could have fixed it.
 *
 * What this module pins instead:
 *   envForMode({ dry })   the brains are ARMED in-process in every mode. Dry-ness lives in the
 *                         facade, never in the brains' switches. The session review is off in dry.
 *   dryFacade(real, log)  exactly the five reads forwarded, the two writes refused + journaled as
 *                         dry_order / dry_cancel, nothing else exposed — a future facade method
 *                         cannot leak a broker write through a dry run.
 *   ScanWorker            one forked process per sleeve that loads THAT sleeve's app tree with THAT
 *                         sleeve's env file, so module-load constants and call-time knobs alike are
 *                         the box's own. The worker reports its thresholds on boot (scan_worker_ready)
 *                         so the engine journal itself proves which thresholds each sleeve scanned at.
 *   tickSummary(results)  what each brain returned — signals, ENTERs, executed, skipped, and the
 *                         early-return `reason` — so a hollow tick is visible in the engine journal.
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

// Keys that never enter a sleeve's env map: journal/state paths are per brain, the lock and the
// arm switches are the runner's, the loop cadence and extended-hours policy are process-level.
const IGNORE = /^TRADER_(TRADES_LOG|STATE_FILE|LOCK_DIR|LIVE|AUTO_EXECUTE|AUTO_USER|SESSION_REVIEW|MANAGE_EXITS|AUTOSCAN_MS|AUTOSCAN_CLOSED_MS|EXTENDED_EXITS|EXTENDED_HOURS)$/;

/** Every KEY=value line of an env file (comments and blanks skipped, surrounding quotes stripped). */
function parseEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** A sleeve's TRADER_* knobs from its box env file — minus IGNORE, entry judge off unless the file says so. */
function envFromFile(file) {
  const out = {};
  for (const [k, v] of Object.entries(parseEnvFile(file))) if (/^TRADER_/.test(k) && !IGNORE.test(k)) out[k] = v;
  out.TRADER_ENTRY_JUDGE = out.TRADER_ENTRY_JUDGE || '0';
  return out;
}

/**
 * The process-level switches the brains read. ARMED in every mode: a dry run must exercise the
 * whole decision path (entries, exits, re-protects) and let the FACADE refuse the writes — that is
 * the only way "no dry orders" can mean "the brains wanted nothing".
 */
function envForMode({ dry = false, sessionReview } = {}) {
  return {
    TRADER_AUTO_EXECUTE: '1',
    TRADER_MANAGE_EXITS: '1',
    TRADER_SESSION_REVIEW: dry ? '0' : (String(sessionReview) === '1' ? '1' : '0'),
  };
}

const READS = ['getIBKRAccount', 'getIBKRPositions', 'getIBKROpenOrders', 'getIBKRDayPnl', 'getIBKROrderStatus'];
const ORDER_FIELDS = ['ticker', 'side', 'qty', 'type', 'stopPrice', 'limitPrice', 'timeInForce', 'orderType', 'price'];

/**
 * The dry wall. Reads pass through by name; the two writes are refused with the shape the brains
 * treat as a broker rejection and journaled; NOTHING else is exposed. `intents` counts each
 * distinct (sleeve, side, symbol) the brains asked for, so a heartbeat can show "S wanted TLT x14"
 * rather than 14 identical rows.
 */
function dryFacade(real, journal = () => {}) {
  const intents = {};
  const out = { intents, dry: true };
  for (const k of READS) if (real && typeof real[k] === 'function') out[k] = (...a) => real[k](...a);
  out.placeIBKROrder = async (_uid, o) => {
    const order = {};
    for (const f of ORDER_FIELDS) if (o && o[f] !== undefined) order[f] = o[f];
    const key = `${(o && o._owner) || '?'} ${(o && o.side) || '?'} ${(o && o.ticker) || '?'}`;
    intents[key] = (intents[key] || 0) + 1;
    journal({ event: 'dry_order', owner: o && o._owner, order, nth: intents[key] });
    return { status: 'error', reason: 'dry run — no broker writes', dry: true };
  };
  out.cancelIBKROrder = async (_uid, id) => {
    journal({ event: 'dry_cancel', orderId: id });
    return { status: 'error', reason: 'dry run — no broker writes', dry: true };
  };
  return out;
}

/** Per-sleeve tick summary for the engine journal: counts plus the brain's own early-return reason. */
function tickSummary(results, scans) {
  const out = {};
  for (const [id, r] of Object.entries(results || {})) {
    const sc = scans && scans[id];
    const sig = sc && Array.isArray(sc.signals) ? sc.signals : [];
    const row = {
      signals: sig.length,
      enters: sig.filter((s) => s && s.convergence && s.convergence.decision === 'ENTER').length,
      executed: Array.isArray(r && r.executed) ? r.executed.length : 0,
      skipped: Array.isArray(r && r.skipped) ? r.skipped.length : 0,
    };
    if (r && r.reason) row.reason = String(r.reason).slice(0, 160);
    if (r && r.error) row.error = String(r.error).slice(0, 160);
    if (sc && sc.error) row.scan_error = String(sc.error).slice(0, 120);
    out[id] = row;
  }
  return out;
}

/**
 * One sleeve's scanner in its own process. The child gets: the parent's env with every TRADER_*
 * key removed (the parent's box env must not leak), the sleeve's WHOLE env file (data keys and
 * knobs alike, minus IGNORE), the sleeve's override map, its universe, and its own veto log.
 * Requests queue in the child until its app tree has loaded; a hung scan times out, the child is
 * killed, and the next scan() respawns it.
 */
class ScanWorker {
  constructor({ id, app, envFile, env, universe, dir, timeoutMs = 45000, log = () => {}, workerPath } = {}) {
    this.id = id; this.app = app; this.envFile = envFile; this.env = env || {}; this.universe = universe || [];
    this.dir = dir; this.timeoutMs = timeoutMs; this.log = log;
    this.workerPath = workerPath || path.join(__dirname, 'scan-worker.js');
    this.child = null; this.ready = false; this.info = null;
    this.seq = 0; this.pending = new Map();
    this.scans = 0; this.failures = 0; this.spawns = 0;
  }

  _childEnv() {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^TRADER_/.test(k) || /^TWO_SLEEVE_/.test(k)) delete base[k];
    for (const [k, v] of Object.entries(parseEnvFile(this.envFile))) if (!IGNORE.test(k)) base[k] = v;
    for (const [k, v] of Object.entries(this.env)) if (!IGNORE.test(k)) base[k] = String(v);
    base.TRADER_ENTRY_JUDGE = base.TRADER_ENTRY_JUDGE || '0';
    base.TRADER_TRADES_LOG = path.join(this.dir, `${this.id}.scan.jsonl`);
    base.TWO_SLEEVE_WORKER_APP = this.app;
    base.TWO_SLEEVE_WORKER_ID = String(this.id);
    base.TWO_SLEEVE_WORKER_UNIVERSE = JSON.stringify(this.universe);
    return base;
  }

  _spawn() {
    const cp = fork(this.workerPath, [], { cwd: this.app, env: this._childEnv(), execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = cp; this.ready = false; this.spawns++;
    cp.on('message', (m) => this._onMessage(cp, m));
    cp.on('exit', (code, signal) => {
      if (this.child === cp) { this.child = null; this.ready = false; }
      // Only THIS child's requests fail: a killed (timed-out) child exits after its successor
      // may already hold a request, and that one must not be rejected by the old exit.
      this._failPending(`scan worker ${this.id} exited (${code != null ? code : signal})`, cp);
      this.log({ event: 'scan_worker_exit', sleeve: this.id, code, signal });
    });
    cp.on('error', (e) => this._failPending(String((e && e.message) || e), cp));
    return cp;
  }

  _onMessage(cp, m) {
    if (!m || cp !== this.child) return;
    if (m.ready !== undefined) {
      this.ready = !!m.ready; this.info = m;
      this.log({ event: m.ready ? 'scan_worker_ready' : 'scan_worker_failed', sleeve: this.id, pid: cp.pid, app: this.app,
        watchlist: m.watchlist, ibsMax: m.ibsMax, pMin: m.pMin, shortEdge: m.shortEdge, error: m.error });
      return;
    }
    if (m.seq != null && this.pending.has(m.seq)) {
      const p = this.pending.get(m.seq); this.pending.delete(m.seq); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.scan); else { this.failures++; p.reject(new Error(m.error || 'scan failed')); }
    }
  }

  _failPending(why, cp = null) {
    for (const [seq, p] of this.pending) {
      if (cp && p.cp !== cp) continue;
      clearTimeout(p.timer); this.pending.delete(seq); this.failures++; p.reject(new Error(why));
    }
  }

  scan() {
    if (!this.child) this._spawn();
    const cp = this.child;
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq); this.failures++;
        this.log({ event: 'scan_worker_timeout', sleeve: this.id, ms: this.timeoutMs });
        if (this.child === cp) this.child = null;
        try { cp.kill(); } catch (_e) { /* already gone */ }
        reject(new Error(`scan worker ${this.id} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, cp });
      try { cp.send({ seq, cmd: 'scan' }); } catch (e) { clearTimeout(timer); this.pending.delete(seq); reject(e); }
    }).then((scan) => { this.scans++; return scan; });
  }

  stop() {
    const cp = this.child; this.child = null; this.ready = false;
    this._failPending('stopped');
    if (!cp) return;
    try { cp.send({ cmd: 'stop' }); } catch (_e) { /* channel closed */ }
    try { cp.kill(); } catch (_e) { /* already gone */ }
  }

  status() {
    return { pid: this.child ? this.child.pid : null, ready: this.ready, scans: this.scans, failures: this.failures, spawns: this.spawns,
      ibsMax: this.info && this.info.ibsMax, pMin: this.info && this.info.pMin, watchlist: this.info && this.info.watchlist };
  }
}

module.exports = { IGNORE, parseEnvFile, envFromFile, envForMode, dryFacade, tickSummary, ScanWorker, READS };
