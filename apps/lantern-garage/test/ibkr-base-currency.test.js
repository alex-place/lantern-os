// IBKR base currency → USD (2026-11-11). Stable's paper account is IB-CAN (CA$1M): IBKR states the
// summary and P&L in CAD while positions and orders are USD, so equity and cash were read as dollars
// beside USD holdings. The session row's equity - cash - holdings ran (USDCAD - 1) x holdings, and
// every size taken as a percentage of equity ran ~1.42x. This suite pins the conversion:
//   1. the summary's currency is read, and the ledger rate's DIRECTION is checked, not assumed;
//   2. a non-USD base is restated in USD (summary and partitioned P&L); a USD base costs no call;
//   3. an unknown rate means an unknown account (null), never a figure ~40 % off;
//   4. the previous session row (written in CAD) is restated before the day's change is taken,
//      and new session rows record their currency.
// Run: node apps/lantern-garage/test/ibkr-base-currency.test.js
'use strict';
const assert = require('assert');
const IbkrCpapi = require('../lib/ibkr-cpapi');
const { normalizeSummary, pickCurrency, fxFromLedger } = IbkrCpapi;
const dayPnl = require('../lib/day-pnl');
const { buildSessionRecord } = require('../lib/session-record');
const TradingAPIBridge = require('../lib/trading-api-bridge');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n       ', e.message); }
}
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

// 11-11 close, stable's account as IBKR states it (CAD) and its rate.
const FX = 1.4244;
const CAD_SUMMARY = {
  netliquidation: { amount: 984066.0, currency: 'CAD' },
  totalcashvalue: { amount: 1680.0, currency: 'CAD' },
  buyingpower: { amount: 2400000.0, currency: 'CAD' },
  unrealizedpnl: { amount: -1424.4, currency: 'CAD' },
  realizedpnl: { amount: 0, currency: 'CAD' },
};
// A consistent IB-CAN ledger: BASE cash = CAD cash + USD cash x rate (USD borrowed to buy US stock).
const USD_CASH = -680000;
const LEDGER = {
  USD: { currency: 'USD', cashbalance: USD_CASH, exchangerate: FX },
  CAD: { currency: 'CAD', cashbalance: 1680 - USD_CASH * FX, exchangerate: 1 },
  BASE: { currency: 'BASE', cashbalance: 1680, exchangerate: 1 },
};

/** A client whose HTTP layer is a table: path -> response (or a function of the call count). */
function stubClient(routes) {
  const c = new IbkrCpapi({ gatewayUrl: 'https://127.0.0.1:1/v1/api', accountId: 'DUR000001', statusTtlMs: 0 });
  c.calls = [];
  c._request = async (method, apiPath) => {
    c.calls.push(apiPath);
    const hit = Object.entries(routes).find(([k]) => apiPath.includes(k));
    if (!hit) return { ok: false, status: 404, json: null };
    const v = typeof hit[1] === 'function' ? hit[1](c.calls.filter((p) => p.includes(hit[0])).length) : hit[1];
    return v === null ? { ok: false, status: 500, json: null } : { ok: true, status: 200, json: v };
  };
  return c;
}

(async () => {
  // ── 1. currency + rate direction ─────────────────────────────────────────────
  await check('normalizeSummary reports the base currency the amounts are stated in', () => {
    assert.strictEqual(normalizeSummary(CAD_SUMMARY).currency, 'CAD');
    assert.strictEqual(normalizeSummary({ netliquidation: 100, totalcashvalue: 50 }).currency, null);   // bare numbers: unknown
    assert.strictEqual(pickCurrency({ NetLiquidation: { amount: 1, currency: 'usd' } }, ['netliquidation']), 'USD');
  });
  await check('fxFromLedger: base units per USD, checked against BASE = sum(cash x rate)', () => {
    near(fxFromLedger(LEDGER, 'USD'), FX);
  });
  await check('fxFromLedger: a build that states the rate the other way round is inverted, not trusted', () => {
    const inv = {
      USD: { cashbalance: USD_CASH, exchangerate: 1 / FX },
      CAD: { cashbalance: 1680 - USD_CASH * FX, exchangerate: 1 },
      BASE: { cashbalance: 1680 },
    };
    near(fxFromLedger(inv, 'USD'), FX, 1e-9);
  });
  await check('fxFromLedger: a rate rounded to 4 places on large balances still reads (tolerance scales with the balances)', () => {
    const trueRate = 1.424371;
    const rounded = {
      USD: { cashbalance: USD_CASH, exchangerate: 1.4244 },
      CAD: { cashbalance: Math.round((1680 - USD_CASH * trueRate) * 100) / 100, exchangerate: 1 },
      BASE: { cashbalance: 1680 },
    };
    near(fxFromLedger(rounded, 'USD'), 1.4244);
  });
  await check('fxFromLedger: a ledger that adds up neither way, or has no USD row, is unknown (null)', () => {
    const bad = { USD: { cashbalance: -1000, exchangerate: FX }, CAD: { cashbalance: 5000, exchangerate: 1 }, BASE: { cashbalance: 123456 } };
    assert.strictEqual(fxFromLedger(bad, 'USD'), null);
    assert.strictEqual(fxFromLedger({ CAD: { cashbalance: 5, exchangerate: 1 }, BASE: { cashbalance: 5 } }, 'USD'), null);
    assert.strictEqual(fxFromLedger(null, 'USD'), null);
  });

  // ── 2. the summary and the P&L in USD ────────────────────────────────────────
  await check('getAccountSummary restates a CAD account in USD at the ledger rate', async () => {
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': LEDGER });
    const s = await c.getAccountSummary('DUR000001');
    near(s.equity, 984066 / FX, 1e-6);
    near(s.cash, 1680 / FX, 1e-6);
    near(s.buyingPower, 2400000 / FX, 1e-6);
    near(s.unrealizedPnl, -1424.4 / FX, 1e-9);
    assert.strictEqual(s.currency, 'USD');
    assert.strictEqual(s.base_currency, 'CAD');
    near(s.fx_usd_to_base, FX);
    // the 11-11 holdings (US$689,871) now reconcile: equity - cash is within 0.1 % of them, not 42 % over
    assert.ok(Math.abs((s.equity - s.cash) - 689871) / 689871 < 0.001, `equity - cash ${s.equity - s.cash}`);
  });
  await check('a USD-base account is returned as stated, with no ledger call', async () => {
    const c = stubClient({ '/summary': { netliquidation: { amount: 125000, currency: 'USD' }, totalcashvalue: { amount: 30000, currency: 'USD' } }, '/ledger': LEDGER });
    const s = await c.getAccountSummary('DUR000001');
    assert.strictEqual(s.equity, 125000);
    assert.strictEqual(s.cash, 30000);
    assert.strictEqual(s.base_currency, undefined);
    assert.ok(!c.calls.some((p) => p.includes('/ledger')), 'no ledger read for a USD account');
  });
  await check('the rate is cached: repeated summary reads make one ledger call', async () => {
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': LEDGER });
    await c.getAccountSummary('DUR000001'); await c.getAccountSummary('DUR000001'); await c.getAccountSummary('DUR000001');
    assert.strictEqual(c.calls.filter((p) => p.includes('/ledger')).length, 1);
  });
  await check('an unreadable rate makes the account unknown (null), never CAD read as USD', async () => {
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': null });
    assert.strictEqual(await c.getAccountSummary('DUR000001'), null);
  });
  await check('a failed re-read leans on the last good rate (stale but close beats unknown)', async () => {
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': (n) => (n === 1 ? LEDGER : null) });
    await c.getAccountSummary('DUR000001');
    c._fx.get('DUR000001').at -= 11 * 60 * 1000;          // past the 10-minute freshness window
    const s = await c.getAccountSummary('DUR000001');
    near(s.equity, 984066 / FX, 1e-6);
    c._fx.get('DUR000001').at -= 73 * 3600 * 1000;        // past the 72-hour limit
    assert.strictEqual(await c.getAccountSummary('DUR000001'), null);
  });
  await check('IBKR_REPORT_CURRENCY=base keeps the broker currency (the old behaviour)', async () => {
    process.env.IBKR_REPORT_CURRENCY = 'base';
    try {
      const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': LEDGER });
      const s = await c.getAccountSummary('DUR000001');
      assert.strictEqual(s.equity, 984066);
      assert.strictEqual(s.currency, 'CAD');
    } finally { delete process.env.IBKR_REPORT_CURRENCY; }
  });
  await check('getPnl restates dpl/upl/rpl, learning the base from a summary on a first call', async () => {
    const pnl = { upnl: { 'DUR000001.Core': { dpl: -3230.06, upl: -1946.18 * FX, rpl: 0 } } };
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': LEDGER, '/pnl/partitioned': pnl });
    const p = await c.getPnl('DUR000001');
    near(p.dailyPnl, -3230.06 / FX, 1e-9);
    near(p.unrealizedPnl, -1946.18, 1e-6);
    assert.strictEqual(p.realizedPnl, 0);
    assert.ok(c.calls.some((x) => x.includes('/summary')), 'the base currency came from a summary read');
  });
  await check('the bridge passes the currency through to the account the trader sizes from', async () => {
    const bridge = new TradingAPIBridge();
    const c = stubClient({ '/summary': CAD_SUMMARY, '/ledger': LEDGER, '/pnl/partitioned': { upnl: {} } });
    c.getStatus = async () => ({ connected: true, accountId: 'DUR000001', mode: 'paper' });
    bridge._clientFor = () => c;
    bridge._assertPinnedAccount = () => {};
    const a = await bridge._getIBKRAccountRaw('local-owner');
    near(a.equity, 984066 / FX, 1e-6);
    assert.strictEqual(a.currency, 'USD');
    assert.strictEqual(a.base_currency, 'CAD');
    near(a.fx_usd_to_base, FX);
  });

  // ── 3. the day's equity change across the switch ─────────────────────────────
  const NOW = Date.parse('2026-11-11T21:00:00Z');   // Wed 11-11 16:00 ET; the previous session is 11-10
  const LEGACY = JSON.stringify({ ts: '2026-11-10T21:00:35.000Z', event: 'session', date: '2026-11-10', equity: 987295.75, cash: 176545.14 });
  const LIVE = { equity: 984066 / FX, cash: 1680 / FX, currency: 'USD', base_currency: 'CAD', fx_usd_to_base: FX };
  await check('a legacy (CAD) session row is restated in USD before the day change is taken', () => {
    const p = dayPnl.prevSessionEquity(LEGACY, NOW, LIVE);
    near(p.equity, 987295.75 / FX, 1e-6);
    assert.strictEqual(p.restated_from, 'CAD');
    // the day reads -US$2,268 (-0.33 %), not -US$296k
    near(LIVE.equity - p.equity, (984066 - 987295.75) / FX, 1e-6);
  });
  await check('a USD session row, or no live account, is compared as written', () => {
    const usdRow = JSON.stringify({ ts: '2026-11-10T21:00:35.000Z', event: 'session', date: '2026-11-10', equity: 693000, currency: 'USD' });
    assert.strictEqual(dayPnl.prevSessionEquity(usdRow, NOW, LIVE).equity, 693000);
    assert.strictEqual(dayPnl.prevSessionEquity(LEGACY, NOW).equity, 987295.75);
    assert.strictEqual(dayPnl.prevSessionEquity(LEGACY, NOW, { equity: 100, currency: 'USD' }).equity, 987295.75);   // USD-base account
  });
  await check('new session rows record their currency, base and rate', () => {
    const r = buildSessionRecord({ ledgerText: '', now: NOW, account: LIVE });
    assert.strictEqual(r.currency, 'USD');
    assert.strictEqual(r.base_currency, 'CAD');
    near(r.fx_usd_to_base, FX);
    const plain = buildSessionRecord({ ledgerText: '', now: NOW, account: { equity: 1000, cash: 1000 } });
    assert.strictEqual(plain.currency, undefined);
  });

  console.log(failures === 0 ? '\nAll IBKR base-currency checks passed.' : `\n${failures} IBKR base-currency check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
