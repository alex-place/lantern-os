'use strict';
// #2983 — the demo book must value its positions at the SAME live quotes the watchlist uses, so
// the two surfaces can't show two prices for one symbol. champion-demo.positions(quotes) honors a
// passed quote (and falls back to the baked mark per-symbol); positionsLive() is the wrapper
// broker-facade now calls to pull those quotes from the live Yahoo feed.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const demo = require(path.join(__dirname, '..', 'lib', 'champion-demo'));

const bySym = (snap, sym) => snap.positions.find((p) => p.symbol === sym);

test('with no quotes, positions use the baked static marks (the pre-fix behavior)', () => {
  const tlt = bySym(demo.positions(), 'TLT');
  assert.strictEqual(tlt.current_price, 88.10); // the $88.10 the issue computed from market_value/qty
});

test('a passed live quote marks that symbol at the live price, and re-derives value + P&L from it', () => {
  const snap = demo.positions({ TLT: { price: 83.70, chg_pct: -0.5 } });
  const tlt = bySym(snap, 'TLT');
  assert.strictEqual(tlt.current_price, 83.70);                 // live, not 88.10
  assert.strictEqual(tlt.market_value, Math.round(tlt.qty * 83.70 * 100) / 100);
  // P&L is now off the LIVE mark, not the stale one.
  assert.ok(tlt.unrealized_pl < 0 && tlt.pnl_pct < 0);
});

test('a symbol with no quote falls back to its baked mark (partial feed never blanks the book)', () => {
  const snap = demo.positions({ TLT: { price: 83.70 } }); // only TLT quoted
  assert.strictEqual(bySym(snap, 'SPY').current_price, 743.29); // SPY baked, untouched
});

test('positionsLive() returns the full book with an account and never throws (network-agnostic)', async () => {
  const snap = await demo.positionsLive(); // hits Yahoo, or falls back to baked on any error
  assert.strictEqual(snap.positions.length, 8);
  assert.ok(snap.account && Number.isFinite(Number(snap.account.equity)));
  assert.strictEqual(snap.demo, true);
});
