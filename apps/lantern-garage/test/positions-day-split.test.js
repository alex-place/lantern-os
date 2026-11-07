'use strict';
/**
 * positions-day-split.test.js — /api/trading/positions carries the banked / marks / after-hours split
 * (lib/day-pnl-split) beside the Day P&L, for the account the server's journals describe and nobody else.
 *
 * Drives the REAL route, the REAL lib/day-pnl and the REAL split over real files, on Wednesday 2026-11-04
 * at 20:00 ET. The broker collaborators are stubbed through the require cache.
 * Run: node --test apps/lantern-garage/test/positions-day-split.test.js
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const ROUTE = require.resolve(path.join(__dirname, '..', 'routes', 'trading', 'market.js'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-split-'));
const NOW = Date.parse('2026-11-05T01:00:00Z');   // Wednesday 20:00 ET
const PREV = 98996.84;

const file = (n) => path.join(DIR, n);
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const exit = (symbol, pnl, ts) => ({ ts, event: 'exit', symbol, qty: 10, entry: 100, exit: 100 + pnl / 10, pnl, order_id: symbol + ts });
function writeJournals() {
  fs.writeFileSync(file('autopilot-trades.jsonl'), jsonl([{ ts: '2026-09-01T14:00:00Z', event: 'noop' }]));
  fs.writeFileSync(file('M.autopilot-trades.jsonl'), jsonl([exit('UPRO', -608, '2026-11-04T16:00:00Z')]));
  fs.writeFileSync(file('C.autopilot-trades.jsonl'), jsonl([exit('TNA', 315, '2026-11-04T20:50:00Z')]));
  fs.writeFileSync(file('O.autopilot-trades.jsonl'), jsonl([exit('SPY', 139, '2026-11-04T14:40:00Z')]));
}
writeJournals();

const prevEnv = { log: process.env.TRADER_TRADES_LOG, extra: process.env.TRADER_TRADES_LOG_EXTRA, bars: process.env.TRADER_BARS_DIR, uid: process.env.TRADER_OPERATOR_UID };
process.env.TRADER_TRADES_LOG = file('autopilot-trades.jsonl');
process.env.TRADER_TRADES_LOG_EXTRA = ['M', 'C', 'O'].map((n) => file(n + '.autopilot-trades.jsonl')).join(';');
process.env.TRADER_BARS_DIR = DIR;
delete process.env.TRADER_OPERATOR_UID;

const stubbed = [];
function stub(name, exportsObj) {
  const f = require.resolve(path.join(LIB, name));
  require.cache[f] = { id: f, filename: f, loaded: true, exports: exportsObj };
  stubbed.push(f);
}
let broker = 'alpaca';
let authSource = 'server-keys';
let historyCalls = 0;
stub('alpaca-adapter', {
  _authFor: () => { if (authSource === 'throw') throw new Error('credential store down'); return authSource ? { source: authSource } : null; },
  getAccount: async () => ({ account_id: 'PA-TEST', equity: PREV - 329, cash: 40000, pnl_today: -329, realized_today: 0, last_equity: PREV, balance_asof: '2026-11-03', source: 'alpaca' }),
  getPositions: async () => ({ positions: [{ symbol: 'SMH', qty: 15, side: 'long', avg_entry_price: 500, current_price: 499.48, market_value: 7492.2, unrealized_pl: -7.8 }] }),
  getPortfolioHistory: async () => { historyCalls++; return { ok: true, timestamps: [Date.parse('2026-11-04T21:00:00Z') / 1000], equity: [PREV - 33] }; },
});
stub('broker-facade', { preferredBroker: () => broker });
let admin = false;
stub('auth-middleware', { isAdmin: () => admin });
stub('market-data-yahoo', { getQuotes: async (syms) => (syms || []).map((t) => ({ ticker: t, price: 500, chg_pct: 0 })) });
const realDateNow = Date.now;
Date.now = () => NOW;
const marketRoutes = require(ROUTE);

after(() => {
  Date.now = realDateNow;
  for (const f of stubbed.concat([ROUTE])) delete require.cache[f];
  for (const [k, v] of [['TRADER_TRADES_LOG', prevEnv.log], ['TRADER_TRADES_LOG_EXTRA', prevEnv.extra], ['TRADER_BARS_DIR', prevEnv.bars], ['TRADER_OPERATOR_UID', prevEnv.uid]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => { broker = 'alpaca'; authSource = 'server-keys'; admin = false; writeJournals(); });

async function hit(uid = 'local-owner', bridge = {}) {
  let out = {};
  const ctx = {
    deps: {}, traderAgent: null, getPriceFeed: () => null, tradingMemory: null, bridge,
    getEffectiveUserId: () => uid,
    sendJson: (res, body, code) => { out = { body, code }; },
  };
  await marketRoutes({ method: 'GET', headers: {} }, {}, new URL('http://x/api/trading/positions'), ctx);
  return out;
}

test('the account behind the server\'s keys: the split rides beside the figure, which stays the equity change', async () => {
  const r = await hit();
  assert.strictEqual(r.code, 200);
  const a = r.body.account;
  assert.strictEqual(a.pnl_today, -329, 'the existing figure');
  assert.strictEqual(a.pnl_today_source, 'broker_equity');
  const s = a.day_split;
  assert.strictEqual(s.session_date, '2026-11-04', 'from balance_asof');
  assert.deepStrictEqual(s.realized.journals.filter((j) => j.exits).map((j) => [j.name, j.pnl]), [['M', -608], ['C', 315], ['O', 139]]);
  assert.strictEqual(s.realized.total, -154);
  assert.strictEqual(s.marks, 121);
  assert.strictEqual(s.after_hours, -296);
  assert.strictEqual(s.realized.total + s.marks + s.after_hours, a.pnl_today);
  assert.strictEqual(s.day_pnl, a.pnl_today);
  assert.ok(historyCalls >= 1, 'the close comes from the broker curve');
  assert.ok(!JSON.stringify(s).includes(DIR.split(path.sep).pop()), 'no server path in the payload');
});

test('a missing sleeve journal: the figure stands, the split says unknown', async () => {
  fs.unlinkSync(file('M.autopilot-trades.jsonl'));
  const a = (await hit()).body.account;
  assert.strictEqual(a.pnl_today, -329);
  assert.strictEqual(a.day_split.realized.total, null);
  assert.strictEqual(a.day_split.realized.journals.find((j) => j.name === 'M').pnl, null);
  assert.strictEqual(a.day_split.marks, null);
  assert.strictEqual(a.day_split.after_hours, -296);
});

test('every ledger unreadable: the broker\'s figure stands and the split is still there, unknown', async () => {
  for (const n of ['autopilot-trades.jsonl', 'M.autopilot-trades.jsonl', 'C.autopilot-trades.jsonl', 'O.autopilot-trades.jsonl']) fs.unlinkSync(file(n));
  const r = await hit();
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.account.pnl_today, -329, "the adapter's equity change");
  assert.strictEqual(r.body.account.day_split.realized.total, null);
  assert.strictEqual(r.body.account.day_split.marks, null);
});

test('a user with their own broker gets no split: the server\'s sleeves are not theirs to see, and not their account', async () => {
  for (const source of ['user-keys', 'oauth']) {
    authSource = source;
    const r = await hit('profile-123');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.account.day_split, undefined, source);
  }
});

test('a failure in the split never costs the page its payload', async () => {
  authSource = 'throw';
  const r = await hit();
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.account.pnl_today, -329);
  assert.strictEqual(r.body.account.day_split, undefined);
});

const IBKR_BRIDGE = (equity = 965004.06) => ({
  getIBKRAccount: async () => ({ account_id: 'DUR193395', equity, cash: 850259.88, pnl_today: -174.07, mode: 'paper', source: 'ibkr' }),
  getIBKRPositions: async () => [{ symbol: 'DIA', qty: 157, current_price: 522.85, unrealized_pl: 7.85 }],
});
function writeIbkrLedger() {
  fs.writeFileSync(file('autopilot-trades.jsonl'), jsonl([
    { ts: '2026-11-03T21:00:46Z', event: 'session', date: '2026-11-03', equity: 963377 },
    exit('XLE', 500, '2026-11-04T15:00:00Z'),
    { ts: '2026-11-04T21:00:46Z', event: 'session', date: '2026-11-04', equity: 964000 },
  ]));
  fs.writeFileSync(file('M.autopilot-trades.jsonl'), jsonl([]));
  fs.writeFileSync(file('C.autopilot-trades.jsonl'), jsonl([]));
  fs.writeFileSync(file('O.autopilot-trades.jsonl'), jsonl([]));
}

test('IBKR: the owner gets the split from the trader\'s own session rows', async () => {
  broker = 'ibkr';
  writeIbkrLedger();
  const a = (await hit('local-owner', IBKR_BRIDGE())).body.account;
  assert.strictEqual(a.pnl_today, 1627.06);
  const s = a.day_split;
  assert.strictEqual(s.session_date, '2026-11-04');
  assert.strictEqual(s.realized.total, 500);
  assert.strictEqual(s.close_equity, 964000);
  assert.strictEqual(s.close_source, 'session row 16:00 ET');
  assert.strictEqual(s.after_hours, 1004.06);
  assert.strictEqual(s.marks, 123);
  assert.strictEqual(Math.round((s.realized.total + s.marks + s.after_hours) * 100) / 100, a.pnl_today);
});

test('IBKR: a reader who may not see the server\'s book gets no split', async () => {
  broker = 'ibkr';
  writeIbkrLedger();
  const a = (await hit('profile-123', IBKR_BRIDGE())).body.account;
  assert.strictEqual(a.day_split, undefined);
  assert.strictEqual(a.pnl_today, 1627.06, 'the figure itself is unchanged');
});

test('IBKR with no previous close on record: banked stands, marks are unknown, the log\'s figure stays', async () => {
  broker = 'ibkr';
  writeIbkrLedger();
  fs.writeFileSync(file('autopilot-trades.jsonl'), jsonl([exit('XLE', 500, '2026-11-04T15:00:00Z')]));
  const a = (await hit('local-owner', IBKR_BRIDGE())).body.account;
  assert.notStrictEqual(a.pnl_today_source, 'broker_equity');
  assert.strictEqual(a.day_split.realized.total, 500);
  assert.strictEqual(a.day_split.marks, null);
  assert.strictEqual(a.day_split.day_pnl, null);
});

test('IBKR with every ledger gone: the fallback says it is the broker\'s figure, and the split is unknown', async () => {
  broker = 'ibkr';
  for (const n of ['autopilot-trades.jsonl', 'M.autopilot-trades.jsonl', 'C.autopilot-trades.jsonl', 'O.autopilot-trades.jsonl']) fs.unlinkSync(file(n));
  const a = (await hit('local-owner', IBKR_BRIDGE())).body.account;
  assert.strictEqual(a.pnl_today_source, 'broker_reset');
  assert.strictEqual(a.pnl_today, -174.07);
  assert.strictEqual(a.day_split.realized.total, null);
  assert.strictEqual(a.day_split.marks, null);
});
