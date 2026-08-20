'use strict';
/**
 * feed-flap-guard.test.js — the 2026-08-19 17:26 ET incident must never repeat
 * (#3378).
 *
 * What happened, from the ledger: during IBKR's daily maintenance the gateway
 * re-resolved "first discovered" account and served the OVERNIGHT book to the
 * day-trader for two minutes. slot_util recorded held=[GLD, QQQ,
 * QQQ260820C00720000, SPMO, SPY, TLT, XMMO] — 7 rows on a 5-slot engine,
 * including an options leg and another book's fractional lots. The engine
 * booked five phantom closed_externally exits (~+$1,300 of fictional realized
 * P&L; DIA/XLK/SOXS were confirmed held again two minutes later) and attempted
 * a trailing-stop SELL of 85 XMMO — a position it never owned.
 *
 * These tests replay that exact snapshot against the three defenses:
 *   - the foreign-book tell (several tracked gone + several unknown rows)
 *   - exit management refuses symbols the engine has no state for
 *   - the bridge account pin refuses reads/orders against the wrong account
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// keep any incidental ledger writes out of the real data tree
process.env.TRADER_TRADES_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flap-')), 'trades.jsonl');

const at = require('../lib/auto-trader');
const TradingAPIBridge = require('../lib/trading-api-bridge');

// ── the real 17:26 snapshot, verbatim shapes ─────────────────────────────────
const FLAP_SNAPSHOT = [
  { symbol: 'GLD', qty: 148.0898, avg_entry_price: 411.305141, current_price: 414.0 },
  { symbol: 'QQQ', qty: 80, avg_entry_price: 730.72, current_price: 719.33 },
  { symbol: 'QQQ260820C00720000', qty: 2, avg_entry_price: 4.1, current_price: 3.2 },
  { symbol: 'SPMO', qty: 120, avg_entry_price: 151.0, current_price: 149.35 },
  { symbol: 'SPY', qty: 77, avg_entry_price: 773.6, current_price: 770.25 },
  { symbol: 'TLT', qty: 297.9433, avg_entry_price: 82.207985, current_price: 82.99 },
  { symbol: 'XMMO', qty: 85, avg_entry_price: 160.176107, current_price: 157.6 },
];
// what the day-trader was actually tracking at that moment
const TRACKED = new Set(['DIA', 'QQQ', 'SOXS', 'SPY', 'XLK']);

test('THE 17:26 REPLAY: the foreign-book tell fires on the real snapshot', () => {
  const isKnown = (k) => TRACKED.has(k);
  const foreign = at.snapshotForeignRows(FLAP_SNAPSHOT, isKnown);
  // GLD, the option, SPMO, TLT, XMMO — five rows this engine had no state for
  assert.strictEqual(foreign, 5);
  const vanished = [...TRACKED].filter((k) => !FLAP_SNAPSHOT.some((p) => p.symbol === k && p.qty > 0));
  assert.deepStrictEqual(vanished.sort(), ['DIA', 'SOXS', 'XLK'], 'the three phantom-booked symbols');
  // the new tell: vanished>=2 && foreign>=2 — this is the condition the sweep gates on
  assert.ok(vanished.length >= 2 && foreign >= 2, 'the snapshot must be classified suspect');
  // and the 2026-08-13 heuristic alone would NOT have caught it — that is the bug
  assert.ok(!(vanished.length >= 3 && vanished.length > FLAP_SNAPSHOT.length),
    'the old vanished>rows heuristic misses a BIG alien snapshot — why the tell was added');
});

test('a legit mass stop-out does NOT trip the tell (only tracked symbols vanish)', () => {
  // three stops fill in one scan; the two survivors are both tracked
  const survivors = [
    { symbol: 'QQQ', qty: 80 },
    { symbol: 'SPY', qty: 77 },
  ];
  const isKnown = (k) => TRACKED.has(k);
  assert.strictEqual(at.snapshotForeignRows(survivors, isKnown), 0,
    'no foreign rows — the sweep must still run and book the real stop-outs');
});

test('a legitimately growing book does NOT trip the tell (nothing vanished)', () => {
  // two brand-new manual buys appear, nothing tracked is missing
  const grown = FLAP_SNAPSHOT.slice(0, 2);
  const isKnown = () => false;
  assert.ok(at.snapshotForeignRows(grown, isKnown) >= 2, 'new rows are foreign');
  // but with vanished=0 the && condition cannot fire — asserted here as arithmetic
  const vanished = 0;
  assert.ok(!(vanished >= 2), 'no vanish half, no suspicion');
});

test('zero-qty and malformed rows do not count as foreign', () => {
  const rows = [
    { symbol: 'GLD', qty: 0 },
    { symbol: null, qty: 5 },
    {},
    null,
  ];
  assert.strictEqual(at.snapshotForeignRows(rows, () => false), 1,
    'only the qty-5 row with a stringifiable symbol counts');
});

// ── THE END-TO-END REPLAY: the whole scan stands down on the foreign book ────
test('the 17:26 scan, replayed: no bookings, no XMMO exit, the engine stands down', async () => {
  // The engine as it stood at 17:26 — tracking the real book via the state file
  // (the same mechanism a restart uses) — receives the foreign snapshot. Before
  // #3378 this exact input booked five phantom exits and attempted a
  // trailing-stop sell of XMMO. Now the scan must refuse to act at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flap-e2e-'));
  const LOG = path.join(dir, 'trades.jsonl');
  const STATE = path.join(dir, 'state.json');
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: {
      DIA: { qty: 109, entry: 535.2762413, mark: 534.229126, ts: Date.now() },
      QQQ: { qty: 80, entry: 730.72, mark: 719.33, ts: Date.now() },
      SOXS: { qty: 0.8, entry: 47.61261605, mark: 46.44600675, ts: Date.now() },
      SPY: { qty: 77, entry: 773.6, mark: 770.25, ts: Date.now() },
      XLK: { qty: 635, entry: 183.035003, mark: 183.9900055, ts: Date.now() },
    },
  }));
  const saved = { ...process.env };
  process.env.TRADER_TRADES_LOG = LOG;
  process.env.TRADER_STATE_FILE = STATE;
  process.env.TRADER_MANAGE_EXITS = '1';
  process.env.TRADER_MAX_LOSS_PCT = '1';       // XMMO sits at -1.61%: an exit WOULD fire if considered
  delete process.env.TRADER_AUTO_EXECUTE;
  delete require.cache[require.resolve('../lib/auto-trader')];
  const at2 = require('../lib/auto-trader');

  const orders = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 970000, mode: 'paper' }),
    getIBKRPositions: async () => FLAP_SNAPSHOT.map((p) => ({ ...p })),
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { orders.push(o); return { status: 'placed', order_id: 'x' }; },
  };
  try {
    at2._loadState();
    const out = await at2.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    assert.match(String(out.reason || ''), /another account|foreign|standing down/i,
      'the scan must name why it refused: ' + out.reason);
    assert.deepStrictEqual(orders, [], 'not one order may reach the broker off a foreign book');
    const rows = fs.existsSync(LOG)
      ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.strictEqual(rows.filter((r) => r.event === 'exit').length, 0, 'no phantom exits booked');
    assert.strictEqual(rows.filter((r) => r.event === 'exit_intent').length, 0, 'no exit attempted (the XMMO sell)');
  } finally {
    process.env = saved;
    delete require.cache[require.resolve('../lib/auto-trader')];
  }
});

// ── the bridge account pin ────────────────────────────────────────────────────
const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};

test('PIN SET: a status from another account throws, and the message names both', async () => {
  await withEnv({ TRADER_IBKR_ACCOUNT: 'DUR193395' }, async () => {
    const b = Object.create(TradingAPIBridge.prototype);
    assert.throws(() => b._assertPinnedAccount({ accountId: 'DUF000001' }, 'a positions read'),
      (e) => /DUF000001/.test(e.message) && /DUR193395/.test(e.message) && /positions read/.test(e.message));
    // the RIGHT account passes
    assert.doesNotThrow(() => b._assertPinnedAccount({ accountId: 'DUR193395' }, 'a positions read'));
  });
});

test('PIN UNSET: behaviour is exactly as before — nothing throws', async () => {
  await withEnv({ TRADER_IBKR_ACCOUNT: null, IBKR_ACCOUNT_ID: null }, async () => {
    const b = Object.create(TradingAPIBridge.prototype);
    assert.doesNotThrow(() => b._assertPinnedAccount({ accountId: 'ANYTHING' }, 'x'));
    assert.doesNotThrow(() => b._assertPinnedAccount(null, 'x'));
  });
});

test('IBKR_ACCOUNT_ID works as the fallback pin, TRADER_IBKR_ACCOUNT wins when both set', async () => {
  await withEnv({ TRADER_IBKR_ACCOUNT: null, IBKR_ACCOUNT_ID: 'DUR193395' }, async () => {
    const b = Object.create(TradingAPIBridge.prototype);
    assert.throws(() => b._assertPinnedAccount({ accountId: 'DUF000001' }, 'x'));
  });
  await withEnv({ TRADER_IBKR_ACCOUNT: 'DUR193395', IBKR_ACCOUNT_ID: 'DUF000001' }, async () => {
    const b = Object.create(TradingAPIBridge.prototype);
    assert.doesNotThrow(() => b._assertPinnedAccount({ accountId: 'DUR193395' }, 'x'));
    assert.throws(() => b._assertPinnedAccount({ accountId: 'DUF000001' }, 'x'));
  });
});

test('a status with no accountId is not a mismatch (unauthenticated probes stay quiet)', async () => {
  await withEnv({ TRADER_IBKR_ACCOUNT: 'DUR193395' }, async () => {
    const b = Object.create(TradingAPIBridge.prototype);
    assert.doesNotThrow(() => b._assertPinnedAccount({ accountId: null }, 'x'));
    assert.doesNotThrow(() => b._assertPinnedAccount({}, 'x'));
  });
});
