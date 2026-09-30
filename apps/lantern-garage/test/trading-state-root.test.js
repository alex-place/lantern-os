'use strict';
/**
 * test/trading-state-root.test.js: ADR-0035 step 1.
 *
 * Trading stores resolve under the data root, which is the persistent volume on the hosted
 * deployment (UNISONA_STATE_DIR). A store that used to live beside the code is copied across
 * once, without overwriting. The kill switch is honoured in the volume location as well as
 * the repo one.
 *
 * Run: node --test test/trading-state-root.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Run a snippet in a fresh process whose state root is `stateDir`, with every per-store
// override removed so the module defaults are what's exercised.
function inChild(stateDir, code) {
  const env = { ...process.env, UNISONA_STATE_DIR: stateDir, SESSION_SECRET: 'test-session-secret-for-state-root' };
  for (const k of ['TRADER_MODE_DIR', 'ACCOUNT_MODE_DIR', 'BROKER_PREF_DIR', 'ALPACA_CRED_DIR', 'IBKR_CRED_DIR',
    'TRADER_TRADES_LOG', 'TRADER_STATE_FILE', 'TRADER_PREDICTION_LEDGER']) delete env[k];
  const r = spawnSync(process.execPath, ['-e', code], { cwd: APP, env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  // The last line is the snippet's result; earlier lines may be migration log output.
  return (r.stdout || '').trim().split(/\r?\n/).pop();
}

test('migratedDataPath copies a legacy store across once and never overwrites', () => {
  const state = tmp('state-root-');
  const legacy = tmp('legacy-store-');
  fs.writeFileSync(path.join(legacy, 'u1.json'), '{"mode":"stock"}');
  const out = inChild(state, `
    const ap = require('./lib/app-paths');
    const p = ap.migratedDataPath(${JSON.stringify(legacy)}, 'x-store');
    const again = ap.migratedDataPath(${JSON.stringify(legacy)}, 'x-store');
    console.log(JSON.stringify({ p, again }));`);
  const { p, again } = JSON.parse(out);
  assert.strictEqual(p, path.join(state, 'data', 'x-store'));
  assert.strictEqual(again, p);
  assert.strictEqual(fs.readFileSync(path.join(p, 'u1.json'), 'utf8'), '{"mode":"stock"}');
  assert.ok(fs.existsSync(path.join(legacy, 'u1.json')), 'the legacy copy stays as a backup');

  // A canonical store that already exists is left alone.
  fs.writeFileSync(path.join(legacy, 'u1.json'), '{"mode":"off"}');
  const state2 = tmp('state-root-');
  fs.mkdirSync(path.join(state2, 'data', 'x-store'), { recursive: true });
  fs.writeFileSync(path.join(state2, 'data', 'x-store', 'u1.json'), '{"mode":"champion"}');
  inChild(state2, `require('./lib/app-paths').migratedDataPath(${JSON.stringify(legacy)}, 'x-store');`);
  assert.strictEqual(fs.readFileSync(path.join(state2, 'data', 'x-store', 'u1.json'), 'utf8'), '{"mode":"champion"}');
});

test('per-user trading choices are written under the state root, not beside the code', () => {
  const state = tmp('state-root-');
  inChild(state, `
    require('./lib/trader-mode').set('u-state-root', 'stock');
    require('./lib/trading-account-mode').set('u-state-root', 'paper');
    require('./lib/broker-preference').set('u-state-root', 'alpaca');`);
  for (const dir of ['trader-mode', 'account-mode', 'broker-preference']) {
    const d = path.join(state, 'data', dir);
    assert.ok(fs.existsSync(d) && fs.readdirSync(d).length > 0, `${dir} should be written under the state root`);
  }
});

test('a halt file on the volume stops every order, like one in the repo folder', () => {
  const state = tmp('state-root-');
  fs.mkdirSync(path.join(state, 'data', 'kalshi'), { recursive: true });
  const out = inChild(state, `
    const g = require('./lib/trading-guard');
    const before = g.haltFile();
    require('fs').writeFileSync(require('path').join(${JSON.stringify(state)}, 'data', 'kalshi', 'TRADING-PAUSED'), '');
    const after = g.haltFile();
    const gate = g.orderGate({ mode: 'paper', qty: 1, price: 10, side: 'buy', equity: 100000 });
    console.log(JSON.stringify({ before, after, allowed: gate.allowed, reason: gate.reason }));`);
  const r = JSON.parse(out);
  if (r.before !== null) return; // this checkout carries its own repo-folder halt file; nothing to prove here
  assert.strictEqual(r.after, 'TRADING-PAUSED');
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /halt/i);
});

test('app-paths requires only node built-ins, so allowing it adds no order authority', () => {
  const raw = fs.readFileSync(path.join(APP, 'lib', 'app-paths.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires, ['fs', 'os', 'path'], `app-paths must stay dependency-free, got: ${requires}`);
});
