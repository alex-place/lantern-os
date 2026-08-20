'use strict';
/**
 * alpaca-race-leg.test.js — the engine's Alpaca leg speaks the full bridge
 * contract (#3381).
 *
 * Wiring the two-broker race exposed that the facade's Alpaca leg satisfied the
 * engine only on paper:
 *   - getOpenOrders rows carry `order_id`, but cancelRestingStops reads
 *     `o.orderId` — the engine could never cancel a resting stop on Alpaca
 *     (the orphaned-stop → naked-short class, #2213).
 *   - status=open only, so _reconcileFills never saw a fill — every exit would
 *     book as a mark-priced reconstruction instead of at the fill.
 *   - no per-order status method, so the #3379 stop lookup was an undefined
 *     function on this leg.
 *   - the engine's extended-hours exits pass outsideRth (the IBKR spelling);
 *     Alpaca's is extended_hours, valid only on a DAY limit — exactly the shape
 *     the engine sends.
 *
 * These tests stub https.request (the adapter's only transport) and pin each of
 * those contracts, plus the auto-trader guard for facades that lack the status
 * method (demo/practice).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TRADER_TRADES_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'race-')), 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(path.dirname(process.env.TRADER_TRADES_LOG), 'state.json');

const alpaca = require('../lib/alpaca-adapter');
const at = require('../lib/auto-trader');

// ── a minimal https.request stub: route by path, capture bodies ─────────────
let routes = {};
let captured = [];
const realRequest = https.request;
function stubHttps() {
  captured = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      captured.push({ path: opts.path, method: opts.method, body: body ? JSON.parse(body) : null });
      const hit = Object.entries(routes).find(([p]) => opts.path.startsWith(p));
      const res = new EventEmitter();
      res.statusCode = hit ? 200 : 404;
      cb(res);
      res.emit('data', JSON.stringify(hit ? hit[1] : { message: 'not found' }));
      res.emit('end');
    };
    return req;
  };
}
const unstub = () => { https.request = realRequest; };

const withKeys = async (fn) => {
  const old = { k: process.env.ALPACA_API_KEY, s: process.env.ALPACA_SECRET_KEY, e: process.env.ALPACA_ENV };
  process.env.ALPACA_API_KEY = 'PKTEST';
  process.env.ALPACA_SECRET_KEY = 'SECRETTEST';
  delete process.env.ALPACA_ENV;
  stubHttps();
  try { return await fn(); } finally {
    unstub();
    if (old.k == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = old.k;
    if (old.s == null) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = old.s;
    if (old.e == null) delete process.env.ALPACA_ENV; else process.env.ALPACA_ENV = old.e;
  }
};

test('getEngineOrders: rows carry orderId (not order_id), fills included, working normalized', async () => {
  await withKeys(async () => {
    routes = {
      '/v2/orders?status=open': [
        { id: 'stop-1', symbol: 'SPY', side: 'sell', type: 'stop', status: 'new', qty: '77', filled_qty: '0', stop_price: '745.1', submitted_at: '2026-08-20T13:31:00Z' },
      ],
      '/v2/orders?status=closed': [
        { id: 'fill-1', symbol: 'GLD', side: 'sell', type: 'market', status: 'filled', qty: '290', filled_qty: '290', filled_avg_price: '410.23', filled_at: '2026-08-20T18:32:33Z' },
        { id: 'stop-1', symbol: 'SPY', side: 'sell', type: 'stop', status: 'new', qty: '77', filled_qty: '0' },  // dupe by id → dropped
      ],
    };
    const rows = await alpaca.getEngineOrders('local-owner');
    assert.strictEqual(rows.length, 2, 'deduped by order id');
    const stop = rows.find((r) => r.orderId === 'stop-1');
    assert.ok(stop, 'the field is orderId — what cancelRestingStops reads');
    assert.strictEqual(stop.status, 'submitted', 'working statuses normalize for the STOP_WORKING regex');
    assert.strictEqual(stop.side, 'SELL', 'side uppercased for fill-ledger');
    const fill = rows.find((r) => r.orderId === 'fill-1');
    assert.strictEqual(fill.filledQty, 290);
    assert.strictEqual(fill.avgPrice, 410.23);
    assert.strictEqual(fill.status, 'filled');
    assert.ok(fill.time, 'fill carries a timestamp for the process-start guard');
    // the exact isFilledSell contract
    const fl = require('../lib/fill-ledger');
    assert.strictEqual(fl.isFilledSell(fill), true, 'a real fill row passes isFilledSell');
    assert.strictEqual(fl.isFilledSell(stop), false, 'a working stop does not');
  });
});

test('getOrder: normalizes the per-order status the #3379 sweep consumes', async () => {
  await withKeys(async () => {
    routes = { '/v2/orders/abc-123': { id: 'abc-123', status: 'filled', filled_avg_price: '560.79', filled_qty: '203' } };
    const st = await alpaca.getOrder('local-owner', 'abc-123');
    assert.deepStrictEqual(st, { order_id: 'abc-123', status: 'filled', avgPrice: 560.79, filledQty: 203 });
    assert.match(st.status, /fill/i, 'matches the sweep regex');
  });
});

test('getOrder: unknown id → null, never a throw', async () => {
  await withKeys(async () => {
    routes = {};
    assert.strictEqual(await alpaca.getOrder('local-owner', 'nope'), null);
    assert.strictEqual(await alpaca.getOrder('local-owner', null), null);
  });
});

test('placeOrder: outsideRth on a DAY limit maps to extended_hours, and ONLY then', async () => {
  await withKeys(async () => {
    routes = { '/v2/orders': { id: 'o-1', status: 'accepted' } };
    await alpaca.placeOrder('local-owner', { ticker: 'XLK', side: 'sell', qty: 635, type: 'limit', limitPrice: 184.2, outsideRth: true });
    let body = captured.find((c) => c.method === 'POST').body;
    assert.strictEqual(body.extended_hours, true, 'the engine speaks outsideRth; Alpaca hears extended_hours');
    assert.strictEqual(body.time_in_force, 'day');

    captured = [];
    await alpaca.placeOrder('local-owner', { ticker: 'XLK', side: 'sell', qty: 635, type: 'stop', stopPrice: 180, timeInForce: 'gtc', outsideRth: true });
    body = captured.find((c) => c.method === 'POST').body;
    assert.ok(!('extended_hours' in body), 'a GTC stop must not claim extended_hours — Alpaca rejects it');

    captured = [];
    await alpaca.placeOrder('local-owner', { ticker: 'XLK', side: 'sell', qty: 635, type: 'limit', limitPrice: 184.2 });
    body = captured.find((c) => c.method === 'POST').body;
    assert.ok(!('extended_hours' in body), 'RTH orders unchanged');
  });
});

test('the FACADE alpaca leg exposes the full engine contract, engine-shaped', async () => {
  await withKeys(async () => {
    routes = {
      '/v2/account': { account_number: 'PA3KZEWVVZTP', equity: '103881', cash: '-59563', buying_power: '0' },
      '/v2/orders?status=open': [{ id: 's1', symbol: 'SPY', side: 'sell', type: 'stop', status: 'new', qty: '10', filled_qty: '0' }],
      '/v2/orders?status=closed': [],
      '/v2/positions': [],
    };
    const { brokerFacadeFor } = require('../lib/broker-facade');
    const resolved = await brokerFacadeFor('local-owner', null);   // no IBKR bridge → alpaca leg
    assert.ok(resolved && resolved.broker === 'alpaca', 'resolves alpaca when IBKR is absent');
    assert.strictEqual(resolved.accountId, 'PA3KZEWVVZTP');
    for (const m of ['getIBKRAccount', 'getIBKRPositions', 'getIBKROpenOrders', 'getIBKRDayPnl', 'placeIBKROrder', 'cancelIBKROrder', 'getIBKROrderStatus']) {
      assert.strictEqual(typeof resolved.facade[m], 'function', m + ' present');
    }
    const orders = await resolved.facade.getIBKROpenOrders('local-owner');
    assert.strictEqual(orders[0].orderId, 's1', 'facade serves the ENGINE feed, not the UI feed');
  });
});

test('auto-trader survives a facade WITHOUT getIBKROrderStatus (demo/practice legs)', async () => {
  at._resetCooldowns();
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { SMH: { qty: 203, entry: 576.4, mark: 563.0, ts: Date.now() }, ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() } },
    stopDistPct: { SMH: 3 },
    stopOrders: { SMH: { id: 'S1', px: 561.2, qty: 203, at: Date.now() } },
  }));
  at._loadState();
  const env = { TRADER_MANAGE_EXITS: process.env.TRADER_MANAGE_EXITS };
  process.env.TRADER_MANAGE_EXITS = '1';
  try {
    const bridge = {   // deliberately NO getIBKROrderStatus
      getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
      getIBKRPositions: async () => [{ symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500 }],
      getIBKROpenOrders: async () => [],
      getIBKRDayPnl: async () => 0,
    };
    await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    const out = await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    assert.ok(out, 'no throw with the method absent');
    const rows = fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const e = rows.find((r) => r.event === 'exit' && r.symbol === 'SMH');
    assert.ok(e, 'the reconstruction path still books');
    assert.match(e.reason, /closed_externally/);
    assert.strictEqual(e.stop_order_status, 'unavailable', 'the unanswerable lookup is recorded, not crashed on');
  } finally {
    if (env.TRADER_MANAGE_EXITS == null) delete process.env.TRADER_MANAGE_EXITS; else process.env.TRADER_MANAGE_EXITS = env.TRADER_MANAGE_EXITS;
  }
});
