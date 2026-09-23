'use strict';
/**
 * be-ratchet-session-bar.test.js — the breakeven-ratchet SESSION BAR must be READ, not just written.
 *
 * #3413 validated the ratchet with a no-same-session-re-entry block after breakeven exits charged
 * as realism, and #3414 arms that bar in _reconcileFills (stopCooldownThrough[sym] = today) whether
 * or not the N-day post-stop cooldown is on. But the only READER sat inside
 * `if (c.stopCooldownDays > 0)`, and stable runs TRADER_STOP_COOLDOWN_DAYS=0 — the bar was written
 * to state and never consulted. Both replay harnesses pin days=0 too, so no replay priced it either.
 *
 * Live 2026-09-23 (first armed two-sleeve session, S sleeve = stable's brain): UPRO's ratcheted stop
 * filled at 13:44:53 (be_ratchet:true, +$4.44) and S.state.json recorded stopCooldownThrough.UPRO =
 * 2026-09-23; the 13:45-13:53 skips were the 45-minute ORDER cooldown, 14:05 was entry_confirm, and
 * at 14:12:15 the brain bought UPRO again — 28 minutes after the breakeven exit, the exact re-entry
 * the validated policy forbids.
 *
 * These tests drive the REAL runAutoTrade entry path with stable's values (days 0), entries ARMED
 * (an unread bar would place the buy), a stubbed market-data module (no network) and a pinned
 * weekday-afternoon clock.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'be-sessionbar-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_AUTO_EXECUTE = '1';          // entries armed: a bar that is not read would PLACE the buy
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_STOP_COOLDOWN_DAYS = '0';    // stable's armed value — the N-day cooldown is OFF
process.env.TRADER_BE_RATCHET = '0.01';
process.env.TRADER_BE_LOCK = '0.01';
// Let the signal reach the post-stop check: the gates between the candidate list and that check
// are pinned OFF so the verdict is about the bar, not about bars this fixture does not serve.
process.env.TRADER_REQUIRE_PERSIST = '0';
process.env.TRADER_ENTRY_KNIFE_FILTER = '0';
process.env.TRADER_ENTRY_CONFIRM = '0';
process.env.TRADER_SUP_ENTRY = '0';
process.env.TRADER_ROOM_TIER = '0';
process.env.TRADER_MIN_ENTRY_RR = '0';
process.env.TRADER_STOP_FROM_TGT = '0';
delete process.env.TRADER_ENTRY_CADENCE_MIN;
delete process.env.TRADER_ENTRY_BLOCK_ET;
// Hermetic exits (#3437/#3438 pins, as in be-ratchet.test.js).
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';

// No network: the brain asks lib/market-data-yahoo for bars; serve nothing (the replay-harness trick).
const mdPath = require.resolve('../lib/market-data-yahoo.js');
require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
  getBarsMulti: async () => ({ bars: {} }),
  getBars: async () => [],
  getQuotes: async (tickers) => (tickers || []).map((t) => ({ symbol: t, price: 100 })),
  getSessionBars15m: async () => [],
} };
const at = require('../lib/auto-trader');

const NOW = Date.parse('2026-09-23T18:12:15Z');   // Wed 14:12:15 ET — the minute of the live re-entry
const etDate = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const TODAY = etDate(NOW);
const YESTERDAY = etDate(NOW - 24 * 3600e3);

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const BAR_RE = /no re-entry through/;

/** Flat in LNG (an anchor position keeps the snapshot readable), the bar as given, one BULLISH LNG signal. */
async function scanWithBar(through) {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { ANCH: { qty: 10, entry: 50, mark: 50, ts: NOW } },
    ...(through ? { stopCooldownThrough: { LNG: through } } : {}),
  }));
  at._loadState();
  const placed = [];
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'ANCH', qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'O' + placed.length }; },
  };
  const signal = { symbol: 'LNG', direction: 'BULLISH', entry_price: 100,
    decision_context: { ibs: 0.1, spy_tape: 0 }, convergence: { decision: 'ENTER', p_win: 0.6 } };
  const out = await at.runAutoTrade({ signals: [signal] }, { bridge, userId: 't', now: NOW });
  const skip = [...(out.skipped || []), ...readRows().filter((r) => r.event === 'skip')]
    .find((r) => r.symbol === 'LNG' && r.why);
  return { out, placed, skip };
}

test('LIVE 2026-09-23: days=0, a breakeven exit this session — the same-session re-entry is REFUSED', async () => {
  const { skip, placed } = await scanWithBar(TODAY);
  assert.ok(skip, 'LNG was refused, not entered');
  assert.match(String(skip.why), BAR_RE, 'refused BY THE BAR, got: ' + skip.why);
  assert.strictEqual(placed.filter((o) => String(o.side).toLowerCase() === 'buy').length, 0, 'no buy reached the broker');
  assert.ok(!readRows().some((r) => r.event === 'entry' && r.symbol === 'LNG'), 'no entry row');
  assert.strictEqual(readState().stopCooldownThrough.LNG, TODAY, 'the bar stays for the rest of the session');
});

test('the refusal names the breakeven exit when the N-day cooldown is off — the journal must say why', async () => {
  const { skip } = await scanWithBar(TODAY);
  assert.match(String(skip && skip.why), /be_ratchet session bar/);
});

test('CONTROL: an expired bar (yesterday) is cleaned up and does not refuse — the reader ran and let it through', async () => {
  const { skip } = await scanWithBar(YESTERDAY);
  assert.ok(!skip || !BAR_RE.test(String(skip.why)), 'not refused by the bar, got: ' + (skip && skip.why));
  assert.ok(!(readState().stopCooldownThrough || {}).LNG, 'the expired bar was removed from state');
});

test('CONTROL: no bar — the same signal is not refused by the post-stop check', async () => {
  const { skip } = await scanWithBar(null);
  assert.ok(!skip || !BAR_RE.test(String(skip.why)), 'not refused, got: ' + (skip && skip.why));
});
