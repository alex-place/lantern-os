/**
 * test_kalshi_api.js — unit tests for kalshi-api.js and kalshi-paper-ledger.js
 *
 * Tests the RSA key loading fix (#397), crypto market discovery (#398),
 * and paper ledger operations (#400).
 *
 * Run: node tests/test_kalshi_api.js
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

// ── Patch require path ────────────────────────────────────────────────────────
const kalshiApi    = require(path.resolve(__dirname, '../apps/lantern-garage/lib/kalshi-api'));
const kalshiLedger = require(path.resolve(__dirname, '../apps/lantern-garage/lib/kalshi-paper-ledger'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── kalshi-api.js ─────────────────────────────────────────────────────────────

console.log('\nkalshi-api.js:');

test('hasCredentials returns false when env vars unset', () => {
  const saved = { k: process.env.KALSHI_API_KEY_ID, p: process.env.KALSHI_PRIVATE_KEY };
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY;
  assert.strictEqual(kalshiApi.hasCredentials(), false);
  process.env.KALSHI_API_KEY_ID    = saved.k || '';
  process.env.KALSHI_PRIVATE_KEY   = saved.p || '';
});

test('loadPrivateKey returns null when no key configured', () => {
  const savedKey  = process.env.KALSHI_PRIVATE_KEY;
  const savedPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  delete process.env.KALSHI_PRIVATE_KEY;
  delete process.env.KALSHI_PRIVATE_KEY_PATH;
  assert.strictEqual(kalshiApi.loadPrivateKey(), null);
  if (savedKey)  process.env.KALSHI_PRIVATE_KEY      = savedKey;
  if (savedPath) process.env.KALSHI_PRIVATE_KEY_PATH = savedPath;
});

test('loadPrivateKey accepts PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)', () => {
  // Generate a test PKCS#8 key
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const saved = process.env.KALSHI_PRIVATE_KEY;
  process.env.KALSHI_PRIVATE_KEY = pem;
  const keyObj = kalshiApi.loadPrivateKey();
  assert.ok(keyObj !== null, 'Expected KeyObject, got null');
  assert.strictEqual(typeof keyObj, 'object');
  if (saved) process.env.KALSHI_PRIVATE_KEY = saved;
  else delete process.env.KALSHI_PRIVATE_KEY;
});

test('loadPrivateKey accepts PKCS#1 PEM (-----BEGIN RSA PRIVATE KEY-----) — #397 fix', () => {
  // Generate a PKCS#1 key (the format Kalshi generates)
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  assert.ok(pem.includes('BEGIN RSA PRIVATE KEY'), 'Test key should be PKCS#1');
  const saved = process.env.KALSHI_PRIVATE_KEY;
  process.env.KALSHI_PRIVATE_KEY = pem;
  // This should NOT throw "unsupported" — that was the bug
  const keyObj = kalshiApi.loadPrivateKey();
  assert.ok(keyObj !== null, 'PKCS#1 key should be accepted');
  if (saved) process.env.KALSHI_PRIVATE_KEY = saved;
  else delete process.env.KALSHI_PRIVATE_KEY;
});

test('loadPrivateKey loads from file path (KALSHI_PRIVATE_KEY_PATH)', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const tmp = path.join(os.tmpdir(), `test_kalshi_key_${Date.now()}.pem`);
  fs.writeFileSync(tmp, pem);
  const savedKey  = process.env.KALSHI_PRIVATE_KEY;
  const savedPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  delete process.env.KALSHI_PRIVATE_KEY;
  process.env.KALSHI_PRIVATE_KEY_PATH = tmp;
  const keyObj = kalshiApi.loadPrivateKey();
  assert.ok(keyObj !== null);
  fs.unlinkSync(tmp);
  if (savedKey)  process.env.KALSHI_PRIVATE_KEY      = savedKey;
  else           delete process.env.KALSHI_PRIVATE_KEY;
  if (savedPath) process.env.KALSHI_PRIVATE_KEY_PATH = savedPath;
  else           delete process.env.KALSHI_PRIVATE_KEY_PATH;
});

test('signedHeaders returns {} when no credentials', () => {
  const savedId  = process.env.KALSHI_API_KEY_ID;
  const savedKey = process.env.KALSHI_PRIVATE_KEY;
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY;
  const headers = kalshiApi.signedHeaders('GET', '/trade-api/v2/portfolio/balance');
  assert.deepStrictEqual(headers, {});
  if (savedId)  process.env.KALSHI_API_KEY_ID  = savedId;
  if (savedKey) process.env.KALSHI_PRIVATE_KEY = savedKey;
});

test('signedHeaders returns valid signature fields with valid key', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const savedId  = process.env.KALSHI_API_KEY_ID;
  const savedKey = process.env.KALSHI_PRIVATE_KEY;
  process.env.KALSHI_API_KEY_ID  = 'test-key-id';
  process.env.KALSHI_PRIVATE_KEY = pem;
  const headers = kalshiApi.signedHeaders('GET', '/trade-api/v2/portfolio/balance');
  assert.ok(headers['KALSHI-ACCESS-KEY']       === 'test-key-id');
  assert.ok(headers['KALSHI-ACCESS-TIMESTAMP'] !== undefined);
  assert.ok(headers['KALSHI-ACCESS-SIGNATURE'] !== undefined);
  // Signature should be a base64 string
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(headers['KALSHI-ACCESS-SIGNATURE']));
  if (savedId)  process.env.KALSHI_API_KEY_ID  = savedId;
  else          delete process.env.KALSHI_API_KEY_ID;
  if (savedKey) process.env.KALSHI_PRIVATE_KEY = savedKey;
  else          delete process.env.KALSHI_PRIVATE_KEY;
});

test('CRYPTO_SERIES contains expected tickers', () => {
  assert.ok(Array.isArray(kalshiApi.CRYPTO_SERIES));
  assert.ok(kalshiApi.CRYPTO_SERIES.includes('KXBTU'));
  assert.ok(kalshiApi.CRYPTO_SERIES.includes('KXETHU'));
  assert.ok(kalshiApi.CRYPTO_SERIES.includes('KXSOLU'));
});

// ── kalshi-paper-ledger.js ────────────────────────────────────────────────────

console.log('\nkalshi-paper-ledger.js:');

// Use a temp ledger for tests
const ORIG_LEDGER = kalshiLedger.LEDGER_PATH;
const TEST_LEDGER = path.join(os.tmpdir(), `test_paper_ledger_${Date.now()}.jsonl`);

function patchLedger() {
  // Monkey-patch the ledger path for tests
  Object.defineProperty(kalshiLedger, 'LEDGER_PATH', {
    get: () => TEST_LEDGER, configurable: true
  });
}

function restoreLedger() {
  Object.defineProperty(kalshiLedger, 'LEDGER_PATH', {
    get: () => ORIG_LEDGER, configurable: true
  });
  if (fs.existsSync(TEST_LEDGER)) fs.unlinkSync(TEST_LEDGER);
}

// Instead of patching (complex), just use a separate test data file approach
// by testing the functions with temp dir

test('openPosition returns valid record', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-test-'));
  const tmpLedger = path.join(tmpDir, 'paper-positions.jsonl');

  // Temporarily override the ledger path via env
  const origEnv = process.env.KALSHI_PAPER_LEDGER_PATH;
  // Since we can't easily mock the path without refactor, just call and verify shape
  const record = kalshiLedger.openPosition({
    ticker: 'TEST-TICKER', title: 'Test Market',
    side: 'yes', entryCents: 45, count: 2,
  });
  assert.ok(record.id.startsWith('paper_'));
  assert.strictEqual(record.event, 'open');
  assert.strictEqual(record.ticker, 'TEST-TICKER');
  assert.strictEqual(record.entryCents, 45);
  assert.strictEqual(record.count, 2);
  assert.ok(record.openedAt);
  fs.rmdirSync(tmpDir, { recursive: true });
});

test('getOpenPositions returns positions without closed ids', () => {
  // Open two, close one, verify one remains
  const p1 = kalshiLedger.openPosition({ ticker: 'A', side: 'yes', entryCents: 50 });
  const p2 = kalshiLedger.openPosition({ ticker: 'B', side: 'no',  entryCents: 60 });
  kalshiLedger.closePosition(p1.id, 55, 'TAKE-PROFIT');
  const open = kalshiLedger.getOpenPositions();
  assert.ok(open.some(p => p.id === p2.id), 'p2 should still be open');
  assert.ok(!open.some(p => p.id === p1.id), 'p1 should be closed');
});

test('closePosition returns pnlPct correctly', () => {
  const p = kalshiLedger.openPosition({ ticker: 'CLOSE-TEST', side: 'yes', entryCents: 50 });
  const close = kalshiLedger.closePosition(p.id, 70, 'TAKE-PROFIT'); // +40%
  assert.strictEqual(close.pnlPct, 40);
  assert.strictEqual(close.exitTag, 'TAKE-PROFIT');
});

test('closePosition returns null for unknown id', () => {
  const result = kalshiLedger.closePosition('nonexistent-id', 50, 'MANUAL');
  assert.strictEqual(result, null);
});

test('getHistory returns win rate and avg P&L', () => {
  // Already have positions from previous tests
  const history = kalshiLedger.getHistory(50);
  assert.ok(typeof history.count === 'number');
  assert.ok(typeof history.winRate === 'number');
  assert.ok(typeof history.avgPnlPct === 'number');
  assert.ok(Array.isArray(history.trades));
  assert.ok(history.winRate >= 0 && history.winRate <= 100);
});

test('evaluatePositions marks stop-loss correctly', () => {
  const p = kalshiLedger.openPosition({ ticker: 'SL-TEST', side: 'yes', entryCents: 100 });
  const priceMap = new Map([['SL-TEST', 65]]); // -35% → stop-loss
  const positions = kalshiLedger.evaluatePositions(priceMap);
  const sl = positions.find(x => x.id === p.id);
  assert.ok(sl, 'Position should be in evaluatePositions result');
  assert.strictEqual(sl.autoExit, 'STOP-LOSS');
  assert.ok(sl.pnlPct <= -30);
});

test('evaluatePositions marks take-profit correctly', () => {
  const p = kalshiLedger.openPosition({ ticker: 'TP-TEST', side: 'yes', entryCents: 50 });
  const priceMap = new Map([['TP-TEST', 75]]); // +50% → take-profit
  const positions = kalshiLedger.evaluatePositions(priceMap);
  const tp = positions.find(x => x.id === p.id);
  assert.ok(tp);
  assert.strictEqual(tp.autoExit, 'TAKE-PROFIT');
});

test('evaluatePositions leaves healthy positions un-flagged', () => {
  const p = kalshiLedger.openPosition({ ticker: 'OK-TEST', side: 'yes', entryCents: 50 });
  const priceMap = new Map([['OK-TEST', 52]]); // +4% → healthy
  const positions = kalshiLedger.evaluatePositions(priceMap);
  const ok = positions.find(x => x.id === p.id);
  assert.ok(ok);
  assert.strictEqual(ok.autoExit, null);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
