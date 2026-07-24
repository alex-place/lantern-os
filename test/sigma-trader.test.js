'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cb = require('../lib/sigma-trader');

test('solve: solves a small linear system', () => {
  const x = cb.solve([[2, 1], [1, 3]], [3, 5]);   // x=0.8, y=1.4
  assert.ok(Math.abs(x[0] - 0.8) < 1e-9 && Math.abs(x[1] - 1.4) < 1e-9);
  assert.strictEqual(cb.solve([[0, 0], [0, 0]], [1, 1]), null);   // singular → null
});

test('tangencyDir: long-only weights that sum to 1 and respect the per-asset cap', () => {
  const mu = [0.02, 0.015, 0.01];
  const cov = [[0.04, 0.01, 0.005], [0.01, 0.05, 0.008], [0.005, 0.008, 0.03]];
  const w = cb.tangencyDir(mu, cov, { cap: 0.5 });
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'sums to 1');
  assert.ok(w.every((x) => x >= 0), 'no shorts');
  assert.ok(w.every((x) => x <= 0.5 + 1e-9), 'respects cap');
});

test('tangencyDir: the cap actually binds when one asset dominates', () => {
  const mu = [0.10, 0.001, 0.001];   // asset 0 hugely favored
  const cov = [[0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.02]];
  const w = cb.tangencyDir(mu, cov, { cap: 0.4 });
  assert.ok(w[0] <= 0.4 + 1e-9, 'dominant asset capped at 0.4');
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('targetWeights: drops assets without enough history, weights the rest', () => {
  // SPY/TLT have history; GLD too short → dropped.
  const closes = (n, drift) => Array.from({ length: n }, (_, i) => 100 * Math.pow(1 + drift, i));
  const out = cb.targetWeights({ SPY: closes(200, 0.001), TLT: closes(200, 0.0005), GLD: closes(10, 0.002) });
  assert.ok(out.used.includes('SPY') && out.used.includes('TLT'));
  assert.ok(out.dropped.includes('GLD'));
  assert.ok(Math.abs(Object.values(out.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test('computeRebalance: gross scales targets; no-churn band suppresses tiny drifts', () => {
  const r = cb.computeRebalance({
    equity: 100000, gross: 1.5,
    weights: { SPY: 0.5, TLT: 0.5 },
    prices: { SPY: 100, TLT: 100 },
    positions: [{ symbol: 'SPY', market_value: 74000 }],   // target 75k → 1k drift
    bandPct: 0.6,                                           // band = $600 → 1k trades
  });
  // SPY target = 100000 * 1.5 * 0.5 = 75,000; drift +1,000 > $600 band → buy
  const spy = r.orders.find((o) => o.symbol === 'SPY');
  assert.ok(spy && spy.side === 'buy' && spy.notional === 1000);
  // TLT target 75,000, held 0 → buy the full leg
  assert.ok(r.orders.find((o) => o.symbol === 'TLT' && o.side === 'buy'));
  assert.strictEqual(r.grossUsed, 1.5);
});

test('computeRebalance: within-band drift is left alone; excluded holdings are sold', () => {
  const r = cb.computeRebalance({
    equity: 100000, gross: 1,
    weights: { SPY: 1.0 },                                  // TLT no longer in the book → sell it
    prices: { SPY: 100, TLT: 50 },
    positions: [{ symbol: 'SPY', market_value: 99800 }, { symbol: 'TLT', market_value: 5000 }],
    bandPct: 0.6,                                           // band $600
  });
  assert.ok(!r.orders.find((o) => o.symbol === 'SPY'), 'SPY within band → no trade');
  const tlt = r.orders.find((o) => o.symbol === 'TLT');
  assert.ok(tlt && tlt.side === 'sell' && tlt.notional === 5000, 'excluded TLT fully sold');
});

test('computeRebalance: gross clamps to [0, MAX_GROSS]; sells ordered before buys', () => {
  const r = cb.computeRebalance({ equity: 100000, gross: 9, weights: { SPY: 1 }, prices: { SPY: 100 }, positions: [] });
  assert.strictEqual(r.grossUsed, cb.MAX_GROSS);   // 9 clamped to 2
  const r2 = cb.computeRebalance({
    equity: 100000, gross: 1, weights: { SPY: 0.5, TLT: 0.5 }, prices: { SPY: 100, TLT: 100 },
    positions: [{ symbol: 'TLT', market_value: 90000 }],   // TLT overweight → sell; SPY underweight → buy
  });
  assert.strictEqual(r2.orders[0].side, 'sell', 'sells first (frees buying power)');
});

// ── rebalanceNow gating (mock broker via require.cache) ──────────────────────
const path = require('path');
function loadChampionWith({ account, positions = [], placed }) {
  const A = require.resolve('../lib/alpaca-adapter');
  const Y = require.resolve('../lib/market-data-yahoo');
  const B = require.resolve('../lib/brake-monitor');
  const C = require.resolve('../lib/sigma-trader');
  const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub(A, {
    SIGMA_USER: 'sigma-trader', getAccount: async () => account,
    getPositions: async () => ({ positions }),
    getOpenOrders: async () => [],
    cancelOpenOrders: async () => 0,
    placeOrder: async (uid, o) => { placed.push(o); return { status: 'placed', order_id: 'x' + placed.length }; },
  });
  stub(Y, { getBarsMulti: async () => ({ bars: Object.fromEntries(['SPY','QQQ','IWM','EFA','TLT','GLD','XMMO','SPMO'].map((s, k) => [s, { bars: Array.from({ length: 80 }, (_, i) => ({ close: 100 + k + i * 0.1 })) }])) }) });
  stub(B, { getStatus: () => ({ grossTarget: 1.0 }) });
  delete require.cache[C];
  return require(C);
}

test('rebalanceNow: DRY by default — computes but places NOTHING', async () => {
  const placed = [];
  const cbm = loadChampionWith({ account: { equity: 100000, env: 'paper', account_id: 'SIGMA-PAPER' }, positions: [], placed });
  const saved = process.env.SIGMA_ARM; process.env.SIGMA_ARM = '1';   // even with env armed…
  try {
    const r = await cbm.rebalanceNow({ arm: false });                  // …arm:false stays dry
    assert.strictEqual(r.executed, false);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(placed.length, 0, 'placed nothing while dry');
  } finally { if (saved === undefined) delete process.env.SIGMA_ARM; else process.env.SIGMA_ARM = saved; }
});

test('rebalanceNow: requires BOTH arm:true AND SIGMA_ARM=1 to trade', async () => {
  const placed = [];
  const cbm = loadChampionWith({ account: { equity: 100000, env: 'paper', account_id: 'SIGMA-PAPER' }, positions: [], placed });
  const saved = process.env.SIGMA_ARM; delete process.env.SIGMA_ARM;   // env NOT armed
  try {
    const r = await cbm.rebalanceNow({ arm: true });                    // arm:true alone is not enough
    assert.strictEqual(r.executed, false);
    assert.strictEqual(placed.length, 0);
  } finally { if (saved === undefined) delete process.env.SIGMA_ARM; else process.env.SIGMA_ARM = saved; }
});

test('rebalanceNow: armed on PAPER places orders; REFUSES a live account', async () => {
  const saved = process.env.SIGMA_ARM; process.env.SIGMA_ARM = '1';
  try {
    const placedP = [];
    const paper = loadChampionWith({ account: { equity: 100000, env: 'paper', account_id: 'SIGMA-PAPER' }, positions: [], placed: placedP });
    const rp = await paper.rebalanceNow({ arm: true });
    assert.strictEqual(rp.executed, true);
    assert.ok(placedP.length > 0, 'armed paper placed orders');

    const placedL = [];
    const live = loadChampionWith({ account: { equity: 100000, env: 'live', account_id: 'SIGMA-LIVE' }, positions: [], placed: placedL });
    const rl = await live.rebalanceNow({ arm: true });
    assert.strictEqual(rl.executed, false);
    assert.strictEqual(rl.refused, 'live_account_forbidden');
    assert.strictEqual(placedL.length, 0, 'never places on a live account');
  } finally { if (saved === undefined) delete process.env.SIGMA_ARM; else process.env.SIGMA_ARM = saved; }
});

test('rebalanceNow: NO dedicated account → refuses, places nothing (never touches the day-trader)', async () => {
  const placed = [];
  // getAccount → null models "no Sigma account configured".
  const sig = loadChampionWith({ account: null, positions: [], placed });
  const saved = process.env.SIGMA_ARM; process.env.SIGMA_ARM = '1';
  try {
    const plan = await sig.plan();
    assert.strictEqual(plan.account, 'not_configured');
    assert.ok(Array.isArray(plan.weights ? Object.keys(plan.weights) : []), 'still computes target weights');
    const r = await sig.rebalanceNow({ arm: true });        // armed, but no account
    assert.strictEqual(r.executed, false);
    assert.strictEqual(r.refused, 'no_dedicated_account');
    assert.strictEqual(placed.length, 0, 'never places without its own account');
  } finally { if (saved === undefined) delete process.env.SIGMA_ARM; else process.env.SIGMA_ARM = saved; }
});
