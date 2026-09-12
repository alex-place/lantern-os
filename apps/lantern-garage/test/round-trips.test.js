'use strict';
/**
 * test/round-trips.test.js — #3557.
 *
 * Turning a broker's fills into trades is the whole reason a manual trader's journal can
 * exist, so the arithmetic gets pinned hard. The cases that actually go wrong in a real
 * account are scale-ins, scale-outs, reversals through zero, shorts, and a feed that
 * arrives newest-first — plus the one that silently reports money that has not been made:
 * counting a position that is still open as a closed trade.
 *
 * Run: node --test apps/lantern-garage/test/round-trips.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { roundTrips, toLedgerRow } = require('../lib/round-trips');

let seq = 0;
const fill = (symbol, side, qty, price, at) => ({
  id: 'f' + (++seq), symbol, side, qty, price,
  at: at || '2026-09-0' + Math.min(9, 1 + (seq % 9)) + 'T14:30:00.000Z',
});
const at = (iso) => iso;

test('a buy and a sell is one trade', () => {
  const { trades, open } = roundTrips([
    fill('AAPL', 'buy', 10, 150, at('2026-09-01T14:30:00Z')),
    fill('AAPL', 'sell', 10, 155, at('2026-09-01T18:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1);
  assert.deepStrictEqual(open, []);
  const t = trades[0];
  assert.deepStrictEqual([t.symbol, t.side, t.qty, t.entry, t.exit], ['AAPL', 'long', 10, 150, 155]);
  assert.strictEqual(t.pnl, 50);
  assert.strictEqual(t.pnl_pct, 3.333333);
  assert.strictEqual(t.openedAt, '2026-09-01T14:30:00Z');
  assert.strictEqual(t.closedAt, '2026-09-01T18:00:00Z');
});

test('scaling in and out is ONE trade, at the weighted average of each side', () => {
  // The case FIFO lot-matching gets wrong for a human: a trader calls this one trade.
  const { trades } = roundTrips([
    fill('MSFT', 'buy', 10, 100, at('2026-09-01T14:00:00Z')),
    fill('MSFT', 'buy', 30, 110, at('2026-09-01T15:00:00Z')),   // avg entry 107.5 over 40
    fill('MSFT', 'sell', 20, 120, at('2026-09-01T16:00:00Z')),
    fill('MSFT', 'sell', 20, 130, at('2026-09-01T17:00:00Z')),  // avg exit 125 over 40
  ]);
  assert.strictEqual(trades.length, 1, 'four fills, one trade');
  const t = trades[0];
  assert.strictEqual(t.qty, 40);
  assert.strictEqual(t.entry, 107.5);
  assert.strictEqual(t.exit, 125);
  assert.strictEqual(t.pnl, 700, '(125 - 107.5) * 40');
  assert.deepStrictEqual([t.openFills, t.closeFills], [2, 2]);
});

test('a position still open at the end of the feed is NOT a trade', () => {
  // Journaling an open position books profit that has not happened.
  const { trades, open } = roundTrips([
    fill('NVDA', 'buy', 10, 100, at('2026-09-01T14:00:00Z')),
    fill('NVDA', 'sell', 4, 120, at('2026-09-01T15:00:00Z')),
  ]);
  assert.deepStrictEqual(trades, [], 'six shares are still at risk, so nothing closed');
  assert.strictEqual(open.length, 1);
  assert.deepStrictEqual([open[0].symbol, open[0].side, open[0].qty, open[0].entry], ['NVDA', 'long', 6, 100]);
});

test('closing the rest later closes the whole trade, once', () => {
  const { trades, open } = roundTrips([
    fill('NVDA', 'buy', 10, 100, at('2026-09-01T14:00:00Z')),
    fill('NVDA', 'sell', 4, 120, at('2026-09-01T15:00:00Z')),
    fill('NVDA', 'sell', 6, 130, at('2026-09-02T15:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].qty, 10);
  assert.strictEqual(trades[0].exit, 126, '(4*120 + 6*130) / 10');
  assert.strictEqual(trades[0].pnl, 260);
  assert.deepStrictEqual(open, []);
});

test('a short makes money when the price falls', () => {
  const { trades } = roundTrips([
    fill('TSLA', 'sell', 5, 200, at('2026-09-01T14:00:00Z')),
    fill('TSLA', 'buy', 5, 180, at('2026-09-01T16:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1);
  const t = trades[0];
  assert.strictEqual(t.side, 'short');
  assert.strictEqual(t.entry, 200);
  assert.strictEqual(t.exit, 180);
  assert.strictEqual(t.pnl, 100, 'entry minus exit, for a short');
  assert.ok(t.pnl_pct > 0, 'a profitable short is a positive percentage, not a negative one');
});

test('a fill that carries the position THROUGH zero closes one trade and opens the other way', () => {
  // Long 10, sell 15: that is a closed long AND a new short of 5, never one trade of 15.
  const { trades, open } = roundTrips([
    fill('SPY', 'buy', 10, 400, at('2026-09-01T14:00:00Z')),
    fill('SPY', 'sell', 15, 410, at('2026-09-01T15:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1);
  assert.deepStrictEqual([trades[0].side, trades[0].qty, trades[0].pnl], ['long', 10, 100]);
  assert.strictEqual(open.length, 1);
  assert.deepStrictEqual([open[0].side, open[0].qty, open[0].entry], ['short', 5, 410],
    'the leftover five opened a short at the same price');
});

test('a reversal that then closes produces two trades, priced separately', () => {
  const { trades, open } = roundTrips([
    fill('SPY', 'buy', 10, 400, at('2026-09-01T14:00:00Z')),
    fill('SPY', 'sell', 15, 410, at('2026-09-01T15:00:00Z')),
    fill('SPY', 'buy', 5, 405, at('2026-09-01T16:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 2);
  assert.deepStrictEqual([trades[0].side, trades[0].pnl], ['long', 100]);
  assert.deepStrictEqual([trades[1].side, trades[1].qty, trades[1].pnl], ['short', 5, 25], '(410 - 405) * 5');
  assert.deepStrictEqual(open, []);
});

test('two symbols do not contaminate each other', () => {
  const { trades } = roundTrips([
    fill('AAPL', 'buy', 10, 100, at('2026-09-01T14:00:00Z')),
    fill('MSFT', 'buy', 5, 200, at('2026-09-01T14:01:00Z')),
    fill('AAPL', 'sell', 10, 110, at('2026-09-01T15:00:00Z')),
    fill('MSFT', 'sell', 5, 190, at('2026-09-01T15:01:00Z')),
  ]);
  assert.strictEqual(trades.length, 2);
  const bySym = Object.fromEntries(trades.map((t) => [t.symbol, t]));
  assert.strictEqual(bySym.AAPL.pnl, 100);
  assert.strictEqual(bySym.MSFT.pnl, -50);
});

test('a feed that arrives newest-first is still matched in the order it happened', () => {
  // Alpaca's activities endpoint is direction=desc. Matching depends entirely on sequence.
  const chronological = [
    fill('AAPL', 'buy', 10, 100, at('2026-09-01T14:00:00Z')),
    fill('AAPL', 'sell', 10, 120, at('2026-09-01T15:00:00Z')),
  ];
  const { trades } = roundTrips(chronological.slice().reverse());
  assert.strictEqual(trades.length, 1);
  assert.deepStrictEqual([trades[0].entry, trades[0].exit, trades[0].pnl], [100, 120, 200],
    'reversed input must not turn a long into a short');
});

test('a sell with nothing open is a short, not an error and not a dropped fill', () => {
  const { trades, open } = roundTrips([fill('GME', 'sell', 3, 50, at('2026-09-01T14:00:00Z'))]);
  assert.deepStrictEqual(trades, []);
  assert.deepStrictEqual([open[0].side, open[0].qty], ['short', 3]);
});

test('unpriceable fills are dropped rather than guessed at', () => {
  const { trades, open } = roundTrips([
    { id: 'a', symbol: 'AAPL', side: 'buy', qty: 10, price: 0, at: '2026-09-01T14:00:00Z' },
    { id: 'b', symbol: 'AAPL', side: 'buy', qty: 0, price: 100, at: '2026-09-01T14:00:00Z' },
    { id: 'c', symbol: '', side: 'buy', qty: 10, price: 100, at: '2026-09-01T14:00:00Z' },
    { id: 'd', symbol: 'AAPL', side: 'hold', qty: 10, price: 100, at: '2026-09-01T14:00:00Z' },
    null,
    fill('AAPL', 'buy', 10, 100, at('2026-09-01T14:05:00Z')),
    fill('AAPL', 'sell', 10, 110, at('2026-09-01T15:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1, 'the one real round trip survives');
  assert.strictEqual(trades[0].pnl, 100, 'and the junk did not change its price');
  assert.deepStrictEqual(open, []);
});

test('nothing in, nothing out', () => {
  assert.deepStrictEqual(roundTrips([]), { trades: [], open: [] });
  assert.deepStrictEqual(roundTrips(null), { trades: [], open: [] });
});

test('fractional quantities survive the arithmetic', () => {
  const { trades, open } = roundTrips([
    fill('BRK', 'buy', 0.5, 100, at('2026-09-01T14:00:00Z')),
    fill('BRK', 'buy', 0.25, 120, at('2026-09-01T14:30:00Z')),
    fill('BRK', 'sell', 0.75, 130, at('2026-09-01T15:00:00Z')),
  ]);
  assert.strictEqual(trades.length, 1, 'floating point must still land back on zero');
  assert.strictEqual(trades[0].qty, 0.75);
  assert.deepStrictEqual(open, [], 'no phantom sliver left open');
});

test('the ledger row is the shape the journal already reads', () => {
  const { trades } = roundTrips([
    fill('AAPL', 'buy', 10, 150, at('2026-09-01T14:30:00Z')),
    fill('AAPL', 'sell', 10, 155, at('2026-09-01T18:00:00Z')),
  ]);
  const row = toLedgerRow(trades[0], 'u-1');
  assert.strictEqual(row.event, 'exit', 'the journal reads event:exit rows and nothing else');
  assert.deepStrictEqual([row.user, row.symbol, row.qty, row.entry, row.exit], ['u-1', 'AAPL', 10, 150, 155]);
  assert.strictEqual(row.pnl, 50);
  assert.strictEqual(row.status, 'filled', 'a broker fill is the most confirmed a row gets');
  assert.strictEqual(row.source, 'broker-import', 'and is always distinguishable from an autopilot row');
  assert.strictEqual(row.ts, '2026-09-01T18:00:00Z', 'a trade books on the day it closed');
  assert.strictEqual(row.stop_dist_pct, undefined,
    'a manual trade has no engine stop, so R must report it unmeasurable rather than invent one');
});

test('the trade id is stable, so importing twice cannot double-count', () => {
  const fills = [
    fill('AAPL', 'buy', 10, 150, at('2026-09-01T14:30:00Z')),
    fill('AAPL', 'sell', 10, 155, at('2026-09-01T18:00:00Z')),
  ];
  const a = roundTrips(fills).trades[0];
  const b = roundTrips(fills.slice().reverse()).trades[0];
  assert.ok(a.order_id, 'a closed trade is identified by its closing fill');
  assert.strictEqual(a.order_id, b.order_id, 'and that does not depend on the order the feed arrived in');
});

test('over thousands of random accounts, total P&L equals raw cash flow', () => {
  /* The strongest statement available about a matcher: if every position ends flat, the
     sum of the trades it produced MUST equal money out minus money in. Nothing about
     lots, averaging or reversals can hide inside that identity. Fills are shuffled before
     matching, so ordering is under test too. Seeded, so a failure is reproducible. */
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const SYMS = ['AAA', 'BBB', 'CCC'];
  let mismatches = 0, leftOpen = 0, tradesSeen = 0;

  for (let run = 0; run < 2000; run++) {
    const fills = [];
    const pos = {};
    const n = 2 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const symbol = SYMS[Math.floor(rnd() * SYMS.length)];
      const side = rnd() < 0.5 ? 'buy' : 'sell';
      const qty = 1 + Math.floor(rnd() * 20);
      const price = 10 + Math.round(rnd() * 5000) / 10;
      fills.push({ id: 'f' + i, symbol, side, qty, price, at: new Date(1788000000000 + i * 60000).toISOString() });
      pos[symbol] = (pos[symbol] || 0) + (side === 'buy' ? qty : -qty);
    }
    let k = 0;
    for (const symbol of Object.keys(pos)) {          // flatten everything
      if (!pos[symbol]) continue;
      fills.push({
        id: 'z' + (k++), symbol, side: pos[symbol] > 0 ? 'sell' : 'buy', qty: Math.abs(pos[symbol]),
        price: 10 + Math.round(rnd() * 5000) / 10, at: new Date(1788000000000 + (n + k) * 60000).toISOString(),
      });
    }
    const cash = fills.reduce((a, f) => a + (f.side === 'sell' ? 1 : -1) * f.qty * f.price, 0);
    const { trades, open } = roundTrips(fills.slice().sort(() => rnd() - 0.5));
    tradesSeen += trades.length;
    if (open.length) leftOpen++;
    if (Math.abs(trades.reduce((a, t) => a + t.pnl, 0) - cash) > 0.02) mismatches++;
  }
  assert.strictEqual(leftOpen, 0, 'every account was flattened, so nothing may be left open');
  assert.strictEqual(mismatches, 0, 'P&L must equal cash flow');
  assert.ok(tradesSeen > 2000, 'the fuzz actually produced trades to check (' + tradesSeen + ')');
});

test('trades come back oldest close first', () => {
  const { trades } = roundTrips([
    fill('A', 'buy', 1, 10, at('2026-09-03T14:00:00Z')),
    fill('A', 'sell', 1, 11, at('2026-09-03T15:00:00Z')),
    fill('B', 'buy', 1, 10, at('2026-09-01T14:00:00Z')),
    fill('B', 'sell', 1, 11, at('2026-09-01T15:00:00Z')),
  ]);
  assert.deepStrictEqual(trades.map((t) => t.symbol), ['B', 'A']);
});
