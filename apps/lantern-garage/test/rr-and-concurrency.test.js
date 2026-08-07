'use strict';

/**
 * rr-and-concurrency.test.js — RR by construction + the concurrent-position cap.
 *
 * 1) STOP FROM TARGET. Stop and target used to be chosen independently (stop
 *    under the support zone, target wherever R1 landed), so RR was an accident:
 *    live 2026-08-06 produced targets of 0.53R-1.62R — winners paying less than
 *    the 1R they risked. Deriving the stop as targetDistance/n makes RR exactly
 *    n:1, and lets the stop scale with the size of the opportunity.
 *
 * 2) CONCURRENT CAP. Portfolio replay of the holdout showed every worst day
 *    pinned at exactly -9.00% = 3 positions x the 3% stop floor. The left tail
 *    is concurrency x stop width. Cap 2 cut days worse than -5% by 15% while
 *    average %/trade slightly improved.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production expressions in auto-trader.js.
function effectiveStopPct({ price, resistLevel, stopFromTgt, stopMinPct, structuralPct }) {
  if (!(stopFromTgt > 0) || !resistLevel) return structuralPct;
  const tgtPct = ((resistLevel - price) / price) * 100;
  return Math.min(15, Math.max(stopMinPct, tgtPct / stopFromTgt));
}

test('3:1 — stop is one third of the distance to first resistance', () => {
  // 9% to target -> 3% stop -> exactly 3:1.
  const pct = effectiveStopPct({ price: 100, resistLevel: 109, stopFromTgt: 3, stopMinPct: 0.2, structuralPct: 0.5 });
  assert.ok(Math.abs(pct - 3) < 1e-9, `expected 3%, got ${pct}`);
  assert.ok(Math.abs((9 / pct) - 3) < 1e-9, 'reward:risk must be exactly 3:1');
});

test('a BIG expected move earns a WIDER stop — the stop scales with opportunity', () => {
  const small = effectiveStopPct({ price: 100, resistLevel: 103, stopFromTgt: 3, stopMinPct: 0.2, structuralPct: 0.5 });
  const big = effectiveStopPct({ price: 100, resistLevel: 115, stopFromTgt: 3, stopMinPct: 0.2, structuralPct: 0.5 });
  assert.ok(big > small, 'a further target must produce a wider stop');
  assert.ok(Math.abs(big - 5) < 1e-9, '15% target / 3 = 5% stop');
});

test('the minimum-stop floor still wins over a derived stop', () => {
  // Target only 1.5% away -> 0.5% derived, but the 3% floor must dominate so the
  // stop never lands back inside the noise band.
  const pct = effectiveStopPct({ price: 100, resistLevel: 101.5, stopFromTgt: 3, stopMinPct: 3, structuralPct: 0.5 });
  assert.strictEqual(pct, 3, 'floor must override a too-tight derived stop');
});

test('no resistance above -> keep the structural stop (nothing to derive from)', () => {
  const pct = effectiveStopPct({ price: 100, resistLevel: null, stopFromTgt: 3, stopMinPct: 3, structuralPct: 4.2 });
  assert.strictEqual(pct, 4.2);
});

test('stopFromTgt=0 disables derivation', () => {
  const pct = effectiveStopPct({ price: 100, resistLevel: 109, stopFromTgt: 0, stopMinPct: 3, structuralPct: 0.5 });
  assert.strictEqual(pct, 0.5);
});

test('derived stops are capped at 15% — a runaway target cannot size the account into one trade', () => {
  const pct = effectiveStopPct({ price: 100, resistLevel: 200, stopFromTgt: 3, stopMinPct: 3, structuralPct: 0.5 });
  assert.strictEqual(pct, 15);
});

// ── concurrency cap ─────────────────────────────────────────────────────────
const openCount = (held) => Object.values(held).filter((p) => Math.abs(Number(p.qty) || 0) > 0).length;
const blocked = (held, cap) => cap > 0 && openCount(held) >= cap;

test('cap 2: a third simultaneous position is refused', () => {
  const held = { SPY: { qty: 10 }, QQQ: { qty: 5 } };
  assert.strictEqual(blocked(held, 2), true);
});

test('cap 2: a second position is allowed', () => {
  assert.strictEqual(blocked({ SPY: { qty: 10 } }, 2), false);
});

test('flat (qty 0) positions do not consume a slot', () => {
  // A closed position can linger in the book with qty 0 — it must not block.
  const held = { SPY: { qty: 0 }, QQQ: { qty: 0 }, GLD: { qty: 3 } };
  assert.strictEqual(openCount(held), 1);
  assert.strictEqual(blocked(held, 2), false);
});

test('cap 0 disables the limit', () => {
  const held = { A: { qty: 1 }, B: { qty: 1 }, C: { qty: 1 }, D: { qty: 1 } };
  assert.strictEqual(blocked(held, 0), false);
});

test('the tail arithmetic this exists to bound: concurrency x stop width', () => {
  // Every worst day in the holdout replay was exactly -9.00%.
  assert.strictEqual(3 * 3, 9, '3 concurrent positions x 3% stop floor = the -9% worst day');
  assert.strictEqual(2 * 3, 6, 'cap 2 bounds the same-day stop-out cluster to -6%');
});
