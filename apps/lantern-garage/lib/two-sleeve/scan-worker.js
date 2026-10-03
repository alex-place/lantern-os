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
 * TWO_SLEEVE_WORKER_SCAN=closeibs (2026-10-03): the sleeve buys index funds that close near their session low
 * (lib/two-sleeve/closeibs-scan.js) over the sleeve s universe (TWO_SLEEVE_WORKER_UNIVERSE, required), entry depth
 * TRADER_CLOSE_IBS_MAX (default 0.15). The reply's `closeIbs` field carries the per-name reads.
 */
const path = require('path');

const queue = [];
let agent = null;
let noise = null;   // the noise-area leg s scan when TWO_SLEEVE_WORKER_SCAN=noise
let closeIbs = null;   // the close-IBS sleeve s scan when TWO_SLEEVE_WORKER_SCAN=closeibs
let draining = false;

process.on('message', (m) => {
  if (!m) return;
  if (m.cmd === 'stop') process.exit(0);
  if (m.cmd === 'scan') { queue.push(m); drain(); }
});

async function drain() {
  if ((!agent && !noise && !closeIbs) || draining) return;
  draining = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      try {
        let scan;
        if (noise) scan = await noise.scan(Date.now());
        else if (closeIbs) scan = await closeIbs.scan(Date.now());
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
      noise = createNoiseScan({
        pairs: process.env.TRADER_NOISE_LEG_PAIRS || '',
        getBars: (s, tf) => yahoo.getBars(s, tf),
        getHistory: typeof yahoo.getBarsWindow === 'function' ? (s, from, to) => yahoo.getBarsWindow(s, '5m', from, to) : null,
      });
      if (!noise.pairs.length) throw new Error('TWO_SLEEVE_WORKER_SCAN=noise needs TRADER_NOISE_LEG_PAIRS (proxy:long:inverse,...)');
      process.send({ ready: true, id: process.env.TWO_SLEEVE_WORKER_ID, app, scan: 'noise', watchlist: noise.pairs.length * 2,
        pairs: noise.pairs.map((p) => `${p.proxy}:${p.up}:${p.dn}`).join(','), ibsMax: null, pMin: null, shortEdge: null });
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
