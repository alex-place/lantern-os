'use strict';

/**
 * cash-reserve.test.js — the account always keeps a cash floor.
 *
 * Per-position caps do not bound the SUM: 12 tradelist symbols x a 7% cap could
 * deploy 84% of equity. TRADER_MAX_GROSS_PCT (default 80) caps total gross
 * exposure; an entry that would breach it is skipped with a ledger-visible
 * reason. Exits must never be blocked by it — reducing risk is always allowed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const p = require('path');

{
  const _tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'cashres-'));
  process.env.TRADER_TRADES_LOG = p.join(_tmp, 'trades.jsonl');
  process.env.TRADER_STATE_FILE = p.join(_tmp, 'state.json');
}
const at = require('../lib/auto-trader');

function mkBridge({ positions, buys, sells }) {
  return {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => positions,
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => {
      if (/buy/i.test(o.side)) buys.push(o); else sells.push(o);
      return { status: 'placed' };
    },
  };
}
const enter = (sym) => ({
  symbol: sym, direction: 'BULLISH', entry_price: 100, atr: 1,
  zones: [{ type: 'SUPPORT', level: 99.8, top: 99.8, bottom: 99.5 }],
  convergence: { decision: 'ENTER', p_win: 0.7, size_mult: 1 },
});
const pos = (sym, mv) => ({ symbol: sym, qty: mv / 100, avg_entry_price: 100, current_price: 100, market_value: mv });

async function run({ positions, signals, env }) {
  const saved = { ...process.env };
  const buys = [], sells = [];
  try {
    Object.assign(process.env, {
      TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0', TRADER_MOMENTUM_EXIT: '0',
      TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_LOG_SKIPS: '0',
    }, env || {});
    at._resetCooldowns();
    const out = await at.runAutoTrade({ signals }, { bridge: mkBridge({ positions, buys, sells }), userId: 'u', now: 1_700_000_000_000 });
    return { out, buys, sells };
  } finally { process.env = saved; at._resetCooldowns(); }
}

test('an entry that would breach the gross cap is SKIPPED with a cash-reserve reason', async () => {
  // $79.5k already deployed on $100k equity; cap 80% leaves a $500 budget — any
  // normal-sized entry must be refused.
  // (Was 40k+38k = a $2,000 budget, which the 3% stop floor made EXACTLY equal
  // to the sized position — `gross + qty*price > budget` is false at equality,
  // so the fixture sat on a knife edge and started passing. Widen the margin so
  // the test asserts the brake, not a boundary coincidence.)
  const { out, buys } = await run({
    positions: [pos('SPY', 40000), pos('QQQ', 39500)],
    signals: [enter('GLD')],
    env: { TRADER_MAX_GROSS_PCT: '80' },
  });
  assert.strictEqual(buys.length, 0, 'no buy may be placed past the cap');
  assert.ok(out.skipped.some((s) => s.symbol === 'GLD' && /cash reserve/.test(s.why)),
    `skip reason must say cash reserve, got: ${JSON.stringify(out.skipped)}`);
});

test('with room under the cap the entry places normally', async () => {
  const { buys } = await run({
    positions: [pos('SPY', 20000)],
    signals: [enter('GLD')],
    env: { TRADER_MAX_GROSS_PCT: '80' },
  });
  assert.strictEqual(buys.length, 1, 'a $20k book on $100k equity leaves plenty of room');
});

test('TRADER_MAX_GROSS_PCT=0 disables the brake', async () => {
  const { buys } = await run({
    positions: [pos('SPY', 40000), pos('QQQ', 38000)],
    signals: [enter('GLD')],
    env: { TRADER_MAX_GROSS_PCT: '0' },
  });
  assert.strictEqual(buys.length, 1, 'disabled -> the old behaviour');
});

test('EXITS are never blocked by the cap — reducing risk is always allowed', async () => {
  // Deep-red position on a fully-deployed book: the max-loss backstop must
  // still be able to sell even though gross is far past the cap.
  const { sells } = await run({
    positions: [
      { symbol: 'SPY', qty: 900, avg_entry_price: 100, current_price: 85, market_value: 76500, unrealized_pl: -13500 },
      pos('QQQ', 20000),
    ],
    signals: [],
    env: { TRADER_MAX_GROSS_PCT: '50', TRADER_MANAGE_EXITS: '1', TRADER_MIN_HOLD_MIN: '0', TRADER_MAX_LOSS_PCT: '8' },
  });
  assert.ok(sells.some((o) => o.ticker === 'SPY' && /sell/i.test(o.side)), 'backstop exit must fire regardless of gross cap');
});
