'use strict';
/**
 * lib/two-sleeve/scan-worker.js — one sleeve's scanner, forked by runner-support.ScanWorker.
 *
 * The parent prepares process.env (the sleeve's whole box env, its overrides, its universe) and
 * this process loads THAT sleeve's app tree: `TWO_SLEEVE_WORKER_APP/lib/trader-agent` and, through
 * it, that tree's signal engine — so module-load constants (convergence-ev P_MIN) and call-time
 * knobs (TRADER_IBS_MAX, TRADER_SHORT_EDGE, the morning gate) are the sleeve's own, and the race
 * sleeve scans with race's scan.js rather than this tree's. Protocol: {seq, cmd:'scan'} ->
 * {seq, ok, scan|error}; {cmd:'stop'} exits. Requests received before the app has loaded queue.
 * On boot it reports the thresholds it will scan at, which the parent journals as scan_worker_ready.
 *
 * TWO_SLEEVE_WORKER_SCAN=noise (2026-10-02): the sleeve is the noise-area momentum leg. Instead of the tree s
 * trader-agent scan, the worker runs lib/two-sleeve/noise-scan.js over TRADER_NOISE_LEG_PAIRS
 * ("SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ,SMH:SOXL:SOXS") with the tree s market-data module, the 5m feed plus the
 * settled history window. The scan reply is the same { signals } shape; its `noise` field carries the band reads.
 *
 * TRADER_NOISE_LATE_GATE_SHADOW=1 (2026-10-05): the noise scan also runs its journal-only late-reversal gate (see
 * noise-scan.js), writing late_gate_shadow / late_drift_shadow rows to the worker's own log (<dir>/<id>.scan.jsonl)
 * and keeping its observations in TWO_SLEEVE_WORKER_STATE_FILE (<dir>/<id>.scan-state.json, set by the runner).
 *
 * TWO_SLEEVE_WORKER_SCAN=closeibs (2026-10-03): the sleeve buys index funds that close near their session low
 * (lib/two-sleeve/closeibs-scan.js) over the sleeve s universe (TWO_SLEEVE_WORKER_UNIVERSE, required), entry depth
 * TRADER_CLOSE_IBS_MAX (default 0.15). The reply's `closeIbs` field carries the per-name reads.
 *
 * TWO_SLEEVE_WORKER_SCAN=overnight (2026-10-09, draft): the overnight book. The sleeve holds its index funds from the
 * 15:55 print to the 09:40 print when the name's prior close is above its trailing 200-session mean
 * (lib/two-sleeve/overnight-scan.js) over the sleeve s universe (required); TRADER_OVERNIGHT_TREND_N (default 200).
 * TRADER_OVERNIGHT_SHADOW=1 offers nothing and journals the reads it would have traded (overnight_shadow /
 * overnight_shadow_exit rows in the worker's own log). The reply's `overnight` field carries the per-name reads.
 */
const path = require('path');

const queue = [];
let agent = null;
let noise = null;   // the noise-area leg s scan when TWO_SLEEVE_WORKER_SCAN=noise
let closeIbs = null;   // the close-IBS sleeve s scan when TWO_SLEEVE_WORKER_SCAN=closeibs
let overnight = null;   // the overnight book s scan when TWO_SLEEVE_WORKER_SCAN=overnight
let draining = false;
// The clock the custom scans read: the real one, or a dry run's pin (TWO_SLEEVE_WORKER_FAKE_NOW, set by the runner only with --dry).
const clock = () => { const f = Date.parse(process.env.TWO_SLEEVE_WORKER_FAKE_NOW || ''); return Number.isFinite(f) ? f : Date.now(); };

process.on('message', (m) => {
  if (!m) return;
  if (m.cmd === 'stop') process.exit(0);
  if (m.cmd === 'scan') { queue.push(m); drain(); }
});

async function drain() {
  if ((!agent && !noise && !closeIbs && !overnight) || draining) return;
  draining = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      try {
        let scan;
        if (noise) scan = await noise.scan(clock());
        else if (closeIbs) scan = await closeIbs.scan(clock());
        else if (overnight) scan = await overnight.scan(clock());
        else {
          if (agent.cache) agent.cache.market_scan = null;   // every tick scans fresh; the bar cache inside the engine persists
          scan = await agent.scanMarket();
        }
        process.send({ seq: m.seq, ok: true, scan: JSON.parse(JSON.stringify(scan)) });
      } catch (e) {
        process.send({ seq: m.seq, ok: false, error: String((e && e.message) || e) });
      }
    }
  } finally { draining = false; }
}

(function boot() {
  const app = process.env.TWO_SLEEVE_WORKER_APP;
  let universe = [];
  try { universe = JSON.parse(process.env.TWO_SLEEVE_WORKER_UNIVERSE || '[]'); } catch (_e) { universe = []; }
  try {
    if (String(process.env.TWO_SLEEVE_WORKER_SCAN || '').toLowerCase() === 'noise') {
      const yahoo = require(path.join(app, 'lib', 'market-data-yahoo'));
      const { createNoiseScan } = require(path.join(app, 'lib', 'two-sleeve', 'noise-scan'));
      // The journal-only late-reversal gate: rows to the worker's own log, observations in the runner's state file.
      let lateGate = null;
      const lateArmed = process.env.TRADER_NOISE_LATE_GATE === '1';   // the gate as a rule (2026-10-08); the shadow machinery carries it
      if (lateArmed || process.env.TRADER_NOISE_LATE_GATE_SHADOW === '1') {
        const ownLog = process.env.TRADER_TRADES_LOG || null;
        const fq = ownLog ? require(path.join(app, 'lib', 'file-queue')) : null;
        lateGate = {
          stateFile: process.env.TWO_SLEEVE_WORKER_STATE_FILE || (ownLog ? path.join(path.dirname(ownLog), `${process.env.TWO_SLEEVE_WORKER_ID || 'noise'}.scan-state.json`) : null),
          log: (row) => { if (fq) fq.appendJsonlQueued(ownLog, { ts: new Date().toISOString(), ...row }).catch(() => {}); },
          armed: lateArmed,
        };
      }
      noise = createNoiseScan({
        pairs: process.env.TRADER_NOISE_LEG_PAIRS || '',
        getBars: (s, tf) => yahoo.getBars(s, tf),
        getHistory: typeof yahoo.getBarsWindow === 'function' ? (s, from, to) => yahoo.getBarsWindow(s, '5m', from, to) : null,
        lateGate,
      });
      if (!noise.pairs.length) throw new Error('TWO_SLEEVE_WORKER_SCAN=noise needs TRADER_NOISE_LEG_PAIRS (proxy:long:inverse,...)');
      process.send({ ready: true, id: process.env.TWO_SLEEVE_WORKER_ID, app, scan: 'noise', watchlist: noise.pairs.length * 2,
        pairs: noise.pairs.map((p) => `${p.proxy}:${p.up}:${p.dn}`).join(','), ibsMax: null, pMin: null, shortEdge: null,
        lateGate: lateGate ? (lateGate.armed ? 'armed' : 'shadow') : null, stateFile: lateGate ? lateGate.stateFile : null });
      drain();
      return;
    }
    if (String(process.env.TWO_SLEEVE_WORKER_SCAN || '').toLowerCase() === 'overnight') {
      // THE OVERNIGHT BOOK (2026-10-09, draft): the sleeve holds its index funds from the 15:55 print to the 09:40 print when
      // the name is above its trailing 200-session mean; TRADER_OVERNIGHT_SHADOW=1 journals what it would do instead.
      const yahoo = require(path.join(app, 'lib', 'market-data-yahoo'));
      const { createOvernightScan, TREND_N } = require(path.join(app, 'lib', 'two-sleeve', 'overnight-scan'));
      if (!Array.isArray(universe) || !universe.length) throw new Error('TWO_SLEEVE_WORKER_SCAN=overnight needs the sleeve s universe (its index funds)');
      const shadow = process.env.TRADER_OVERNIGHT_SHADOW === '1';
      const ownLog = process.env.TRADER_TRADES_LOG || null;
      const fq = ownLog && shadow ? require(path.join(app, 'lib', 'file-queue')) : null;
      const trendN = process.env.TRADER_OVERNIGHT_TREND_N ? Number(process.env.TRADER_OVERNIGHT_TREND_N) : TREND_N;
      overnight = createOvernightScan({ symbols: universe, getBars: (s, tf) => yahoo.getBars(s, tf), trendN, shadow,
        log: (row) => { if (fq) fq.appendJsonlQueued(ownLog, { ts: new Date().toISOString(), ...row }).catch(() => {}); } });
      process.send({ ready: true, id: process.env.TWO_SLEEVE_WORKER_ID, app, scan: 'overnight', watchlist: overnight.symbols.length,
        symbols: overnight.symbols.join(','), overnight: shadow ? 'shadow' : 'armed', trendN, ibsMax: null, pMin: null, shortEdge: null });
      drain();
      return;
    }
    if (String(process.env.TWO_SLEEVE_WORKER_SCAN || '').toLowerCase() === 'closeibs') {
      const yahoo = require(path.join(app, 'lib', 'market-data-yahoo'));
      const { createCloseIbsScan } = require(path.join(app, 'lib', 'two-sleeve', 'closeibs-scan'));
      if (!Array.isArray(universe) || !universe.length) throw new Error('TWO_SLEEVE_WORKER_SCAN=closeibs needs the sleeve s universe (its index funds)');
      const ibsMax = process.env.TRADER_CLOSE_IBS_MAX ? Number(process.env.TRADER_CLOSE_IBS_MAX) : 0.15;
      closeIbs = createCloseIbsScan({ symbols: universe, getBars: (s, tf) => yahoo.getBars(s, tf), ibsMax });
      process.send({ ready: true, id: process.env.TWO_SLEEVE_WORKER_ID, app, scan: 'closeibs', watchlist: closeIbs.symbols.length,
        symbols: closeIbs.symbols.join(','), ibsMax, pMin: null, shortEdge: null });
      drain();
      return;
    }
    const TraderAgent = require(path.join(app, 'lib', 'trader-agent'));
    agent = new TraderAgent({ cacheExpiry: 1000 });
    if (Array.isArray(universe) && universe.length) {
      // The sleeve's own universe (SPY always present: the brains read its session IBS from the scan).
      const list = [...new Set(['SPY', ...universe.map((s) => String(s).toUpperCase())])];
      Object.defineProperty(agent, 'watchlist', { get: () => list, set: () => {}, configurable: true });
    }
    let pMin = null;
    try { pMin = require(path.join(app, 'lib', 'signal-engine', 'convergence-ev')).P_MIN; } catch (_e) { pMin = null; }
    process.send({ ready: true, id: process.env.TWO_SLEEVE_WORKER_ID, app, watchlist: agent.watchlist.length,
      ibsMax: process.env.TRADER_IBS_MAX || null, pMin: pMin == null ? null : pMin, shortEdge: process.env.TRADER_SHORT_EDGE || null });
    drain();
  } catch (e) {
    try { process.send({ ready: false, error: String((e && e.message) || e) }); } catch (_e) { /* parent gone */ }
    process.exit(3);
  }
})();
