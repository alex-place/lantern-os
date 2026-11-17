'use strict';
/**
 * exit-authority.test.js — the IBS bounce owns the signal exit (round-7 lab, 2026-08-23).
 *
 * With TRADER_IBS_EXIT armed, a held long is sold by the signal exit once the session IBS
 * reaches the bounce, and held while the washout thesis is intact. The legacy exits that
 * used to pre-empt the bounce (zone ladder, 1R take-profit, momentum death, the p_win exit
 * gate) were removed from the engine on 2026-11-17 (off on every box; history H72/H75).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exitauth-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';
process.env.TRADER_AUTO_EXECUTE = '1';
process.env.TRADER_IBS_EXIT = '0.6';          // the bounce gate, as armed on both boxes 2026-08-22

const at = require('../lib/auto-trader');

// A FIXED CLOCK. runAutoTrade's `now` defaults to the wall clock, and a signal exit waits
// until the regular session is 30 minutes old (exitMinSessionMin), so three tests below
// went red whenever CI ran 09:30-10:00 ET on a trading day (run 42047842418, 09:46 ET).
// Every scan here runs at noon on a plain mid-week session, whatever the hour really is.
const NOW = Date.parse('2026-11-04T12:00:00-05:00');   // a Wednesday, 150 minutes into a full session

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A held long opened two hours ago, protected by its broker stop. */
function world() {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 100.8, ts: NOW } },
    entryAt: { LNG: NOW - 2 * 3600e3 },
    stopOrders: { LNG: { id: 'S1', px: 97, qty: 100, at: NOW - 2 * 3600e3 } },
  }));
  at._loadState();
  const placed = [];
  const bridge = {
    placed,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: 100.8, market_value: 10080, unrealized_pl: 80 }],
    getIBKROpenOrders: async () => [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 97, qty: 100 }],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
  return bridge;
}
const bounce = (pWin = 0.8) => ({ symbol: 'LNG', direction: 'NEUTRAL', entry_price: 100.8, ibs: 0.72, convergence: { decision: 'ENTER', p_win: pWin } });
const sells = (b) => b.placed.filter((o) => o.ticker === 'LNG' && o.side === 'sell' && o.type === 'market');

test('the bounce (IBS 0.72) sells, even on a weak p_win read; the stop is cancelled first', async () => {
  const bridge = world();
  await at.runAutoTrade({ signals: [bounce(0.5)] }, { bridge, userId: 't', now: NOW });
  assert.strictEqual(sells(bridge).length, 1, 'the bounce is banked');
  assert.ok(readRows().some((r) => r.event === 'exit_intent' && r.reason === 'signal_exit'), 'exit intent journaled');
});

test('thesis intact (IBS 0.41) is held — the gate itself is unchanged', async () => {
  const bridge = world();
  const sig = bounce(0.5); sig.ibs = 0.41;
  const out = await at.runAutoTrade({ signals: [sig] }, { bridge, userId: 't', now: NOW });
  assert.strictEqual(sells(bridge).length, 0);
  assert.ok(out.skipped.some((s) => /washout thesis intact/.test(s.why)));
});
