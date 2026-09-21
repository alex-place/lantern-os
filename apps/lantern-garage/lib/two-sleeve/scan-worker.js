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
 */
const path = require('path');

const queue = [];
let agent = null;
let draining = false;

process.on('message', (m) => {
  if (!m) return;
  if (m.cmd === 'stop') process.exit(0);
  if (m.cmd === 'scan') { queue.push(m); drain(); }
});

async function drain() {
  if (!agent || draining) return;
  draining = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      try {
        if (agent.cache) agent.cache.market_scan = null;   // every tick scans fresh; the bar cache inside the engine persists
        const scan = await agent.scanMarket();
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
