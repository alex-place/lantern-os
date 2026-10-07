'use strict';
/**
 * entry-requote-shadow.test.js — the entry re-quote shadow (2026-10-04, journal-only).
 *
 * TRADER_ENTRY_REQUOTE=shadow: beside every market buy the brain fetches a FRESH print (the market-data cache bypassed)
 * and journals `entry_requote` (decision quote, fresh quote, drift, the cap's verdict, the decision quote's age); the
 * entry_fill row that follows the broker's basis carries the fill against the fresh quote and whether a marketable limit
 * at quote + cap would have filled. Pinned here, on a hermetic brain (stubbed market data, a mock broker):
 *   - the pure read: drift, limit, refusal; junk in = null;
 *   - shadow on: the order still PLACES (a shadow never blocks), the fresh quote was asked for with the cache bypassed,
 *     the entry_requote row says what the guard would have done, and the fill row joins the re-quote numbers — written
 *     even for a same-price fill;
 *   - a fresh quote that fails to arrive: the order places, the row says 'no fresh quote';
 *   - shadow off: no entry_requote row, no extra fill row (the legacy >1 bp rule stands), the order places as before.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'requote-'));
const LOG = path.join(DIR, 'trades.jsonl');
Object.assign(process.env, {
  TRADER_TRADES_LOG: LOG, TRADER_STATE_FILE: path.join(DIR, 'state.json'), TRADER_AUTO_EXECUTE: '1', TRADER_REQUIRE_PERSIST: '0',
  TRADER_ENTRY_KNIFE_FILTER: '0', TRADER_SUP_ENTRY: '0', TRADER_STRESS_MULT: '1', TRADER_ENTRY_CONFIRM: '0', TRADER_ENTRY_CADENCE_MIN: '0',
  // the exit-authority switches at their armed values, so no market-data-driven exit can act on the held fixture
  TRADER_MOMENTUM_EXIT: '0', TRADER_ZONE_EXIT: '0', TRADER_TAKE_PROFIT_R: '0', TRADER_EXIT_MIN_PWIN: '0', TRADER_EOD_DECARRY: '0', TRADER_LIMIT_SHADOW: '0',
});
delete process.env.TRADER_MANAGE_EXITS;
// a stubbed market-data module, installed before the brain loads (the replay harness does the same)
const FRESH = { QQQ: 500.40 };
const asked = [];
const stub = {
  getQuotes: async (tickers, opts) => { asked.push({ tickers, opts }); return tickers.map((t) => ({ ticker: t, price: FRESH[t] == null ? 0 : FRESH[t], chg_pct: 0 })); },
  getBars: async () => ({ bars: [] }), getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => ({ bars: [] }), getBarsWindow: async () => ({ bars: [] }),
  getMarketStatus: async () => ({}), isUsEquityMarketOpen: () => true,
};
const mdPath = require.resolve('../lib/market-data-yahoo');
require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };
const at = require('../lib/auto-trader');
const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { at._resetCooldowns(); at._requoteShadow.clear(); at._pendingFillBasis.clear(); asked.length = 0; if (fs.existsSync(LOG)) fs.unlinkSync(LOG); };
const NOW = Date.parse('2026-09-22T19:00:00Z');   // a Tuesday 15:00 ET
const signal = { symbol: 'QQQ', direction: 'BULLISH', entry_price: 500, decision_context: { ibs: 0.1 }, convergence: { decision: 'ENTER', p_win: 0.8 } };
function bridge(positions = []) {
  const placed = [];
  return { placed, getIBKRAccount: async () => ({ equity: 100000, mode: 'paper' }), getIBKRPositions: async () => positions, getIBKROpenOrders: async () => [], getIBKRDayPnl: async () => 0,
    placeIBKROrder: async (_u, o) => { placed.push(o); return { status: 'placed', order_id: String(placed.length) }; }, cancelIBKROrder: async () => ({ ok: true }) };
}

test('the pure read: drift, the marketable limit, the guard; junk is null', () => {
  const r = at.requoteRead({ decisionPx: 500, freshPx: 500.40, capBps: 5 });
  assert.deepStrictEqual(r, { drift_bps: 8, cap_bps: 5, limit_px: 500.6502, would_refuse: true });
  const ok = at.requoteRead({ decisionPx: 500, freshPx: 500.10, capBps: 5 });
  assert.strictEqual(ok.would_refuse, false); assert.strictEqual(ok.drift_bps, 2);
  assert.strictEqual(at.requoteRead({ decisionPx: 0, freshPx: 500 }), null);
  assert.strictEqual(at.requoteRead({ decisionPx: 500, freshPx: null }), null);
});

test('shadow on: the buy places, the fresh quote bypasses the cache, the rows carry the guard and the limit verdicts', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'shadow'; process.env.TRADER_ENTRY_REQUOTE_CAP_BPS = '5';
  const b = bridge();
  const scanAt = new Date(Date.now() - 65000).toISOString();   // the scan's quote is 65 s old when the order goes out
  await at.runAutoTrade({ signals: [signal], timestamp: scanAt }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(b.placed.some((o) => o.side === 'buy' && o.ticker === 'QQQ' && o.type === 'market'), 'the market buy still places: a shadow never blocks');
  assert.ok(asked.some((a) => a.tickers[0] === 'QQQ' && a.opts && a.opts.fresh === true), 'the re-quote asked for a FRESH print');
  const rq = rows().find((r) => r.event === 'entry_requote');
  assert.ok(rq, 'entry_requote journaled');
  assert.strictEqual(rq.decision_px, 500); assert.strictEqual(rq.requote_px, 500.40);
  assert.strictEqual(rq.drift_bps, 8); assert.strictEqual(rq.would_refuse, true); assert.strictEqual(rq.limit_px, 500.6502);
  assert.ok(rq.decision_age_ms >= 60000 && rq.decision_age_ms < 120000, 'the decision quote s age is the scan s age');
  // the broker's basis arrives on the next pass: the fill row joins the re-quote numbers
  const b2 = bridge([{ symbol: 'QQQ', qty: 20, avg_entry_price: 500.30, current_price: 500.30 }]);
  await at.runAutoTrade({ signals: [] }, { bridge: b2, userId: 'u', now: NOW + 60000 });
  const f = rows().find((r) => r.event === 'entry_fill');
  assert.ok(f, 'entry_fill journaled');
  assert.strictEqual(f.delta_bps, 6); assert.strictEqual(f.requote_px, 500.40); assert.strictEqual(f.fill_vs_requote_bps, -2);
  assert.strictEqual(f.limit_would_fill, true); assert.strictEqual(f.would_refuse, true);
});

test('shadow on, a same-price fill still gets its fill row (the join needs it)', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'shadow';
  FRESH.QQQ = 500.00;
  await at.runAutoTrade({ signals: [signal] }, { bridge: bridge(), userId: 'u', now: NOW });
  await at.runAutoTrade({ signals: [] }, { bridge: bridge([{ symbol: 'QQQ', qty: 20, avg_entry_price: 500.00, current_price: 500 }]), userId: 'u', now: NOW + 60000 });
  const f = rows().find((r) => r.event === 'entry_fill');
  assert.ok(f, 'written even at the same price'); assert.strictEqual(f.delta_bps, 0); assert.strictEqual(f.limit_would_fill, true);
  FRESH.QQQ = 500.40;
});

test('no fresh quote: the buy places and the row says so', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'shadow';
  FRESH.QQQ = 0;
  const b = bridge();
  await at.runAutoTrade({ signals: [signal] }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(b.placed.some((o) => o.side === 'buy'));
  const rq = rows().find((r) => r.event === 'entry_requote');
  assert.ok(rq); assert.strictEqual(rq.requote_px, null); assert.strictEqual(rq.why, 'no fresh quote'); assert.strictEqual(rq.would_refuse, null);
  FRESH.QQQ = 500.40;
});

test('shadow off: no re-quote rows, no extra fill row, the buy places as before', async () => {
  reset();
  delete process.env.TRADER_ENTRY_REQUOTE;
  const b = bridge();
  await at.runAutoTrade({ signals: [signal] }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(b.placed.some((o) => o.side === 'buy'));
  assert.ok(!asked.some((a) => a.opts && a.opts.fresh), 'no fresh quote asked for');
  await at.runAutoTrade({ signals: [] }, { bridge: bridge([{ symbol: 'QQQ', qty: 20, avg_entry_price: 500.00, current_price: 500 }]), userId: 'u', now: NOW + 60000 });
  assert.strictEqual(rows().filter((r) => r.event === 'entry_requote').length, 0);
  assert.strictEqual(rows().filter((r) => r.event === 'entry_fill').length, 0, 'the legacy rule: a same-price fill writes nothing');
});

// ── REFUSE MODE (2026-10-07): the guard that acts ────────────────────────────────────────────────────────────────────
const skipsOf = (out) => (out && Array.isArray(out.skipped) ? out.skipped.map((s) => String(s.why || '')) : []).concat(rows().filter((r) => r.event === 'skip').map((r) => String(r.reason || '')));

test('refuse on: a quote that ran past the cap refuses the entry: no order, a skip naming the guard, an entry_requote row with refused true', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'refuse'; process.env.TRADER_ENTRY_REQUOTE_CAP_BPS = '5';
  FRESH.QQQ = 500.40;   // +8 bp past the 500 decision
  const b = bridge();
  const out = await at.runAutoTrade({ signals: [signal], timestamp: new Date(Date.now() - 65000).toISOString() }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(!b.placed.some((o) => o.side === 'buy'), 'no buy placed');
  assert.ok(asked.some((a) => a.tickers[0] === 'QQQ' && a.opts && a.opts.fresh === true), 'the fresh print was asked for, cache bypassed');
  const rq = rows().find((r) => r.event === 'entry_requote');
  assert.ok(rq, 'entry_requote journaled');
  assert.strictEqual(rq.mode, 'refuse'); assert.strictEqual(rq.refused, true); assert.strictEqual(rq.drift_bps, 8); assert.strictEqual(rq.would_refuse, true);
  assert.ok(rq.decision_age_ms >= 60000, 'the decision quote s age is journaled');
  assert.ok(skipsOf(out).some((w) => /requote_guard/.test(w)), 'the skip names the guard');
  assert.ok(!rows().some((r) => r.event === 'entry'), 'no entry row');
});

test('refuse on: a quote inside the cap places the buy and journals as the shadow does, in refuse mode', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'refuse';
  FRESH.QQQ = 500.10;   // +2 bp
  const b = bridge();
  const out = await at.runAutoTrade({ signals: [signal] }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(b.placed.some((o) => o.side === 'buy' && o.ticker === 'QQQ' && o.type === 'market'), 'the market buy places');
  const rq = rows().find((r) => r.event === 'entry_requote');
  assert.ok(rq); assert.strictEqual(rq.mode, 'refuse'); assert.strictEqual(rq.would_refuse, false); assert.strictEqual(rq.refused, undefined); assert.strictEqual(rq.drift_bps, 2);
  assert.ok(!skipsOf(out).some((w) => /requote_guard/.test(w)), 'no guard skip');
  FRESH.QQQ = 500.40;
});

test('refuse on, no fresh quote: no verdict, the buy places and the row says so', async () => {
  reset();
  process.env.TRADER_ENTRY_REQUOTE = 'refuse';
  FRESH.QQQ = 0;
  const b = bridge();
  await at.runAutoTrade({ signals: [signal] }, { bridge: b, userId: 'u', now: NOW });
  assert.ok(b.placed.some((o) => o.side === 'buy'), 'fails open: the buy places');
  const rq = rows().find((r) => r.event === 'entry_requote');
  assert.ok(rq); assert.strictEqual(rq.why, 'no fresh quote'); assert.strictEqual(rq.would_refuse, null);
  FRESH.QQQ = 500.40;
  delete process.env.TRADER_ENTRY_REQUOTE;
});
