'use strict';
/**
 * test/server-role-gates.test.js — #3523.
 *
 * When the app is split, every background job server.js starts must belong to exactly
 * one half: the website's jobs behind runsWeb(), the trading jobs behind runsTrader().
 * Unset LANTERN_ROLE is 'all', where both are true, so the local boxes run everything
 * exactly as before. Source checks, because booting server.js twice per role would test
 * the machine, not the wiring.
 * Run: node --test apps/lantern-garage/test/server-role-gates.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8').replace(/\r\n/g, '\n');
const server = read('server.js');

test('the role is applied after the .env files load and before routes/trading.js does', () => {
  const at = server.indexOf('processRole.applyRoleEnv();');
  assert.ok(at > 0, 'applyRoleEnv is called');
  assert.ok(at > server.indexOf('for (const { path: envPath, override } of candidateEnvFiles)'), 'an .env file cannot re-arm the web process');
  assert.ok(at < server.indexOf('require("./routes/trading")'), 'the web process never schedules the trading loops');
});

const WEB_GATES = [
  /if \(processRole\.runsWeb\(\)\) jobWorker\.start\(2000\)/,
  /if \(processRole\.runsWeb\(\)\) \{\n\/\/ ── MCP Server \(no-auth, port 8771\) ──/,
  /LANTERN_CLOUDFLARE_TUNNEL !== "false" && processRole\.runsWeb\(\)/,
  /if \(processRole\.runsWeb\(\)\) try \{ require\('\.\/lib\/legacy-data-migrate'\)/,
  /SIGMA0_IMPROVEMENT_SCHEDULER === "1" && processRole\.runsWeb\(\)/,
  /if \(processRole\.runsWeb\(\)\) setTimeout\(\(\) => \{\n {4}try \{\n {6}const q = require\("\.\/routes\/queue"\)/,
  /RAG_HOUSE_BOOT_REGEN !== "0" && processRole\.runsWeb\(\)/,
  /if \(processRole\.runsWeb\(\)\) \{\n {6}const kalshiCollector = require\("\.\/lib\/kalshi-collector"\)/,
  /if \(processRole\.runsWeb\(\)\) \{\n {6}const CryptoCollector = require\("\.\/lib\/crypto-collector"\)/,
  /if \(processRole\.runsWeb\(\)\) \{\n {6}const NewsCollector = require\("\.\/lib\/news-collector"\)/,
  /if \(processRole\.runsWeb\(\)\) require\("\.\/lib\/active-user-metric"\)\.startWeeklyRollupScheduler\(\)/,
  /KALSHI_CRYPTO_OBSERVER === "1" && processRole\.runsWeb\(\)/,
  /if \(processRole\.runsWeb\(\)\) \(async \(\) => \{/,
  /if \(processRole\.runsWeb\(\)\) Promise\.resolve\(refreshAllPcsf/,
  /if \(processRole\.runsWeb\(\)\) \(\(\) => \{/,
];
const TRADER_GATES = [
  /if \(processRole\.runsTrader\(\)\) \{\n {6}const brakeMonitor = require\("\.\/lib\/brake-monitor"\)/,
  /if \(processRole\.runsTrader\(\)\) \{\n {6}const sigmaScheduler = require\("\.\/lib\/sigma-scheduler"\)/,
  /if \(processRole\.runsTrader\(\)\) \{\n {6}const \{ startMonitoring \} = require\("\.\/lib\/kalshi-position-monitor"\)/,
];

test("every website job is behind runsWeb()", () => {
  for (const rx of WEB_GATES) assert.match(server, rx);
});

test('every trading job is behind runsTrader()', () => {
  for (const rx of TRADER_GATES) assert.match(server, rx);
});

test('each starter is called exactly once -- the gated call is the only one', () => {
  for (const call of ['jobWorker.start(', 'kalshiCollector.start()', 'brakeMonitor.start()', 'sigmaScheduler.start()',
    'cryptoCollector.start(', 'newsCollector.start(', 'startWeeklyRollupScheduler()', 'startMonitoring()']) {
    assert.strictEqual(server.split(call).length - 1, 1, call);
  }
});

test('start.js: split under the supervisor, otherwise server.js in this very process', () => {
  const s = read('start.js');
  assert.match(s, /if \(process\.env\.LANTERN_SPLIT === '1'\) require\('\.\/lib\/split-supervisor'\)\.run\(\);/);
  assert.match(s, /else require\('\.\/server\.js'\);/);
});

test('railway.json starts start.js', () => {
  const j = JSON.parse(fs.readFileSync(path.join(APP, '..', '..', 'railway.json'), 'utf8'));
  assert.strictEqual(j.deploy.startCommand, 'node apps/lantern-garage/start.js');
});

test('routes/trading.js forwards the trader-owned routes, and only from the web process', () => {
  const t = read('routes/trading.js');
  assert.match(t, /if \(processRole\.role\(\) === 'web' && traderForward\.shouldForward\(url\.pathname\)\) \{\n {4}return traderForward\.forward\(req, res, url, \{ target: processRole\.traderUrl\(\) \}\);\n {2}\}/);
});
