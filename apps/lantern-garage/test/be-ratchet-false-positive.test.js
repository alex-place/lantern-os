'use strict';
/**
 * be-ratchet-false-positive.test.js — a stop that fills BELOW entry is a stop-out, never a breakeven round trip.
 *
 * Live 2026-09-03: SOXS entered 11:13 at 53.17 with its 3% stop at 51.58; no ratchet ever fired (the mark never
 * reached +1%), yet the 14:02 fill at 51.57 (-2.87%, -3,328) was journaled be_ratchet:true because the ratchet
 * map still held SOXS from an earlier position. A be_ratchet stop feeds neither the cooldown nor the daily
 * breaker, so a real failure was booked as a round trip. Same on TNA 2026-09-01 (-1.46%).
 *
 * The flag now requires the fill at or above entry, and any stop fill clears the map entry.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'be-fp-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_BE_RATCHET = '0.01';
process.env.TRADER_STOP_COOLDOWN_DAYS = '1';
process.env.TRADER_STOP_BREAKER = '2';
delete process.env.TRADER_AUTO_EXECUTE;
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

async function stopFillsAt(fillPx, stopId) {   // a distinct stop id per case: the brain remembers booked fill ids for the process lifetime
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 99, ts: Date.now() }, ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() } },
    stopDistPct: { LNG: 3 },
    stopOrders: { LNG: { id: stopId, px: 97, qty: 100, at: Date.now() - 3600e3 } },
    beStopAt: { LNG: 101 },          // STALE: left over from an earlier LNG position
  }));
  at._loadState();
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async (uid, id) => (id === stopId ? { order_id: id, status: 'Filled', avgPrice: fillPx, filledQty: 100 } : null),
  };
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
  return readRows().filter((r) => r.event === 'exit');
}

test('a stop that fills BELOW entry with a stale ratchet entry is a real stop-out: no be_ratchet, breaker fed, map cleared', async () => {
  const exits = await stopFillsAt(97.02, 'S9');
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0].be_ratchet, undefined, 'not a round trip');
  assert.ok(!/be_ratchet/.test(exits[0].reason));
  const st = readState();
  assert.strictEqual((st.stopFills && st.stopFills.count) || 0, 1, 'the daily breaker counts a real failure');
  assert.ok(st.stopCooldownThrough && st.stopCooldownThrough.LNG > new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), 'the N-day cooldown is armed');
  assert.ok(!(st.beStopAt && st.beStopAt.LNG), 'the stale ratchet entry is gone');
});

test('a stop that fills AT or above entry with a ratchet entry is still the round trip', async () => {
  const exits = await stopFillsAt(100.5, 'S10');
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0].be_ratchet, true);
  const st = readState();
  assert.strictEqual((st.stopFills && st.stopFills.count) || 0, 0, 'a round trip does not feed the breaker');
});
