'use strict';
/**
 * ibs-exit-gate.test.js — hold the washout to its bounce (fidelity lab, 2026-08-22).
 *
 * The gap this closes: in IBS mode the signal flips BULLISH→NEUTRAL the moment
 * the session IBS rises above the entry threshold — the instant a washout starts
 * to bounce — and `!bullish` took that NEUTRAL read straight into the signal-exit
 * path. Live 8/10–8/21: 57 signal_exits, median +0.09%, median hold 50 minutes,
 * while the portfolio analog on the same symbols/weeks earned ~9x by holding to
 * the validated exit (session IBS ≥ 0.6). TRADER_IBS_EXIT gates the signal exit
 * on that bounce level; off by default.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibsexit-'));
const LOG = path.join(DIR, 'trades.jsonl');
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = '1';
process.env.TRADER_PERSIST_SCANS = '1';
process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';   // the maturity guard has its own tests below; keep the others clock-independent      // one scan suffices here — persistence is not under test
process.env.TRADER_AUTO_EXECUTE = '1';       // the signal loop (and its exit branch) only runs when entries are armed — as live
delete process.env.TRADER_IBS_EXIT;

// HERMETIC EXITS (2026-08-25). These fixtures hold a position in "LNG" — a REAL
// ticker — and the engine's market-data-driven exits fetch live bars for whatever
// symbol it is holding. So with those exits at their defaults the suite's verdict
// depends on Cheniere Energy's intraday MACD/RSI: CI was green at 14:49 ET and red
// at 15:58 ET the same afternoon, with be-ratchet losing 6 tests and eod-flat 4 to
// a `momentum_died (MACD hist<0, <EMA9, RSI 40)` exit that closed the position out
// from under the behaviour being tested. Pinning the five exit-authority switches
// to their ARMED production values (#3437/#3438) makes the fixture deterministic
// AND more faithful to the engine that actually runs. A test about the IBS exit gate must
// not be able to fail because a real stock moved.
process.env.TRADER_MOMENTUM_EXIT = '0';
process.env.TRADER_ZONE_EXIT = '0';
process.env.TRADER_TAKE_PROFIT_R = '0';
process.env.TRADER_EXIT_MIN_PWIN = '0';
process.env.TRADER_EOD_DECARRY = '0';
const at = require('../lib/auto-trader');

const readRows = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A held long opened two hours ago (past min-hold), no zone ladder, no stop drama. */
function world() {
  at._resetCooldowns();
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  fs.writeFileSync(STATE, JSON.stringify({
    lastPos: { LNG: { qty: 100, entry: 100, mark: 100.3, ts: Date.now() } },
    entryAt: { LNG: Date.now() - 2 * 3600e3 },
    stopOrders: { LNG: { id: 'S1', px: 97, qty: 100, at: Date.now() - 2 * 3600e3 } },
  }));
  at._loadState();
  const placed = [];
  const bridge = {
    placed,
    getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }),
    getIBKRPositions: async () => [{ symbol: 'LNG', qty: 100, avg_entry_price: 100, current_price: 100.3, market_value: 10030, unrealized_pl: 30 }],
    getIBKROpenOrders: async () => [{ orderId: 'S1', symbol: 'LNG', side: 'sell', orderType: 'Stop', status: 'Submitted', price: 97, qty: 100 }],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async () => ({ status: 'cancelled' }),
    placeIBKROrder: async (uid, o) => { placed.push(o); return { status: 'submitted', order_id: 'X' + placed.length }; },
  };
  return bridge;
}
// The loop iterates ENTER-decision signals; a non-bullish ENTER on a held long is the signal-exit path.
const neutral = (ibs) => ({ symbol: 'LNG', direction: 'NEUTRAL', entry_price: 100.3, ibs, convergence: { decision: 'ENTER', p_win: 0.8 } });
const sells = (b) => b.placed.filter((o) => o.ticker === 'LNG' && o.side === 'sell' && o.type === 'market');

test('LEGACY (gate off): a NEUTRAL read with IBS 0.41 sells the washout — the churn the lab exposed', async () => {
  delete process.env.TRADER_IBS_EXIT;
  const bridge = world();
  await at.runAutoTrade({ signals: [neutral(0.41)] }, { bridge, userId: 't' });
  assert.strictEqual(sells(bridge).length, 1, 'legacy behaviour: NEUTRAL sells');
  assert.ok(readRows().some((r) => r.event === 'exit_intent' && r.reason === 'signal_exit'));
});

test('GATE ON, thesis intact: IBS 0.41 < 0.6 — no sell, honest skip row, stop untouched', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  try {
    const bridge = world();
    const out = await at.runAutoTrade({ signals: [neutral(0.41)] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 0, 'the washout is held');
    assert.ok(out.skipped.some((s) => /washout thesis intact \(IBS 0\.41 < 0\.6\)/.test(s.why)), 'skip row names the gate');
    assert.ok(!readRows().some((r) => r.event === 'exit_intent'), 'no exit intent journaled');
  } finally { delete process.env.TRADER_IBS_EXIT; }
});

test('GATE ON, bounce reached: IBS 0.72 >= 0.6 — the signal exit proceeds', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  try {
    const bridge = world();
    await at.runAutoTrade({ signals: [neutral(0.72)] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 1, 'the bounce is banked');
  } finally { delete process.env.TRADER_IBS_EXIT; }
});

test('GATE ON, no IBS reading: HOLDS (2026-08-24) — a missing ruler is not a bounce', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  try {
    const bridge = world();
    const sig = neutral(null); delete sig.ibs;
    const out = await at.runAutoTrade({ signals: [sig] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 0, 'null IBS must not sell');
    assert.ok(out.skipped.some((s) => /no session IBS reading yet/.test(s.why)), 'skip row names the missing reading');
  } finally { delete process.env.TRADER_IBS_EXIT; }
});

test('TRADER_EXIT_NEEDS_IBS=0 restores the legacy fallthrough for a missing reading', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  process.env.TRADER_EXIT_NEEDS_IBS = '0';
  try {
    const bridge = world();
    const sig = neutral(null); delete sig.ibs;
    await at.runAutoTrade({ signals: [sig] }, { bridge, userId: 't' });
    assert.strictEqual(sells(bridge).length, 1, 'the escape hatch still sells');
  } finally { delete process.env.TRADER_IBS_EXIT; delete process.env.TRADER_EXIT_NEEDS_IBS; }
});

// SESSION-RANGE MATURITY (2026-08-24). `now` is pinned so the suite does not
// depend on the wall clock: 09:35 ET is 5 minutes into the session, 11:00 is 90.
const ET_AT = (hh, mm) => {
  // hh:mm America/New_York on TOMORROW's date: the time-of-day is what the guard
  // reads, and a forward instant keeps it after any wall-clock timestamp the
  // fixtures stamp (entryAt / exitAt), so suite order cannot change the result.
  const etDate = new Date(Date.now() + 26 * 3600e3).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const probeUtcHour = Number(new Date(etDate + 'T12:00:00Z').toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).slice(0, 2));
  const offsetH = 12 - probeUtcHour;                       // 4 in EDT, 5 in EST
  return Date.parse(`${etDate}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) + offsetH * 3600e3;
};
test('a bounce read 5 minutes into the session does NOT sell — the range is too young', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  process.env.TRADER_EXIT_MIN_SESSION_MIN = '30';
  try {
    const bridge = world();
    const out = await at.runAutoTrade({ signals: [neutral(0.72)] }, { bridge, userId: 't', now: ET_AT(9, 35) });
    assert.strictEqual(sells(bridge).length, 0, 'no signal exit in the first 30 minutes');
    assert.ok(out.skipped.some((s) => /session 5min old/.test(s.why)), 'skip row names the session age');
  } finally { delete process.env.TRADER_IBS_EXIT; process.env.TRADER_EXIT_MIN_SESSION_MIN = '0'; }
});

test('the same bounce read 90 minutes in DOES sell — a mature session is not gated', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  process.env.TRADER_EXIT_MIN_SESSION_MIN = '30';
  process.env.TRADER_MIN_HOLD_MIN = '0';   // the fixture's entryAt is wall-clock; the pinned `now` predates it
  try {
    const a = world();
    await at.runAutoTrade({ signals: [neutral(0.72)] }, { bridge: a, userId: 't', now: ET_AT(11, 0) });
    assert.strictEqual(sells(a).length, 1, 'a mature session sells the bounce');
  } finally { delete process.env.TRADER_IBS_EXIT; delete process.env.TRADER_MIN_HOLD_MIN; process.env.TRADER_EXIT_MIN_SESSION_MIN = '0'; }
});

test('TRADER_EXIT_MIN_SESSION_MIN=0 disables the maturity guard', async () => {
  process.env.TRADER_IBS_EXIT = '0.6';
  process.env.TRADER_EXIT_MIN_SESSION_MIN = '0';
  process.env.TRADER_MIN_HOLD_MIN = '0';
  try {
    const b = world();
    await at.runAutoTrade({ signals: [neutral(0.72)] }, { bridge: b, userId: 't', now: ET_AT(9, 35) });
    assert.strictEqual(sells(b).length, 1, 'guard off: sells at 09:35 again');
  } finally { delete process.env.TRADER_IBS_EXIT; delete process.env.TRADER_MIN_HOLD_MIN; process.env.TRADER_EXIT_MIN_SESSION_MIN = '0'; }
});

test('_sessionMinutes: minutes into the regular session, null outside it', () => {
  assert.strictEqual(at._sessionMinutes(ET_AT(9, 30)), 0);
  assert.strictEqual(at._sessionMinutes(ET_AT(9, 35)), 5);
  assert.strictEqual(at._sessionMinutes(ET_AT(11, 0)), 90);
  assert.strictEqual(at._sessionMinutes(ET_AT(15, 59)), 389);
  assert.strictEqual(at._sessionMinutes(ET_AT(16, 0)), null, 'after the close');
  assert.strictEqual(at._sessionMinutes(ET_AT(9, 29)), null, 'pre-market');
});
