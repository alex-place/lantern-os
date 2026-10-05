'use strict';
/**
 * no-friday-entries.test.js — TRADER_NO_FRIDAY_ENTRIES (2026-10-05, the gate audit).
 *
 * The weekend flat (TRADER_EOD_FLAT=weekend) sells every long at Friday 15:50, so a dip bought on a Friday has hours, not
 * sessions, to bounce; on the stable box those entries lost on both replay surfaces. TRADER_NO_FRIDAY_ENTRIES=1 skips NEW
 * entries on an ET Friday. Pinned here, on a hermetic brain (stubbed market data, a mock broker):
 *   - the pure read: off by default; on = an ET Friday only (a UTC Saturday that is still Friday evening in New York
 *     counts, an ET Saturday does not); any value but '1' is off;
 *   - on, Friday: a BULLISH signal places no order and the skip says no_friday_entries;
 *   - on, Thursday: the same signal buys;
 *   - off, Friday: the same signal buys (the default is unchanged);
 *   - on, Friday: a held long is still sold on its signal (exits are untouched).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nofri-'));
const LOG = path.join(DIR, 'trades.jsonl');
Object.assign(process.env, {
  TRADER_TRADES_LOG: LOG, TRADER_STATE_FILE: path.join(DIR, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
  TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
  // the exit-authority switches pinned, so no market-data-driven exit can act on the held fixture
  TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
  TRADER_EOD_FLAT: 'off', TRADER_IBS_EXIT: '0', TRADER_MIN_HOLD_MIN: '0', TRADER_PERSIST_SCANS: '1',
});
delete process.env.TRADER_ENTRY_BLOCK_ET;
delete process.env.TRADER_ENTRY_REQUOTE;
const stub = {
  getQuotes: async (tickers) => tickers.map((t) => ({ ticker: t, price: 500, chg_pct: 0 })),
  getBars: async () => ({ bars: [] }), getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => ({ bars: [] }), getBarsWindow: async () => ({ bars: [] }),
  getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true,
};
const mdPath = require.resolve('../lib/market-data-yahoo');
require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };
const at = require('../lib/auto-trader');

const THU = Date.parse('2026-09-24T16:00:00Z');   // Thursday 12:00 ET
const FRI = Date.parse('2026-09-25T16:00:00Z');   // Friday 12:00 ET
const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { at._resetCooldowns(); if (fs.existsSync(LOG)) fs.unlinkSync(LOG); };
const bullish = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, decision_context: { ibs: 0.1 }, convergence: { decision: 'ENTER', p_win: 0.8 } };
function bridge(positions = []) {
  const placed = [];
  return { placed, getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRPositions: async () => positions, getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0,
    placeIBKROrder: async (_u, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; }, cancelIBKROrder: async () => ({ ok: true }) };
}
const run = (signals, b, now) => at.runAutoTrade({ signals, timestamp: new Date(now).toISOString() }, { bridge: b, userId: 'u', now });

test('the pure read: off by default, an ET Friday only, any value but 1 is off', () => {
  delete process.env.TRADER_NO_FRIDAY_ENTRIES;
  assert.strictEqual(at._noFridayEntry(FRI), false, 'unset: a Friday is open');
  process.env.TRADER_NO_FRIDAY_ENTRIES = '1';
  assert.strictEqual(at._noFridayEntry(FRI), true, 'Friday 12:00 ET');
  assert.strictEqual(at._noFridayEntry(Date.parse('2026-09-25T13:30:00Z')), true, 'Friday 09:30 ET');
  assert.strictEqual(at._noFridayEntry(Date.parse('2026-09-26T03:30:00Z')), true, 'UTC Saturday 03:30 is still Friday 23:30 in New York');
  assert.strictEqual(at._noFridayEntry(THU), false, 'Thursday');
  assert.strictEqual(at._noFridayEntry(Date.parse('2026-09-26T04:30:00Z')), false, 'Saturday 00:30 ET');
  for (const v of ['0', 'true', 'yes', '']) { process.env.TRADER_NO_FRIDAY_ENTRIES = v; assert.strictEqual(at._noFridayEntry(FRI), false, `value ${JSON.stringify(v)} is off`); }
  delete process.env.TRADER_NO_FRIDAY_ENTRIES;
});

test('on, Friday: the entry is skipped and the skip says why', async () => {
  reset(); process.env.TRADER_NO_FRIDAY_ENTRIES = '1';
  const b = bridge();
  const out = await run([bullish], b, FRI);
  assert.strictEqual(b.placed.length, 0, 'no order on a Friday');
  const why = [...((out && out.skipped) || []).map((s) => s.why), ...rows().filter((r) => r.event === 'skip').map((r) => r.reason)].join(' | ');
  assert.match(why, /no_friday_entries/, 'the skip names the rule');
  delete process.env.TRADER_NO_FRIDAY_ENTRIES;
});

test('on, Thursday: the same signal buys', async () => {
  reset(); process.env.TRADER_NO_FRIDAY_ENTRIES = '1';
  const b = bridge();
  await run([bullish], b, THU);
  assert.ok(b.placed.some((o) => o.side === 'buy' && o.ticker === 'QQQ'), 'Thursday entry placed');
  delete process.env.TRADER_NO_FRIDAY_ENTRIES;
});

test('off, Friday: the default is unchanged, the signal buys', async () => {
  reset(); delete process.env.TRADER_NO_FRIDAY_ENTRIES;
  const b = bridge();
  await run([bullish], b, FRI);
  assert.ok(b.placed.some((o) => o.side === 'buy' && o.ticker === 'QQQ'), 'Friday entry placed with the knob off');
});

test('on, Friday: a held long is still sold on its signal (exits untouched)', async () => {
  reset(); process.env.TRADER_NO_FRIDAY_ENTRIES = '1'; process.env.TRADER_MANAGE_EXITS = '1';
  const held = [{ symbol: 'QQQ', qty: 20, avg_entry_price: 500, current_price: 505, market_value: 10100, unrealized_pl: 100 }];
  const b = bridge(held);
  const bearish = { symbol: 'QQQ', direction: 'BEARISH', entry_price: 505, decision_context: { ibs: 0.9 }, convergence: { decision: 'ENTER', p_win: 0.8 } };
  const out = await run([bearish], b, FRI);
  const sold = b.placed.some((o) => o.side === 'sell' && o.ticker === 'QQQ');
  const why = ((out && out.skipped) || []).map((s) => s.why).join(' | ');
  assert.ok(sold, `the signal exit still fires on a Friday (skips: ${why})`);
  assert.doesNotMatch(why, /no_friday_entries/, 'the rule never speaks on an exit');
  delete process.env.TRADER_NO_FRIDAY_ENTRIES; delete process.env.TRADER_MANAGE_EXITS;
});
