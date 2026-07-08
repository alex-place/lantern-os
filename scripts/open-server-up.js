'use strict';
/**
 * open-server-up.js — scheduled ~9:25 ET. Ensures the trader server is running
 * and ARMED so the autopilot trades at the 9:30 open. Idempotent: if 4178 is
 * already up it does nothing. Spawns the server detached so it outlives this
 * process. Writes a one-line status to data/lantern-garage/trading/open-guardian.log.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'lantern-garage');
const LOG = path.join(ROOT, 'data', 'lantern-garage', 'trading', 'open-guardian.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch (_e) { /* server also loads it */ }
}
function log(msg) {
  const line = `[${new Date().toISOString()}] server-up: ${msg}\n`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line); } catch (_e) {}
  console.log(line.trim());
}
function up() {
  return new Promise((res) => {
    const r = http.get('http://127.0.0.1:4178/api/trading/market-status', (rs) => { rs.resume(); res(rs.statusCode === 200); });
    r.on('error', () => res(false));
    r.setTimeout(4000, () => { r.destroy(); res(false); });
  });
}

(async () => {
  loadEnv();
  if (await up()) { log('already up — no action'); return; }
  // remove any stale kill-switch that would block the open (only if left from a prior halt)
  const out = fs.openSync(path.join(ROOT, '.guardian-server.out.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: '4178' },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await up()) { log(`started (armed: LIVE=${process.env.TRADER_LIVE} AUTO=${process.env.TRADER_AUTO_EXECUTE})`); return; } }
  log('FAILED to start within 30s');
  process.exit(1);
})();
