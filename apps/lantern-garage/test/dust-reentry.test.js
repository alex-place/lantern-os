'use strict';

/**
 * dust-reentry.test.js — dust must not strand a symbol (2026-08-10).
 *
 * Live incident: the 0.8-share SOXS remnant ($34, fractional, IBKR refuses the
 * sell) made the entry gate's `held > 0 → 'already long'` PERMANENT for SOXS —
 * the slot fix excluded dust from the concurrency CAP but not from the
 * per-symbol gate, so SOXS's +2.7% washout was unenterable all morning.
 *
 * Contract: (1) a dust holding does not block re-entry; (2) exits and stops on
 * a rebuilt position floor to WHOLE shares, so the sub-share tail stays inert
 * instead of re-stranding the symbol on the next exit.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production entry-gate expressions in auto-trader.js.
function entryBlocked({ held, marketValue, price, equity, dustPct }) {
  const mv = Math.abs(Number(marketValue) || held * (Number(price) || 0));
  const isDust = held > 0 && dustPct > 0 && mv < equity * (dustPct / 100);
  return held > 0 && !isDust;
}

test('the exact SOXS remnant: 0.8 shares / $34 does NOT block re-entry', () => {
  assert.strictEqual(entryBlocked({ held: 0.8, marketValue: 34.12, equity: 958488, dustPct: 0.1 }), false);
});

test('a real position still blocks re-entry (never pyramid)', () => {
  assert.strictEqual(entryBlocked({ held: 39, marketValue: 28143, equity: 958488, dustPct: 0.1 }), true);
});

test('dustPct=0 disables the dust carve-out — any holding blocks', () => {
  assert.strictEqual(entryBlocked({ held: 0.8, marketValue: 34.12, equity: 958488, dustPct: 0 }), true);
});

test('market_value falls back to qty x price when the broker omits it', () => {
  assert.strictEqual(entryBlocked({ held: 0.8, price: 42.65, equity: 958488, dustPct: 0.1 }), false);
  assert.strictEqual(entryBlocked({ held: 300, price: 42.65, equity: 958488, dustPct: 0.1 }), true);
});

test('the dust threshold scales with equity', () => {
  // $500 on $100k is a real position (0.5% > 0.1%); on $958k it is dust.
  assert.strictEqual(entryBlocked({ held: 10, marketValue: 500, equity: 100000, dustPct: 0.1 }), true);
  assert.strictEqual(entryBlocked({ held: 10, marketValue: 500, equity: 958488, dustPct: 0.1 }), false);
});

// Mirrors the whole-share flooring in closeLong and the stop placements.
const wholeShareQty = (q) => (Number(q) >= 1 ? Math.floor(Number(q)) : Number(q));

test('a rebuilt 300.8-share position exits 300 whole shares', () => {
  assert.strictEqual(wholeShareQty(300.8), 300);
});

test('a clean integer position is untouched', () => {
  assert.strictEqual(wholeShareQty(191), 191);
});

test('a sub-share position keeps its raw qty (unclosable-freeze territory, not flooring-to-zero)', () => {
  assert.strictEqual(wholeShareQty(0.8), 0.8, 'flooring 0.8 to 0 would silently skip the exit attempt');
});
