'use strict';
/**
 * fill-visible-exits.test.js — a stop that fills while the brain is down must still book at the
 * fill (race, SQQQ, 2026-09-21).
 *
 * Race carried SQQQ (396 @ 38.75, GTC stop 37.59 placed Thu 09-17) into Monday's gap-up. The stop
 * filled 09:31-09:33 while the server was disarmed for the two-sleeve dry day; the brain re-armed at
 * 16:20 and never booked it. Three guards, each sound alone, lost the trade together:
 *   1. getEngineOrders asked Alpaca for closed orders submitted in the last 30h — and `after`
 *      filters on SUBMISSION time, so a Thursday stop that filled Monday was never in the feed.
 *   2. the fill ledger's process-start guard drops any fill older than the process (it exists so a
 *      redeploy does not back-fill history as null-P&L rows) — a fill of a position the brain was
 *      TRACKING is not history, it is the exit it had been waiting for.
 *   3. the sweep's trust guard defers on a 0-row snapshot (an empty book can be a lying feed, seen
 *      2026-08-13), so the phantom sat in lastPos journaling "external-close sweep deferred" every
 *      scan, to be reconstructed at a stale mark whenever the book next held anything.
 * The ledger under-reported the day by $815. These tests pin the three repairs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('node:events');

process.env.TRADER_TRADES_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fill-visible-')), 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(path.dirname(process.env.TRADER_TRADES_LOG), 'state.json');
const { newExitRows } = require('../lib/fill-ledger');
const alpaca = require('../lib/alpaca-adapter');
const at = require('../lib/auto-trader');

const H = 3600e3;
const SQQQ_FILL = { orderId: '1a74e625-stop', symbol: 'SQQQ', side: 'SELL', orderType: 'stop', filledQty: 396, avgPrice: 36.691818, status: 'filled', time: '2026-09-21T13:33:31Z' };
const PROCESS_START = Date.parse('2026-09-21T20:20:09Z');   // race re-armed at 16:20 ET, seven hours after the fill
const ENTRY_AT = Date.parse('2026-09-17T14:46:59Z');
const readRows = () => (fs.existsSync(process.env.TRADER_TRADES_LOG) ? fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : []);

test('fill ledger: a pre-boot fill of a TRACKED position is the exit we were waiting for, not history', () => {
  const rows = newExitRows([SQQQ_FILL], new Set(), () => ({ avg_entry_price: 38.75, openedAt: ENTRY_AT }), PROCESS_START);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].exit, 36.691818);
  assert.ok(Math.abs(rows[0].pnl - (-815.04)) < 0.05, `pnl ${rows[0].pnl}`);
  assert.strictEqual(rows[0].ts, '2026-09-21T13:33:31.000Z', 'dated at the broker fill, not at discovery');
  assert.strictEqual(rows[0].source, 'fill');
  assert.strictEqual(rows[0].opened_at, ENTRY_AT);
});

test('fill ledger: the process-start guard still drops pre-boot fills that are NOT a tracked position', () => {
  assert.strictEqual(newExitRows([SQQQ_FILL], new Set(), () => ({}), PROCESS_START).length, 0, 'untracked symbol: history');
  assert.strictEqual(newExitRows([SQQQ_FILL], new Set(), () => ({ avg_entry_price: 38.75 }), PROCESS_START).length, 0, 'tracked but no known open time: stay conservative');
  assert.strictEqual(newExitRows([SQQQ_FILL], new Set(), () => ({ avg_entry_price: 38.75, openedAt: Date.parse('2026-09-21T14:00:00Z') }), PROCESS_START).length, 0,
    'a sell that predates the current entry belongs to an earlier round trip');
});

test('fill ledger: without a cutoff nothing changes — the exemption only widens the guarded case', () => {
  assert.strictEqual(newExitRows([SQQQ_FILL], new Set(), () => ({ avg_entry_price: 38.75 }), 0).length, 1);
});

test('getEngineOrders asks for a WEEK of closed orders: a GTC stop on a multi-day carry is submitted days before it fills', async () => {
  const realRequest = https.request;
  const captured = [];
  const old = { k: process.env.ALPACA_API_KEY, s: process.env.ALPACA_SECRET_KEY, e: process.env.ALPACA_ENV };
  process.env.ALPACA_API_KEY = 'PKTEST'; process.env.ALPACA_SECRET_KEY = 'SECRETTEST'; delete process.env.ALPACA_ENV;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.destroy = () => {}; req.write = () => {};
    req.end = () => { captured.push(opts.path); const res = new EventEmitter(); res.statusCode = 200; cb(res); res.emit('data', '[]'); res.emit('end'); };
    return req;
  };
  try {
    await alpaca.getEngineOrders('local-owner');
    const closed = captured.find((p) => p.includes('status=closed'));
    assert.ok(closed, 'closed orders are queried');
    const after = Date.parse(decodeURIComponent(closed.match(/after=([^&]+)/)[1]));
    const days = (Date.now() - after) / (24 * H);
    assert.ok(days >= 6.9, `after reaches back ${days.toFixed(1)} days; a Thursday stop filling Monday needs more than four`);
  } finally {
    https.request = realRequest;
    if (old.k == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = old.k;
    if (old.s == null) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = old.s;
    if (old.e == null) delete process.env.ALPACA_ENV; else process.env.ALPACA_ENV = old.e;
  }
});

test('brain: a 0-row snapshot with a pre-boot fill of the tracked position books the exit at the fill, defers nothing, clears the phantom, never double-books', async () => {
  at._resetCooldowns();
  const now = Date.now();
  fs.writeFileSync(process.env.TRADER_STATE_FILE, JSON.stringify({
    lastPos: { SQQQ: { qty: 396, entry: 38.75, mark: 36.675, ts: now - 12 * H } },
    entryAt: { SQQQ: now - 4 * 24 * H },
    stopDistPct: { SQQQ: 3 },
  }));
  at._loadState();
  const env = { A: process.env.TRADER_AUTO_EXECUTE, M: process.env.TRADER_MANAGE_EXITS };
  process.env.TRADER_AUTO_EXECUTE = '1'; process.env.TRADER_MANAGE_EXITS = '1';
  const fill = { ...SQQQ_FILL, time: new Date(now - 11 * H).toISOString() };   // filled hours before this process started
  try {
    const bridge = {
      getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
      getIBKRPositions: async () => [],                       // the book is genuinely empty: the stop took the only position
      getIBKROpenOrders: async () => [fill],                   // the week-wide feed now shows the Thursday stop, filled
      getIBKRDayPnl: async () => 0,
      getIBKROrderStatus: async () => null,
      placeIBKROrder: async () => { throw new Error('no broker writes expected'); },
      cancelIBKROrder: async () => { throw new Error('no broker writes expected'); },
    };
    const out = await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    const exits = readRows().filter((r) => r.event === 'exit' && r.symbol === 'SQQQ');
    assert.strictEqual(exits.length, 1, 'exactly one exit row');
    assert.strictEqual(exits[0].source, 'fill');
    assert.strictEqual(exits[0].exit, 36.691818);
    assert.ok(Math.abs(exits[0].pnl + 815.04) < 0.05, `pnl ${exits[0].pnl}`);
    assert.strictEqual(exits[0].status, 'filled', 'priced at the fill, not a mark-priced reconstruction');
    assert.ok(!(out.skipped || []).some((s) => /sweep deferred/.test(s.why || '')), 'no phantom deferral on the empty book');
    const st = JSON.parse(fs.readFileSync(process.env.TRADER_STATE_FILE, 'utf8'));
    assert.ok(!st.lastPos || !st.lastPos.SQQQ, 'the phantom is gone from lastPos');
    assert.ok(!st.entryAt || !st.entryAt.SQQQ, 'and from the hold clock');
    // a second scan on the same empty book: nothing to defer, nothing to reconstruct
    const out2 = await at.runAutoTrade({ signals: [] }, { bridge, userId: 't' });
    assert.ok(!(out2.skipped || []).some((s) => /sweep deferred/.test(s.why || '')));
    assert.strictEqual(readRows().filter((r) => r.event === 'exit' && r.symbol === 'SQQQ').length, 1, 'never double-booked');
  } finally {
    if (env.A == null) delete process.env.TRADER_AUTO_EXECUTE; else process.env.TRADER_AUTO_EXECUTE = env.A;
    if (env.M == null) delete process.env.TRADER_MANAGE_EXITS; else process.env.TRADER_MANAGE_EXITS = env.M;
  }
});
