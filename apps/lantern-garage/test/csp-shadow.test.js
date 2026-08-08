'use strict';

/**
 * csp-shadow.test.js — the CSP shadow book (#3219). Observer only.
 *
 * The whole point is a per-signal PAIRED comparison run honestly: real quoted
 * bids (conservative), real resolution against the underlying, and a journal
 * that never invents data. These tests pin contract selection, sizing,
 * resolution math, and the full open→resolve file cycle offline.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CSP_SHADOW_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csp-shadow-')), 'csp-shadow.jsonl');
const shadow = require('../lib/csp-shadow');

const NOW = Date.parse('2026-08-10T14:00:00Z');   // Monday morning ET
const put = (strike, expiration, bid, ask = null) => ({ type: 'put', strike, expiration, bid, ask });

test('pickContract: nearest weekly at the highest strike <= the washout price', () => {
  const rows = [
    put(100, '2026-08-14', 1.20),
    put(98, '2026-08-14', 0.80),
    put(102, '2026-08-14', 2.10),          // above the signal price → not cash-secured at the washout
    put(100, '2026-08-21', 2.40),          // later expiry → not preferred
    { type: 'call', strike: 100, expiration: '2026-08-14', bid: 1.5 },
  ];
  const { contract } = shadow.pickContract(rows, 100.5, NOW);
  assert.strictEqual(contract.strike, 100);
  assert.strictEqual(contract.expiration, '2026-08-14');
});

test('pickContract: refuses bid-less contracts and too-near/too-far expiries', () => {
  const rows = [
    put(100, '2026-08-14', 0),             // no real bid — never assume a fill
    put(100, '2026-08-11', 1.0),           // <2 days out
    put(100, '2026-09-18', 3.0),           // >11 days out
  ];
  const { contract, reason } = shadow.pickContract(rows, 100.5, NOW);
  assert.strictEqual(contract, null);
  assert.match(reason, /no put/);
});

test('contractsFor: same-notional sizing, minimum one contract', () => {
  assert.strictEqual(shadow.contractsFor(356), 4);   // the XLK-sized position
  assert.strictEqual(shadow.contractsFor(46), 1);    // the QQQ-sized position (round(0.46)=0 → min 1)
  assert.strictEqual(shadow.contractsFor(0), 1);
});

test('resolvePnl: expired keeps the premium; assigned nets premium minus intrinsic', () => {
  const leg = { premium: 1.2, strike: 100, contracts: 2 };
  assert.deepStrictEqual(shadow.resolvePnl(leg, 101), { outcome: 'expired', pnl: 240 });
  // assigned 3 below strike: 240 premium − 600 intrinsic = −360 (better than
  // stock's −5% stop on the same notional, and the basis is strike − premium)
  assert.deepStrictEqual(shadow.resolvePnl(leg, 97), { outcome: 'assigned', pnl: -360 });
  assert.strictEqual(shadow.resolvePnl(leg, 100).outcome, 'expired', 'at the strike = expires worthless');
});

test('full cycle: open from an injected chain, resolve after expiry, journal both rows', async () => {
  const chain = { available: true, source: 'test', rows: [put(719, '2026-08-14', 4.80, 5.10)] };
  const row = await shadow.onEntry({ symbol: 'QQQ', price: 721.68, qty: 39, ts: NOW }, { chain });
  assert.ok(row, 'a shadow leg must be recorded');
  assert.strictEqual(row.strike, 719);
  assert.strictEqual(row.premium, 4.80, 'filled at the BID — conservative');
  assert.strictEqual(row.contracts, 1);
  assert.strictEqual(shadow.openCount(), 1);

  const afterExpiry = Date.parse('2026-08-14T21:30:00Z');
  const n = await shadow.resolveDue(async () => 725.0, afterExpiry);
  assert.strictEqual(n, 1);
  assert.strictEqual(shadow.openCount(), 0);

  const lines = fs.readFileSync(process.env.CSP_SHADOW_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  const close = lines.find((r) => r.event === 'csp_shadow_close');
  assert.strictEqual(close.outcome, 'expired');
  assert.strictEqual(close.pnl, 480, '4.80 x 100 x 1 kept');
  assert.ok(close.resolve_lag_s >= 0, 'the approximation is labeled, not hidden');
});

test('an unavailable chain writes an honest skip row, never a guessed leg', async () => {
  const before = shadow.openCount();
  const r = await shadow.onEntry({ symbol: 'GLD', price: 390, qty: 85, ts: NOW }, { chain: { available: false, reason: 'all providers down' } });
  assert.strictEqual(r, null);
  assert.strictEqual(shadow.openCount(), before);
  const lines = fs.readFileSync(process.env.CSP_SHADOW_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  const skip = lines.find((x) => x.event === 'csp_shadow_skip' && x.symbol === 'GLD');
  assert.match(skip.reason, /providers down/);
});

test('TRADER_CSP_SHADOW=0 disables the observer entirely', async () => {
  process.env.TRADER_CSP_SHADOW = '0';
  try {
    const r = await shadow.onEntry({ symbol: 'SPY', price: 770, qty: 43, ts: NOW }, { chain: { available: true, rows: [put(770, '2026-08-14', 3)] } });
    assert.strictEqual(r, null);
  } finally { delete process.env.TRADER_CSP_SHADOW; }
});

test('a restart re-reads the journal — open legs survive process death', async () => {
  const chain = { available: true, source: 'test', rows: [put(56, '2026-08-14', 0.90)] };
  await shadow.onEntry({ symbol: 'TNA', price: 56.4, qty: 191, ts: NOW }, { chain });
  const openBefore = shadow.openCount();
  shadow._resetForTests();                        // simulate a fresh process
  assert.strictEqual(shadow.openCount(), openBefore, 'the journal is the source of truth');
});
