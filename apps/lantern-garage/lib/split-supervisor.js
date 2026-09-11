'use strict';
/**
 * split-supervisor.js — run the website and the trader as two processes (#3523).
 *
 * Started by start.js when LANTERN_SPLIT=1 (production on Railway, where the two can't be
 * separate services: a volume attaches to one service only, and users' broker links,
 * trader modes and tradelists are files on it). Both children run server.js, one with
 * LANTERN_ROLE=web on the service's public PORT, one with LANTERN_ROLE=trader on a
 * loopback port. They share the disk, not an event loop: a slow chat request or a web
 * crash can't stall or kill the trading loop, and the reverse.
 *
 * A child that exits is restarted, 1s, 2s, 4s ... up to 30s apart; a run that lasted a
 * minute resets the count. SIGTERM/SIGINT (a Railway redeploy) goes to both children,
 * and the supervisor exits once they have, or after 15s regardless.
 */
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

function childSpecs(env = process.env) {
  const traderPort = String(env.LANTERN_TRADER_PORT || 4190);
  const base = { ...env };
  delete base.LANTERN_SPLIT;          // the children are the split; they don't split again
  return [
    { name: 'web', env: { ...base, LANTERN_ROLE: 'web', LANTERN_TRADER_URL: `http://127.0.0.1:${traderPort}` } },
    { name: 'trader', env: { ...base, LANTERN_ROLE: 'trader', LANTERN_GARAGE_PORT: traderPort, LANTERN_GARAGE_HOST: '127.0.0.1' } },
  ];
}

const backoffMs = (attempt) => Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));

function run({ env = process.env, spawnImpl = spawn, log = console.log, exit = (c) => process.exit(c), serverPath = SERVER, signals = true } = {}) {
  const kids = new Map();   // name -> { proc, attempts, startedAt }
  let stopping = false;
  const gone = (p) => p.exitCode !== null || p.signalCode !== null;

  const start = (spec) => {
    const k = kids.get(spec.name) || { attempts: 0 };
    const proc = spawnImpl(process.execPath, [serverPath], { env: spec.env, stdio: 'inherit' });
    k.proc = proc;
    k.startedAt = Date.now();
    kids.set(spec.name, k);
    log(`[split] ${spec.name} started (pid ${proc.pid})`);
    proc.on('exit', (code, signal) => {
      if (stopping) {
        if ([...kids.values()].every((x) => gone(x.proc))) exit(0);
        return;
      }
      if (Date.now() - k.startedAt > 60000) k.attempts = 0;
      k.attempts++;
      const wait = backoffMs(k.attempts);
      log(`[split] ${spec.name} exited (${signal || code}); restarting in ${Math.round(wait / 1000)}s`);
      const t = setTimeout(() => { if (!stopping) start(spec); }, wait);
      if (t.unref) t.unref();
    });
  };

  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`[split] ${sig}: stopping web and trader`);
    for (const { proc } of kids.values()) { try { if (!gone(proc)) proc.kill(sig); } catch (_e) { /* already gone */ } }
    if ([...kids.values()].every((x) => gone(x.proc))) return exit(0);
    const t = setTimeout(() => exit(0), 15000);   // a stuck child must not hang a redeploy
    if (t.unref) t.unref();
  };

  childSpecs(env).forEach(start);
  if (signals) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
  return { kids, shutdown };
}

module.exports = { SERVER, childSpecs, backoffMs, run };
