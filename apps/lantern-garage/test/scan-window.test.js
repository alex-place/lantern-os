'use strict';
/**
 * scan-window.test.js — a scan pass that crosses the bell opens nothing (2026-10-02).
 *
 * Stable's tick began at 15:59:5x (regular session), its scan finished after the bell, and the brain ran at 16:00:23
 * still marked regular-session: the 15:00-16:00 entry block had ended, the 16:00 cadence window had opened, and it
 * bought 1,143 TLT ten minutes after the weekend flat. lib/scan-window.js re-reads the window per pass; both callers
 * (the server's scan loop and the engine runner) use it. Pinned here: the decision table, that both call sites hand the
 * brain the re-read window (not the one the tick started with), and that a protective pass places no entry where a
 * regular one does.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { passWindow } = require('../lib/scan-window');

test('the decision table: only a pass that crossed the bell changes, and it opens nothing', () => {
  // the 2026-10-02 case: started 15:59:5x in session, reached the brain at 16:00:23
  assert.deepStrictEqual(passWindow({ startedInSession: true, inSessionNow: false }), { extended: true, protectiveOnly: true, afterBell: true });
  // ... unless the operator's full extended trading is on: then its own rules apply
  assert.deepStrictEqual(passWindow({ startedInSession: true, inSessionNow: false, extNow: true }), { extended: true, protectiveOnly: false, afterBell: true });
  // a regular pass inside the session is untouched
  assert.deepStrictEqual(passWindow({ startedInSession: true, inSessionNow: true }), { extended: false, protectiveOnly: false, afterBell: false });
  // the protective extended window (pre-market / after-hours) keeps its own flags, even if 09:30 arrives mid-pass
  assert.deepStrictEqual(passWindow({ startedInSession: false, inSessionNow: false, extManageNow: true }), { extended: true, protectiveOnly: true, afterBell: false });
  assert.deepStrictEqual(passWindow({ startedInSession: false, inSessionNow: true, extManageNow: true }), { extended: true, protectiveOnly: true, afterBell: false });
  // full extended trading outside the session: extended, entries allowed, as before
  assert.deepStrictEqual(passWindow({ startedInSession: false, inSessionNow: false, extNow: true }), { extended: true, protectiveOnly: false, afterBell: false });
});

test('both callers hand the brain the RE-READ window, not the one the tick started with', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading.js'), 'utf8');
  assert.match(route, /require\('\.\.\/lib\/scan-window'\)/);
  assert.match(route, /passWindow\(\{ startedInSession: marketHours, inSessionNow: _isUsMarketHours\(\), extNow, extManageNow \}\)/);
  assert.match(route, /runAutoTrade\(userScan, \{[^}]*extended: _win\.extended[^}]*protectiveOnly: _win\.protectiveOnly \}\)/);
  assert.doesNotMatch(route, /runAutoTrade\(userScan, \{[^}]*extended: !marketHours/, 'the stale tick-start window must not reach the brain');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'two-sleeve-runner.js'), 'utf8');
  assert.match(runner, /passWindow\(\{ startedInSession: mh, inSessionNow: marketHours\(nowMs\(\)\), extManageNow: protectiveOnly \}\)/);
  assert.match(runner, /engine\.tick\([^;]*extended: win\.extended, protectiveOnly: win\.protectiveOnly/);
});

test('the brain: a protective pass places no entry where a regular pass does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-window-'));
  process.env.TRADER_TRADES_LOG = path.join(dir, 'trades.jsonl');
  process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
  process.env.TRADER_AUTO_EXECUTE = '1';
  process.env.TRADER_REQUIRE_PERSIST = '0';
  process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
  process.env.TRADER_SUP_ENTRY = '0';
  process.env.TRADER_STRESS_MULT = '1';
  delete process.env.TRADER_MANAGE_EXITS;
  const at = require('../lib/auto-trader');
  const placed = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    placeIBKROrder: async (_uid, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; },
  };
  const signal = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, convergence: { decision: 'ENTER', p_win: 0.8 } };
  const now = 1_700_000_000_000;
  at._resetCooldowns();
  const win = passWindow({ startedInSession: true, inSessionNow: false });
  await at.runAutoTrade({ signals: [signal] }, { bridge, userId: 'u', now, extended: win.extended, protectiveOnly: win.protectiveOnly });
  assert.strictEqual(placed.filter((o) => o.side === 'buy').length, 0, 'a pass that crossed the bell must not buy');
  at._resetCooldowns();
  await at.runAutoTrade({ signals: [signal] }, { bridge, userId: 'u', now: now + 120_000 });
  assert.ok(placed.some((o) => o.side === 'buy' && o.ticker === 'QQQ'), 'the same signal in a regular pass does buy (the fixture is live)');
});
