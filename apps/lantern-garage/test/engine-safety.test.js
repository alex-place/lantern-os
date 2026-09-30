'use strict';
/**
 * test/engine-safety.test.js: ADR-0035 step 1, the engine fixes from the 2026-09-29
 * autotrader review.
 *
 *   H1  A stop is never cancelled ahead of an order that cannot go out (a halt file, a
 *       dry account, an unknown mode). Each pass asks the broker leg first and, on "no",
 *       changes no stop and fires no exit.
 *   H3  A failed positions read is UNKNOWN (null, or a rejected read), never an empty
 *       book. Entries also wait while a read that succeeded comes back short of the
 *       account's last trusted book with nothing on record to explain it.
 *   M1  One pass per account at a time, and the journal's user tag rides the pass's
 *       async context, so interleaved passes cannot swap it.
 * H2 (the extended-hours deferral) is pinned in defer-ext-exit.test.js.
 *
 * Run: node --test test/engine-safety.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-safety-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
// hermetic exit authority, as in the other engine suites (#3459)
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');
const guard = require('../lib/trading-guard');

const T0 = 1_700_000_000_000;
const rows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG)
  ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearLog = () => { if (fs.existsSync(process.env.TRADER_TRADES_LOG)) fs.unlinkSync(process.env.TRADER_TRADES_LOG); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

// One SOXL long at -15% (past the default 8% backstop) behind a working 100-share stop.
function book({ preflight, positions } = {}) {
  const calls = { cancels: [], orders: [] };
  const stops = [{ orderId: 'S1', symbol: 'SOXL', side: 'sell', orderType: 'STP', type: 'stop', status: 'Submitted', qty: 100, stopPrice: 80 }];
  const b = {
    calls,
    getIBKRAccount: async () => ({ account_id: 'DU-SAFE', equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions || [{ symbol: 'SOXL', qty: 100, avg_entry_price: 100, current_price: 85, market_value: 8500 }],
    getIBKROpenOrders: async () => stops.map((o) => ({ ...o })),
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async (uid, id) => {
      calls.cancels.push(id);
      const o = stops.find((x) => x.orderId === id);
      if (o) o.status = 'Cancelled';
      return { ok: true };
    },
    placeIBKROrder: async (uid, o) => { calls.orders.push(o); return { status: 'placed', order_id: 'O' + calls.orders.length }; },
  };
  if (preflight) b.sellPreflight = async () => preflight();
  return b;
}
const marketSells = (b) => b.calls.orders.filter((o) => o.side === 'sell' && o.type === 'market');
const HALT = { allowed: false, reason: 'global halt engaged (data/kalshi/TRADING-PAUSED) — all live trading stopped' };

// ── H1 ──────────────────────────────────────────────────────────────────────────────
test('H1: while orders cannot go out, a pass cancels no stop and fires no exit; once they can, the exit runs', async () => {
  at._resetCooldowns(); clearLog();
  let allowed = false;
  const b = book({ preflight: () => (allowed ? { allowed: true, reason: 'armed on paper account' } : HALT) });
  const pass = (now) => at.runAutoTrade({ signals: [] }, { bridge: b, userId: 'u-halt', accountId: 'DU-SAFE', now });

  const out = await pass(T0);
  assert.deepStrictEqual(b.calls.cancels, [], 'the resting stop stays at the broker');
  assert.deepStrictEqual(b.calls.orders, [], 'and no sell or replacement stop is attempted');
  assert.ok(out.skipped.some((s) => /exits held/.test(s.why)), 'the pass says why');
  await pass(T0 + 60e3);
  assert.strictEqual(rows().filter((r) => r.event === 'exits_held').length, 1, 'one journal row per change, not per pass');

  allowed = true;
  await pass(T0 + 120e3);
  assert.deepStrictEqual(b.calls.cancels, ['S1'], 'with orders flowing again the backstop cancels the stop');
  assert.strictEqual(marketSells(b).length, 1, 'and sells');
  assert.ok(rows().some((r) => r.event === 'exits_resumed'));
});

test('H1: the fast-exit tick holds the same way', async () => {
  at._resetCooldowns();
  const b = book({ preflight: () => HALT });
  const out = await at.fastExitTick({ bridge: b, userId: 'u-halt-fast', accountId: 'DU-SAFE-F', now: T0 });
  assert.deepStrictEqual(b.calls.cancels, []);
  assert.deepStrictEqual(b.calls.orders, []);
  assert.ok(out.skipped.some((s) => /exits held/.test(s.why)));
});

test('H1: closeLong leaves the position, its stop and its exit state untouched when blocked', async () => {
  at._resetCooldowns();
  const b = book({ preflight: () => ({ allowed: false, reason: 'TRADER_LIVE=0 — dry run (no real order placed)' }) });
  at._peak.set('SOXL', 120);
  const out = { skipped: [], executed: [] };
  const r = await at._closeLongForTest(b, 'u', 'SOXL', 100, { avg_entry_price: 100, current_price: 85 },
    'max_loss (−15.0% ≤ -8%)', out, T0, {});
  assert.strictEqual(r.status, 'held');
  assert.deepStrictEqual(b.calls.cancels, []);
  assert.deepStrictEqual(b.calls.orders, []);
  assert.strictEqual(at._peak.get('SOXL'), 120, 'the trail state survives for when orders resume');
  assert.ok(out.skipped.some((s) => /exit held/.test(s.why)));
});

test('H1: cancelRestingStops (also the manual sell path) asks the leg before it cancels', async () => {
  const held = book({ preflight: () => HALT });
  const r = await at.cancelRestingStops(held, 'u-manual', 'SOXL');
  assert.deepStrictEqual(held.calls.cancels, []);
  assert.match(String(r.held), /halt/);
  const open = book({ preflight: () => ({ allowed: true, reason: 'alpaca paper' }) });
  const r2 = await at.cancelRestingStops(open, 'u-manual', 'SOXL');
  assert.deepStrictEqual(open.calls.cancels, ['S1']);
  assert.deepStrictEqual(r2.cancelled, ['S1']);
});

test('H1: a bridge without a preflight still honours the process-wide halt', async (t) => {
  if (guard.haltFile()) return t.skip('this checkout carries its own halt file');
  const orig = guard.haltFile;
  guard.haltFile = () => 'TRADING-PAUSED';
  try {
    const b = book();
    const r = await at.cancelRestingStops(b, 'u-fallback', 'SOXL');
    assert.deepStrictEqual(b.calls.cancels, []);
    assert.match(String(r.held), /halt/);
  } finally { guard.haltFile = orig; }
  const b2 = book();
  await at.cancelRestingStops(b2, 'u-fallback', 'SOXL');
  assert.deepStrictEqual(b2.calls.cancels, ['S1'], 'with the halt lifted the same call cancels');
});

test('H1, IBKR leg: the preflight mirrors the guard for the account the sell would go to', async (t) => {
  const Bridge = require('../lib/trading-api-bridge');
  const br = new Bridge();
  let status = { connected: true, mode: 'paper', accountId: 'DU1' };
  br.ibkrForUser = () => ({ getStatus: async () => status });
  const saved = { ...process.env };
  try {
    delete process.env.TRADER_LIVE; delete process.env.TRADER_IBKR_ACCOUNT; delete process.env.IBKR_ACCOUNT_ID;
    assert.strictEqual((await br.sellPreflight('u')).allowed, false, 'dry (TRADER_LIVE unset): a sell cannot go out');
    process.env.TRADER_LIVE = '1';
    if (guard.haltFile()) return t.skip('this checkout carries its own halt file');
    assert.strictEqual((await br.sellPreflight('u')).allowed, true, 'an armed paper account');
    status = { connected: true, mode: 'unknown', accountId: 'DU1' };
    assert.strictEqual((await br.sellPreflight('u')).allowed, false, 'an unknown account mode');
    status = { connected: false };
    assert.strictEqual((await br.sellPreflight('u')).allowed, false, 'a disconnected gateway');
    status = { connected: true, mode: 'paper', accountId: 'DU2' };
    process.env.TRADER_IBKR_ACCOUNT = 'DU1';
    assert.strictEqual((await br.sellPreflight('u')).allowed, false, 'an account other than the pinned one');
    br.ibkrForUser = () => null;
    assert.strictEqual((await br.sellPreflight('u')).allowed, false, 'no IBKR connection for the user');
  } finally { process.env = saved; }
});

test('H1, Alpaca leg: paper sells go out without the guard; a live sell needs its opt-in and the guard', () => {
  const alpaca = require('../lib/alpaca-adapter');
  const saved = { ...process.env };
  try {
    process.env.CHAMPION_ALPACA_API_KEY_ID = 'k.id';
    process.env.CHAMPION_ALPACA_API_SECRET_KEY = 's.v';
    process.env.CHAMPION_ALPACA_ENV = 'paper';
    delete process.env.TRADER_LIVE; delete process.env.TRADER_ALLOW_LIVE_ACCOUNT;
    assert.strictEqual(alpaca.sellPreflight(alpaca.CHAMPION_USER).allowed, true, 'paper');
    process.env.CHAMPION_ALPACA_ENV = 'live';
    assert.strictEqual(alpaca.sellPreflight(alpaca.CHAMPION_USER).allowed, false, 'live without its opt-in');
    process.env.TRADER_ALLOW_LIVE_ACCOUNT = '1';
    assert.strictEqual(alpaca.sellPreflight(alpaca.CHAMPION_USER).allowed, false, 'live and opted in, but the guard is dry');
    assert.strictEqual(alpaca.sellPreflight('nobody-' + Date.now()).allowed, false, 'no Alpaca account at all');
  } finally { process.env = saved; }
});

// ── H3 ──────────────────────────────────────────────────────────────────────────────
test('H3, IBKR client: a failed page makes the whole read unknown (null), not the rows before it', async () => {
  const IbkrCpapi = require('../lib/ibkr-cpapi');
  const c = new IbkrCpapi({ gatewayUrl: 'https://127.0.0.1:1/v1/api', accountId: 'DU1', timeoutMs: 100 });
  const page0 = Array.from({ length: 30 }, (_, i) => ({ ticker: 'S' + i, position: 1, conid: i }));
  const first = (p) => /positions\/0$/.test(p);
  c._request = async (m, p) => (first(p) ? { ok: true, json: page0 } : { ok: false, status: 500, json: null });
  assert.strictEqual(await c.getPositions('DU1'), null, 'page 1 failed: the book is unknown, not 30 rows long');
  c._request = async (m, p) => (first(p) ? { ok: true, json: page0.slice(0, 3) } : { ok: false });
  assert.strictEqual((await c.getPositions('DU1')).length, 3, 'a short page is still the last page');
  c._request = async (m, p) => (first(p) ? { ok: true, json: page0 } : { ok: true, json: [] });
  assert.strictEqual((await c.getPositions('DU1')).length, 30, 'an empty page is the end, not a failure');
});

test('H3, IBKR bridge: a failed read rejects instead of resolving to []', async () => {
  const Bridge = require('../lib/trading-api-bridge');
  const br = new Bridge();
  br._clientFor = () => ({ getStatus: async () => ({ connected: true, accountId: 'DU1' }), getPositions: async () => null });
  await assert.rejects(br.getIBKRPositions('u-read-fail-' + Date.now()), /unknown, not flat/);
});

test('H3: entries wait while the book reads short of its last trusted read, per account and bounded', async () => {
  at._resetCooldowns(); clearLog();
  const saved = { ...process.env };
  Object.assign(process.env, {
    TRADER_REQUIRE_PERSIST: '0', TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_LOG_SKIPS: '0',
    TRADER_MAX_CONCURRENT: '0', TRADER_FLAT_CONFIRM_SEC: '600',
  });
  const pos = (sym) => ({ symbol: sym, qty: 50, avg_entry_price: 100, current_price: 100, market_value: 5000 });
  const gld = { symbol: 'GLD', direction: 'BULLISH', entry_price: 100, atr: 1,
    zones: [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }],
    convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 } };
  const buysOf = (b) => b.calls.orders.filter((o) => /buy/i.test(o.side));
  try {
    let held = [pos('SPY'), pos('QQQ'), pos('IWM')];
    const b = book({ positions: null });
    b.getIBKRPositions = async () => held;
    b.getIBKROpenOrders = async () => [];
    await at.runAutoTrade({ signals: [] }, { bridge: b, userId: 'u-book', now: T0 });

    held = [];   // the same account now reads EMPTY, and nothing explains it
    const out = await at.runAutoTrade({ signals: [gld] }, { bridge: b, userId: 'u-book', now: T0 + 60e3 });
    assert.strictEqual(buysOf(b).length, 0, 'no entry into what may be a dropout');
    assert.ok(out.skipped.some((s) => /entries wait/.test(s.why)), 'the skip names the reason');
    assert.strictEqual(rows().filter((r) => r.event === 'entries_held').length, 1);

    // (A different symbol: the re-entry cooldown is still keyed by symbol across every
    // account, review H6, which ADR-0035 step 2 re-keys. It is not what this checks.)
    const other = book({ positions: [] });
    other.getIBKROpenOrders = async () => [];
    await at.runAutoTrade({ signals: [{ ...gld, symbol: 'SLV' }] }, { bridge: other, userId: 'u-other', now: T0 + 61e3 });
    assert.strictEqual(buysOf(other).length, 1, "another account is not held back by this one's book");

    await at.runAutoTrade({ signals: [gld] }, { bridge: b, userId: 'u-book', now: T0 + 60e3 + 601e3 });
    assert.strictEqual(buysOf(b).length, 1, 'past the window the empty reading is accepted');
  } finally { process.env = saved; }
});

// ── M1 ──────────────────────────────────────────────────────────────────────────────
test('M1: a fast tick skips its turn while a scan pass is on the same account', async () => {
  at._resetCooldowns();
  const go = deferred();
  let fastReads = 0;
  const scanBridge = book();
  scanBridge.getIBKRAccount = async () => { await go.promise; return { equity: 100000, mode: 'paper' }; };
  const fastBridge = book({ positions: [] });
  fastBridge.getIBKRPositions = async () => { fastReads += 1; return []; };

  const scan = at.runAutoTrade({ signals: [] }, { bridge: scanBridge, userId: 'u-m1', accountId: 'ACC-M1', now: T0 });
  await tick();
  const skipped = await at.fastExitTick({ bridge: fastBridge, userId: 'u-m1', accountId: 'ACC-M1' });
  assert.match(String(skipped.reason), /another pass is running/);
  assert.strictEqual(fastReads, 0, 'the skipped tick never touched the broker');
  go.resolve();
  await scan;
  const ran = await at.fastExitTick({ bridge: fastBridge, userId: 'u-m1', accountId: 'ACC-M1' });
  assert.strictEqual(fastReads, 1, 'with the account free the tick runs');
  assert.ok(!/another pass/.test(String(ran.reason || '')));
});

test('M1: a scan waits for a fast tick already on its account, then runs', async () => {
  at._resetCooldowns();
  const order = [];
  const go = deferred();
  const fastBridge = book();
  fastBridge.getIBKRPositions = async () => { order.push('fast:start'); await go.promise; order.push('fast:end'); return []; };
  const scanBridge = book();
  scanBridge.getIBKRAccount = async () => { order.push('scan:start'); return { equity: 100000, mode: 'paper' }; };

  const fast = at.fastExitTick({ bridge: fastBridge, userId: 'u-m1b', accountId: 'ACC-M1B' });
  await tick();
  const scan = at.runAutoTrade({ signals: [] }, { bridge: scanBridge, userId: 'u-m1b', accountId: 'ACC-M1B', now: T0 });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepStrictEqual(order, ['fast:start'], 'the scan has not touched the broker while the tick is on the account');
  go.resolve();
  await fast; await scan;
  assert.deepStrictEqual(order.slice(0, 3), ['fast:start', 'fast:end', 'scan:start']);
});

test('M1: interleaved passes on two accounts each journal under their own user', async () => {
  at._resetCooldowns(); clearLog();
  const held = [{ symbol: 'SOXL', qty: 10, avg_entry_price: 100, current_price: 100, market_value: 1000 }];
  const a = deferred(), b = deferred();
  const alice = book({ preflight: () => HALT });
  alice.getIBKRPositions = async () => { await a.promise; return held; };
  const bob = book({ preflight: () => HALT });
  bob.getIBKRPositions = async () => { await b.promise; return held; };

  const pa = at.fastExitTick({ bridge: alice, userId: 'alice', accountId: 'ACC-A' });
  const pb = at.fastExitTick({ bridge: bob, userId: 'bob', accountId: 'ACC-B' });
  await tick();
  a.resolve(); await pa;   // alice finishes while bob's pass is still open
  b.resolve(); await pb;
  const tags = rows().filter((r) => r.event === 'exits_held').map((r) => r.user).sort();
  assert.deepStrictEqual(tags, ['alice', 'bob'], 'a module scalar tagged these bob and (nobody)');
});
