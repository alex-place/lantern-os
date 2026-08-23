'use strict';
/**
 * exit-authority.test.js — who owns the exit when the bounce gate is armed
 * (round-7 lab, 2026-08-23).
 *
 * Live 8/10–8/21: "zone ladder owns this exit" blocked the signal exit 305
 * times and "bearish too weak to exit" 51 times. Since #3285 every entry arms
 * the ladder, so with TRADER_IBS_EXIT=0.6 armed the validated bounce exit
 * (sell at session IBS >= 0.6) could never fire for an engine entry — the
 * position waited for the ladder's R1 target instead (26y holdout 462% vs
 * 1,494%). The fix is configuration (the knobs already exist); this suite
 * pins the pre-emption, the env fix, and the one-time config_warning row.
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
delete process.env.TRADER_ZONE_EXIT;          // engine default: ladder ON
delete process.env.TRADER_EXIT_MIN_PWIN;      // engine default: 0.6
delete process.env.TRADER_TAKE_PROFIT_R;
delete process.env.TRADER_MOMENTUM_EXIT;

const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A held long opened two hours ago with a ladder armed at entry (as every live entry has since #3285). */
function world({ ladder = true } = {}) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 100.8, ts: Date.now() } },
    entryAt: { LNG: Date.now() - 2 * 3600e3 },
    stopOrders: { LNG: { id: 'S1', px: 97, qty: 100, at: Date.now() - 2 * 3600e3 } },
    zoneLadder: ladder ? { LNG: { r1: 103, r1top: 103.2, r2: 105.1, broke: false } } : {},
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

test('LIVE DEFAULTS: the bounce (IBS 0.72) is reached, but the ladder owns the exit — no sell', async () => {
  const bridge = world();
  const out = await at.runAutoTrade({ signals: [bounce()] }, { bridge, userId: 't' });
  assert.strictEqual(sells(bridge).length, 0, 'the validated exit never fires');
  assert.ok(out.skipped.some((s) => /zone ladder owns this exit/.test(s.why)), 'skip row names the ladder');
});

test('the conflict is journaled once per process as config_warning (the ledger shows the real exit structure)', async () => {
  const rows = readRows();
  const warn = rows.filter((r) => r.event === 'config_warning');
  assert.strictEqual(warn.length, 1, 'exactly one warning row');
  assert.ok(/TRADER_ZONE_EXIT/.test(warn[0].reason) && /TRADER_EXIT_MIN_PWIN=0\.6/.test(warn[0].reason) && /TRADER_TAKE_PROFIT_R=1/.test(warn[0].reason) && /TRADER_MOMENTUM_EXIT/.test(warn[0].reason), warn[0].reason);
  const bridge = world();
  await at.runAutoTrade({ signals: [bounce()] }, { bridge, userId: 't' });
  assert.strictEqual(readRows().filter((r) => r.event === 'config_warning').length, 0, 'not repeated on the next scan (fresh log, no new row)');
});

test('_exitAuthorityConflicts: empty when the gate is off, and empty under the validated env', () => {
  assert.deepStrictEqual(at._exitAuthorityConflicts({ ibsExit: 0, zoneExit: true, takeProfitR: 1, momentumExit: true, exitMinPwin: 0.6 }), []);
  assert.deepStrictEqual(at._exitAuthorityConflicts({ ibsExit: 0.6, zoneExit: false, takeProfitR: 0, momentumExit: false, exitMinPwin: 0 }), []);
  assert.strictEqual(at._exitAuthorityConflicts({ ibsExit: 0.6, zoneExit: true, takeProfitR: 0, momentumExit: false, exitMinPwin: 0 }).length, 1);
});

test('TRADER_ZONE_EXIT=0 alone: the ladder steps aside but the p_win gate still blocks a weak read', async () => {
  process.env.TRADER_ZONE_EXIT = '0';
  try {
    const bridge = world();
    const out = await at.runAutoTrade({ signals: [bounce(0.5)] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 0, 'p_win 0.5 < 0.6 still blocks');
    assert.ok(out.skipped.some((s) => /bearish too weak to exit/.test(s.why)), 'skip row names the p_win gate');
  } finally { delete process.env.TRADER_ZONE_EXIT; }
});

test('THE VALIDATED ENV (ladder off, p_win gate off): the bounce sells, the stop is cancelled', async () => {
  process.env.TRADER_ZONE_EXIT = '0';
  process.env.TRADER_EXIT_MIN_PWIN = '0';
  try {
    const bridge = world();
    await at.runAutoTrade({ signals: [bounce(0.5)] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 1, 'the bounce is banked');
    assert.ok(readRows().some((r) => r.event === 'exit_intent' && r.reason === 'signal_exit'), 'exit intent journaled');
  } finally { delete process.env.TRADER_ZONE_EXIT; delete process.env.TRADER_EXIT_MIN_PWIN; }
});

test('thesis intact (IBS 0.41) is still held under the validated env — the gate itself is unchanged', async () => {
  process.env.TRADER_ZONE_EXIT = '0';
  process.env.TRADER_EXIT_MIN_PWIN = '0';
  try {
    const bridge = world();
    const sig = bounce(0.5); sig.ibs = 0.41;
    const out = await at.runAutoTrade({ signals: [sig] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 0);
    assert.ok(out.skipped.some((s) => /washout thesis intact/.test(s.why)));
  } finally { delete process.env.TRADER_ZONE_EXIT; delete process.env.TRADER_EXIT_MIN_PWIN; }
});
