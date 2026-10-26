'use strict';
/**
 * positions-ibkr-day-pnl-equity.test.js — the IBKR account tile's Day P&L is the account's equity change
 * since the previous close (2026-10-26), with or without open positions.
 *
 * Drives the REAL positions route and the REAL lib/day-pnl on the 2026-10-26 stable ledger shape: Friday's
 * session row (equity $963,377.00), the three XLE sells the ledger booked as long exits, DIA bought today.
 * The page read -$899 that day; the account made +$1,627.06. The IBKR collaborators are stubbed.
 * Run: node --test apps/lantern-garage/test/positions-ibkr-day-pnl-equity.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const ROUTE = require.resolve(path.join(__dirname, '..', 'routes', 'trading', 'market.js'));
const ledger = path.join(os.tmpdir(), 'ibkr-day-pnl-equity-' + process.pid + '.jsonl');
const NOW = Date.parse('2026-10-26T20:30:00Z');   // Monday 16:30 ET
const rows = [
  { ts: '2026-10-23T20:01:32Z', event: 'session', date: '2026-10-23', equity: 963377.00 },
  { ts: '2026-10-16T14:00:00Z', event: 'entry', symbol: 'XLE', qty: 2628, entry: 67.35 },
  { ts: '2026-10-26T14:53:55Z', event: 'exit', symbol: 'XLE', qty: 2628, entry: 69.045003, exit: 69.22, pnl: 459.89 },
  { ts: '2026-10-26T14:54:16Z', event: 'exit', symbol: 'XLE', qty: 2628, entry: 69.045003, exit: 69.21, pnl: 433.61 },
  { ts: '2026-10-26T14:54:22Z', event: 'exit', symbol: 'XLE', qty: 2628, entry: 69.045003, exit: 69.21, pnl: 433.61 },
  { ts: '2026-10-26T16:08:01Z', event: 'entry', symbol: 'DIA', qty: 157, entry: 522.80 },
];
fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const prevEnv = { log: process.env.TRADER_TRADES_LOG, extra: process.env.TRADER_TRADES_LOG_EXTRA, bars: process.env.TRADER_BARS_DIR };
process.env.TRADER_TRADES_LOG = ledger;
delete process.env.TRADER_TRADES_LOG_EXTRA;
process.env.TRADER_BARS_DIR = os.tmpdir();

const stubbed = [];
function stub(name, exportsObj) {
  const file = require.resolve(path.join(LIB, name));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
  stubbed.push(file);
}
stub('broker-facade', { preferredBroker: () => 'ibkr' });
stub('auth-middleware', { isAdmin: () => false });
// prevClose for the carried XLE lot (the bar cache is empty here): Friday's close 69.33
stub('market-data-yahoo', { getQuotes: async (syms) => (syms || []).map((t) => ({ ticker: t, price: t === 'XLE' ? 69.33 : 522.85, chg_pct: 0 })) });
const realDateNow = Date.now;
Date.now = () => NOW;
const marketRoutes = require(ROUTE);

after(() => {
  Date.now = realDateNow;
  for (const f of stubbed.concat([ROUTE])) delete require.cache[f];
  for (const [k, v] of [['TRADER_TRADES_LOG', prevEnv.log], ['TRADER_TRADES_LOG_EXTRA', prevEnv.extra], ['TRADER_BARS_DIR', prevEnv.bars]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.unlinkSync(ledger); } catch (_e) { /* already gone */ }
});

async function hit(positions) {
  let out = {};
  const ctx = {
    deps: {}, traderAgent: null, getPriceFeed: () => null, tradingMemory: null,
    getEffectiveUserId: () => 'local-owner',
    bridge: {
      getIBKRAccount: async () => ({ account_id: 'DUR193395', equity: 965004.06, cash: 850259.88, pnl_today: -174.07, mode: 'paper', source: 'ibkr' }),
      getIBKRPositions: async () => positions,
    },
    sendJson: (res, body, code) => { out = { body, code }; },
  };
  const handled = await marketRoutes({ method: 'GET', headers: {} }, {}, new URL('http://x/api/trading/positions'), ctx);
  return { handled, ...out };
}

test('2026-10-26: the tile reads the account\'s +$1,627.06, the ledger split stays, other names the rest', async () => {
  const r = await hit([{ symbol: 'DIA', qty: 157, current_price: 522.85, unrealized_pl: 7.85 }]);
  assert.strictEqual(r.code, 200);
  const a = r.body.account;
  assert.strictEqual(a.pnl_today, 1627.06);
  assert.strictEqual(a.pnl_today_source, 'broker_equity');
  assert.strictEqual(a.pnl_prev_equity, 963377);
  assert.strictEqual(a.realized_today, -919.8, 'the ledger booked the three XLE sells as carried long exits: (69.22, 69.21, 69.21 - 69.33) x 2628');
  assert.strictEqual(a.unrealized_today, 7.85);
  assert.strictEqual(Math.round((a.realized_today + a.unrealized_today + a.pnl_other) * 100) / 100, a.pnl_today);
  assert.strictEqual(a.pnl_ledger, -911.95, 'the ledger alone would have said this');
  assert.match(a.pnl_basis, /^equity change since the previous close \(the trader's 2026-10-23 session close\)/);
});

test('an EMPTY book still gets the day (was IBKR\'s re-baselining dpl)', async () => {
  const r = await hit([]);
  const a = r.body.account;
  assert.strictEqual(a.pnl_today, 1627.06, 'not the broker dpl -174.07');
  assert.strictEqual(a.unrealized_today, 0);
  assert.strictEqual(a.pnl_today_source, 'broker_equity');
});
