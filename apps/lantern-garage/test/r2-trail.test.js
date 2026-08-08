'use strict';

/**
 * r2-trail.test.js — the runner trails past R2 instead of selling at it.
 *
 * Lab gate (2026-08-08, Monday live config — IBS entries, 5% floor, 3:1,
 * ladder, 3bp): trail OOS +0.733%/trade vs +0.328 selling at R2; fit +0.548
 * vs +0.243; WR flat (~78%). Live motivation: QQQ 2026-08-07 sold its runner
 * at the 720.85 R2 target and price closed at 723.03, at the top of its range.
 *
 * These tests exercise the ladder-state transitions as pure logic, mirroring
 * the production expressions in auto-trader.js.
 */

const test = require('node:test');
const assert = require('node:assert');

// Mirrors the production R2 branch.
function step(lad, cur, { r2Trail, r2TrailPct }) {
  if (lad.broke2) {
    lad.peak2 = Math.max(lad.peak2 || lad.r2, cur);
    lad.floor2 = Math.max(lad.floor2 || lad.r2, lad.peak2 * (1 - r2TrailPct / 100));
    if (cur <= lad.floor2) return { action: 'sell', why: 'r2_trail' };
    return { action: 'hold' };
  }
  if (lad.r2 > 0 && cur >= lad.r2) {
    if (r2Trail) {
      lad.broke2 = true; lad.peak2 = cur;
      lad.floor2 = Math.max(lad.r2, cur * (1 - r2TrailPct / 100));
      return { action: 'hold', why: 'upgraded' };
    }
    return { action: 'sell', why: 'zone_r2' };
  }
  if (cur <= lad.r1) return { action: 'sell', why: 'zone_r1_floor' };
  return { action: 'hold' };
}

const CFG = { r2Trail: 1, r2TrailPct: 1 };

test('flag off: reaching R2 still sells at the target (unchanged behavior)', () => {
  const lad = { r1: 100, r2: 105, broke: true };
  assert.deepStrictEqual(step(lad, 105.2, { r2Trail: 0, r2TrailPct: 1 }), { action: 'sell', why: 'zone_r2' });
});

test('flag on: breaking R2 upgrades to a trail instead of selling', () => {
  const lad = { r1: 100, r2: 105, broke: true };
  const r = step(lad, 105.2, CFG);
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(lad.broke2, true);
  assert.ok(lad.floor2 >= 105, 'floor starts at or above R2 — the target gain is locked');
});

test('the QQQ 2026-08-07 shape: trail rides 720.85 -> 723 instead of selling at R2', () => {
  const lad = { r1: 715.06, r2: 718.985, broke: true };
  assert.strictEqual(step(lad, 719.2, CFG).action, 'hold');   // broke R2
  assert.strictEqual(step(lad, 720.85, CFG).action, 'hold');  // old code sold HERE
  assert.strictEqual(step(lad, 722.5, CFG).action, 'hold');
  assert.strictEqual(step(lad, 723.6, CFG).action, 'hold');   // ride to the day high
  // 1% give-back from peak 723.6 -> floor 716.36... but floor also never drops:
  const r = step(lad, 716.0, CFG);
  assert.strictEqual(r.action, 'sell');
  assert.strictEqual(r.why, 'r2_trail');
  assert.ok(lad.floor2 > 718.985 - 1e-9 || lad.floor2 >= 723.6 * 0.99 - 1e-9, 'exit at the ratcheted floor');
});

test('the floor RATCHETS: a new peak raises it, a dip never lowers it', () => {
  const lad = { r1: 100, r2: 105, broke: true };
  step(lad, 105.5, CFG);
  step(lad, 108, CFG);
  const f1 = lad.floor2;
  step(lad, 107.5, CFG);          // dip that does not tag the floor
  assert.strictEqual(lad.floor2, f1, 'floor must not move down');
  step(lad, 110, CFG);
  assert.ok(lad.floor2 > f1, 'new peak must raise the floor');
});

test('the floor never sits below R2 — the banked target gain cannot round-trip', () => {
  const lad = { r1: 100, r2: 105, broke: true };
  step(lad, 105.01, CFG);          // barely through; 1% below 105.01 would be < R2
  assert.ok(lad.floor2 >= 105, `floor ${lad.floor2} must be >= R2 105`);
});

test('a tag of the trail floor sells', () => {
  const lad = { r1: 100, r2: 105, broke: true };
  step(lad, 107, CFG);
  const r = step(lad, lad.floor2 - 0.01, CFG);
  assert.strictEqual(r.action, 'sell');
  assert.strictEqual(r.why, 'r2_trail');
});
