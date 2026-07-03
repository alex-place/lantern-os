// Σ₀ external-reality gate for the IBKR Client Portal Web API client.
//
// The integration this replaces was fictional: a Bearer-token call to
// api.ibkr.com/v1 (an endpoint that does not exist) plus hardcoded market
// quotes. This suite pins the honest contract:
//   1. Pure normalizers map real CPAPI payload shapes → the UI shape.
//   2. TLS verification is skipped ONLY for loopback (self-signed gateway cert).
//   3. When the gateway is absent, every method fails soft — null / [] /
//      {connected:false} — and NEVER throws and NEVER fabricates a value.
//
// No live gateway required: the disconnected path is exercised against a closed
// loopback port (instant ECONNREFUSED), which is exactly the state a box without
// IB Gateway running is in.
//
// Run: node apps/lantern-garage/test/ibkr-cpapi.test.js
'use strict';
const assert = require('assert');
const IbkrCpapi = require('../lib/ibkr-cpapi');
const { isLoopback, pickAmount, normalizeSummary, normalizePosition, inferMode } = IbkrCpapi;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n       ', e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n       ', e.message); }
}

// ── loopback detection (TLS scoping) ─────────────────────────────────────────
check('isLoopback: localhost / 127.x / ::1 are loopback', () => {
  assert.ok(isLoopback('localhost'));
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('127.5.5.5'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('[::1]'));
});
check('isLoopback: public hosts are NOT loopback (cert verified)', () => {
  assert.strictEqual(isLoopback('api.ibkr.com'), false);
  assert.strictEqual(isLoopback('gateway.example.com'), false);
  assert.strictEqual(isLoopback(''), false);
});

// ── pickAmount: number, numeric string, CPAPI {amount} nesting, case-insensitive ─
check('pickAmount reads flat number, {amount}, numeric string; case-insensitive', () => {
  assert.strictEqual(pickAmount({ netliquidation: 100 }, ['netliquidation']), 100);
  assert.strictEqual(pickAmount({ NetLiquidation: { amount: 250.5, currency: 'USD' } }, ['netliquidation']), 250.5);
  assert.strictEqual(pickAmount({ cash: '42.25' }, ['cash']), 42.25);
  assert.strictEqual(pickAmount({ other: 1 }, ['netliquidation']), null);
  assert.strictEqual(pickAmount(null, ['x']), null);
});

// ── normalizeSummary: real CPAPI /portfolio/{acct}/summary shape ──────────────
check('normalizeSummary maps nested {amount} summary → UI shape', () => {
  const raw = {
    netliquidation: { amount: 125000.75, currency: 'USD' },
    totalcashvalue: { amount: 30000, currency: 'USD' },
    buyingpower: { amount: 60000, currency: 'USD' },
    unrealizedpnl: { amount: 1250.5, currency: 'USD' },
    realizedpnl: { amount: -75, currency: 'USD' },
  };
  const n = normalizeSummary(raw);
  assert.strictEqual(n.equity, 125000.75);
  assert.strictEqual(n.cash, 30000);
  assert.strictEqual(n.buyingPower, 60000);
  assert.strictEqual(n.unrealizedPnl, 1250.5);
  assert.strictEqual(n.realizedPnl, -75);
});
check('normalizeSummary returns null for a non-summary payload (no fabrication)', () => {
  assert.strictEqual(normalizeSummary({ error: 'no bridge session' }), null);
  assert.strictEqual(normalizeSummary(null), null);
  assert.strictEqual(normalizeSummary('unauthenticated'), null);
});

// ── normalizePosition: real CPAPI position row → UI shape ─────────────────────
check('normalizePosition maps a CPAPI row → UI shape', () => {
  const p = normalizePosition({
    acctId: 'DU123', conid: 265598, contractDesc: 'AAPL', ticker: 'AAPL',
    position: 50, avgCost: 180.25, avgPrice: 180.25, mktPrice: 185.5,
    mktValue: 9275, unrealizedPnl: 262.5, assetClass: 'STK', currency: 'USD',
  });
  assert.strictEqual(p.symbol, 'AAPL');
  assert.strictEqual(p.conid, 265598);
  assert.strictEqual(p.qty, 50);
  assert.strictEqual(p.avgPrice, 180.25);
  assert.strictEqual(p.currentPrice, 185.5);
  assert.strictEqual(p.unrealizedPnl, 262.5);
  assert.strictEqual(p.assetClass, 'STK');
});
check('normalizePosition falls back to conid when no ticker/desc', () => {
  const p = normalizePosition({ conid: 999, position: 3 });
  assert.strictEqual(p.symbol, '999');
  assert.strictEqual(p.qty, 3);
});

// ── inferMode: paper vs live account ids ─────────────────────────────────────
check('inferMode: DU=paper, U=live, empty=unknown', () => {
  assert.strictEqual(inferMode('DU1234567'), 'paper');
  assert.strictEqual(inferMode('U1234567'), 'live');
  assert.strictEqual(inferMode(''), 'unknown');
  assert.strictEqual(inferMode(null), 'unknown');
});

// ── legacy env: the fabricated api.ibkr.com default must NOT be honored ───────
check('constructor never adopts the fictional api.ibkr.com base', () => {
  const saved = process.env.IBKR_BASE_URL;
  process.env.IBKR_BASE_URL = 'https://api.ibkr.com/v1';
  const c = new IbkrCpapi();
  assert.ok(!/api\.ibkr\.com/i.test(c.baseUrl), `baseUrl should ignore api.ibkr.com, got ${c.baseUrl}`);
  assert.ok(/localhost:5000/.test(c.baseUrl), `should fall back to the local gateway, got ${c.baseUrl}`);
  if (saved === undefined) delete process.env.IBKR_BASE_URL; else process.env.IBKR_BASE_URL = saved;
});

// ── fail-soft: gateway absent (closed loopback port) → honest disconnected ────
async function main() {
  const client = new IbkrCpapi({
    gatewayUrl: 'https://127.0.0.1:1/v1/api', // nothing listens → instant ECONNREFUSED
    timeoutMs: 1500,
    statusTtlMs: 0,
    accountId: 'DU000000',
  });

  await checkAsync('getStatus() resolves connected:false, reachable:false (no throw)', async () => {
    const s = await client.getStatus();
    assert.strictEqual(s.connected, false);
    assert.strictEqual(s.reachable, false);
    assert.strictEqual(s.source, 'ibkr-cpapi');
    assert.ok(Array.isArray(s.evidence) && s.evidence.length > 0, 'status carries evidence');
    assert.ok(/unreachable/i.test(s.evidence.join(' ')), 'evidence explains the disconnect');
  });

  await checkAsync('getAccountSummary() returns null when disconnected (no fabrication)', async () => {
    const a = await client.getAccountSummary('DU000000');
    assert.strictEqual(a, null);
  });

  await checkAsync('getPositions() returns [] when disconnected (no throw)', async () => {
    const p = await client.getPositions('DU000000');
    assert.ok(Array.isArray(p) && p.length === 0);
  });

  await checkAsync('probe() resolves (never rejects) on a closed port', async () => {
    const pr = await client.probe();
    assert.strictEqual(pr.reachable, false);
    assert.strictEqual(pr.authenticated, false);
  });

  console.log(failures === 0
    ? '\nAll IBKR CPAPI checks passed.'
    : `\n${failures} IBKR CPAPI check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
