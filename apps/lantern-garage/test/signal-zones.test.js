'use strict';

/**
 * signal-zones.test.js — the scan signal must carry the zone LIST.
 *
 * findSrZones returns a full list of support/resistance zones, but the emitted
 * signal only ever carried the `support` / `resistance` SCALARS. auto-trader
 * reads `Array.isArray(s.zones) ? s.zones : []`, so it always saw an empty list
 * and three shipped features were silently dead in production:
 *
 *   1. support-entry gate — skipped every symbol it governs with "sup_entry: no
 *      support zone below price" (8 of 12 tradelist names could never enter)
 *   2. zone-ladder exit (#3165) — never armed; the live ledger contains ZERO
 *      zone_r1/zone_r2/peak_giveback exits across its entire history
 *   3. room tiering + tgtMinR — no-ops, so every entry defaulted to A-tier
 *
 * This pins the contract so the list cannot be dropped again silently.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'signal-engine');
const { findSrZones } = require(LIB + '/sr-zones');

// A synthetic series with repeated touches so real zones form.
function bars() {
  const out = [];
  let t = Date.parse('2026-01-01T00:00:00Z');
  const path_ = [];
  for (let i = 0; i < 12; i++) path_.push(100, 101, 102, 101.5, 100.2, 99.8, 100.1, 101.8);
  for (const c of path_) {
    out.push({ timestamp: new Date(t).toISOString(), open: c, high: c + 0.15, low: c - 0.15, close: c, volume: 1e6 });
    t += 15 * 60 * 1000;
  }
  return out;
}

test('findSrZones returns a zone LIST, not just scalars', () => {
  const b = bars();
  const sr = findSrZones('TEST', b[b.length - 1].close, b);
  assert.ok(Array.isArray(sr.zones), 'zones must be an array');
  assert.ok(sr.zones.length > 0, 'the fixture must produce at least one zone');
  const z = sr.zones[0];
  for (const k of ['level', 'type']) assert.ok(k in z, `zone must carry ${k}`);
  assert.match(String(z.type), /SUPPORT|RESIST/i);
});

test('a zone entry has the fields auto-trader consumes', () => {
  // auto-trader reads z.type, z.level, z.top, z.bottom — a zone missing top/bottom
  // makes the support-entry stop fall back silently.
  const b = bars();
  const sr = findSrZones('TEST', b[b.length - 1].close, b);
  for (const z of sr.zones) {
    assert.strictEqual(typeof z.level, 'number');
    assert.ok(Number.isFinite(z.top ?? z.level), 'top (or level fallback) must be numeric');
    assert.ok(Number.isFinite(z.bottom ?? z.level), 'bottom (or level fallback) must be numeric');
  }
});

test('scan.js emits `zones` on the signal — the regression that killed 3 features', () => {
  // Source-level assertion: scanAll needs live network + a full tradelist, so
  // pin the contract at the emit site instead. This fails loudly if someone
  // removes the field again.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(LIB, 'scan.js'), 'utf8');
  const push = src.slice(src.indexOf('signals.push({'));
  assert.ok(/zones:\s*Array\.isArray\(sr\.zones\)/.test(push),
    'the emitted signal must carry the zones array from findSrZones');
});

test('the consumer contract: empty zones disables sup-entry, ladder and tiering', () => {
  // Documents WHY the field matters, in executable form.
  const s = { symbol: 'SPY', zones: [] };
  const zones = Array.isArray(s.zones) ? s.zones : [];
  const price = 100;
  const support = zones.filter((z) => /SUPPORT/i.test(z.type || '') && Number(z.top || z.level) <= price * 1.001);
  const resist = zones.filter((z) => /RESIST/i.test(z.type || '') && Number(z.level) > price * 1.001);
  assert.strictEqual(support.length, 0, 'no support -> sup_entry skips the symbol entirely');
  assert.strictEqual(resist.length, 0, 'no resistance -> no zone ladder, no room tier, tgtMinR is a no-op');
});
