'use strict';
/**
 * test/positions-alpaca-day-pnl.test.js — #3520.
 *
 * The Alpaca path of /api/trading/positions must hand every row its Day P&L from the same
 * lib/day-pnl the IBKR path uses, and must fall back to the broker's own figures — never
 * a crash, never an invented number — when the ledger cannot be read. Before #3520 the
 * trader's Day P&L column read "—" on every Alpaca position.
 *
 * Drives the REAL route with its collaborators stubbed through the require cache.
 * Run: node --test apps/lantern-garage/test/positions-alpaca-day-pnl.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const ROUTE = require.resolve(path.join(__dirname, '..', 'routes', 'trading', 'market.js'));
const ledger = path.join(os.tmpdir(), 'alpaca-day-pnl-ledger-' + process.pid + '.jsonl');
fs.writeFileSync(ledger, '{"event":"noop"}\n');

const stubbed = [];
function stub(name, exportsObj) {
  const file = require.resolve(path.join(LIB, name));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
  stubbed.push(file);
}
let dayPnlCalls = [];
let dayPnlImpl = null;
stub('alpaca-adapter', {
  getAccount: async () => ({ account_id: 'PA-TEST', equity: 100000, cash: 50000, pnl_today: 321, realized_today: 0, source: 'alpaca' }),
  getPositions: async () => ({ positions: [
    { symbol: 'SPY', qty: 20, side: 'long', avg_entry_price: 758.39, current_price: 765.36, market_value: 15307.2, unrealized_pl: 139.4, pnl_pct: 0.92 },
    { symbol: 'TLT', qty: 190, side: 'long', avg_entry_price: 81.04, current_price: 80.96, market_value: 15382.4, unrealized_pl: -15.2, pnl_pct: -0.1 },
  ] }),
});
stub('broker-facade', { preferredBroker: () => 'alpaca' });
stub('auth-middleware', { isAdmin: () => false });
stub('market-data-yahoo', { getQuotes: async () => [] });
stub('day-pnl', {
  computeDayPnl: async (o) => { dayPnlCalls.push(o); return dayPnlImpl(o); },
  resolveTradesLog: () => ledger,
  resolveBarsDir: () => os.tmpdir(),
  prevCloseFromBarsFactory: () => async () => null,
});
const marketRoutes = require(ROUTE);

after(() => {
  for (const f of stubbed.concat([ROUTE])) delete require.cache[f];
  try { fs.unlinkSync(ledger); } catch (_e) { /* already gone */ }
});

async function hit() {
  let out = {};
  const ctx = {
    deps: {}, bridge: {}, traderAgent: null, getPriceFeed: () => null, tradingMemory: null,
    getEffectiveUserId: () => 'u-test',
    sendJson: (res, body, code) => { out = { body, code }; },
  };
  const handled = await marketRoutes({ method: 'GET', headers: {} }, {}, new URL('http://x/api/trading/positions'), ctx);
  return { handled, ...out };
}

test('every Alpaca row carries its Day P&L from lib/day-pnl, and the tile takes the ledger basis', async () => {
  dayPnlCalls = [];
  dayPnlImpl = () => ({
    realized_today: 0, realized_booked: 0, unrealized_today: 128.4, pnl_today: 128.4, pnl_carry_adjustment: 0, pnl_basis: 'ledger',
    per_position: [{ symbol: 'SPY', day_pnl: 147.4, day_basis: 'prev_close' }, { symbol: 'TLT', day_pnl: -19, day_basis: 'entry' }],
  });
  const r = await hit();
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.code, 200);
  const bySym = Object.fromEntries(r.body.positions.map((p) => [p.symbol, p]));
  assert.strictEqual(bySym.SPY.day_pnl, 147.4);
  assert.strictEqual(bySym.SPY.day_basis, 'prev_close');
  assert.strictEqual(bySym.TLT.day_pnl, -19);
  assert.strictEqual(bySym.TLT.day_basis, 'entry');
  assert.strictEqual(r.body.account.pnl_today, 128.4);
  assert.strictEqual(r.body.account.unrealized_today, 128.4);
  assert.match(r.body.account.pnl_basis, /^alpaca: ledger$/);
  assert.strictEqual(dayPnlCalls.length, 1, 'computed once per request');
  assert.deepStrictEqual(dayPnlCalls[0].positions.map((p) => p.symbol), ['SPY', 'TLT'], "the adapter's own rows go in");
  assert.match(dayPnlCalls[0].ledgerText, /noop/, 'the ledger comes from resolveTradesLog');
});

test('an unreadable ledger keeps the broker figures: no crash, no invented day number', async () => {
  dayPnlImpl = () => { throw new Error('ledger gone'); };
  const r = await hit();
  assert.strictEqual(r.code, 200);
  assert.ok(r.body.positions.every((p) => p.day_pnl === undefined), 'no row gets a made-up day figure');
  assert.strictEqual(r.body.account.pnl_today, 321, "the broker's own day P&L stands");
  assert.strictEqual(r.body.account.pnl_basis, undefined);
});
