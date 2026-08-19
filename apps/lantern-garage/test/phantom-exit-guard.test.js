'use strict';

/**
 * phantom-exit-guard.test.js — the external-close sweep must not invent exits
 * from a snapshot it cannot trust (2026-08-13).
 *
 * THE INCIDENT. At 09:30:00-09:31 the broker returned an empty/partial position
 * book for one scan cycle. The sweep infers "closed" from ABSENCE, so it wrote a
 * reconstructed exit for every symbol it had been tracking:
 *   - SOXS +$4,174 'closed_externally' on top of the REAL +$2,740 fill that
 *     arrived five minutes later (one 2,929-share order ever filled),
 *   - SQQQ +$86 'closed' while 1,566 shares were still held and stop-protected,
 *   - SPMO -$199 and XMMO -$107, which belong to the CHAMPION book, not this one.
 * The ledger read +$7,305 for a day the broker's equity FELL $4,634.
 *
 * Three defects, three guards, pinned here:
 *   1. a FAILED fetch was collapsed to [] — "errored" and "you hold nothing" are
 *      opposite facts;
 *   2. absence in an empty/implausible snapshot was treated as evidence of a
 *      close;
 *   3. every account position was tracked, including other engines'.
 */

const test = require('node:test');
const assert = require('node:assert');

// ── guard 1 + 2: when may the sweep run at all? ────────────────────────────
// Mirrors the production expression in runAutoTrade.
function sweepDecision({ positions, trackedSyms, heldQty = {} }) {
  const positionsOk = Array.isArray(positions);
  if (!positionsOk) return { tradeBlind: true, sweeps: [] };          // scan stands down
  const vanished = trackedSyms.filter((k) => !(Number(heldQty[k]) > 0));
  const suspect = (positions.length === 0 && trackedSyms.length > 0)
    || (vanished.length >= 3 && vanished.length > positions.length);
  return { tradeBlind: false, suspect, sweeps: suspect ? [] : vanished };
}

test('THE INCIDENT: an empty snapshot while tracking 4 positions reconstructs NOTHING', () => {
  const d = sweepDecision({ positions: [], trackedSyms: ['SOXS', 'SQQQ', 'GLD', 'TLT'] });
  assert.strictEqual(d.suspect, true);
  assert.deepStrictEqual(d.sweeps, [], 'the four phantom exits must not be written');
});

test('a FAILED fetch stands the whole scan down — never trade blind', () => {
  const d = sweepDecision({ positions: null, trackedSyms: ['SOXS'] });
  assert.strictEqual(d.tradeBlind, true,
    'an empty book would let the entry loop re-buy a symbol already held');
});

test('ONE symbol genuinely leaving a readable book still reconstructs', () => {
  // The case the sweep exists for: a resting stop filled overnight, book intact.
  const d = sweepDecision({
    positions: [{ symbol: 'SQQQ' }, { symbol: 'GLD' }, { symbol: 'TLT' }],
    trackedSyms: ['SOXS', 'SQQQ', 'GLD', 'TLT'],
    heldQty: { SQQQ: 1566, GLD: 265, TLT: 1413 },
  });
  assert.strictEqual(d.suspect, false);
  assert.deepStrictEqual(d.sweeps, ['SOXS'], 'a real external close must still be logged');
});

test('two vanishing from a healthy book is still trusted (not a mass glitch)', () => {
  const d = sweepDecision({
    positions: [{ symbol: 'GLD' }, { symbol: 'TLT' }, { symbol: 'SPY' }],
    trackedSyms: ['SOXS', 'SQQQ', 'GLD', 'TLT', 'SPY'],
    heldQty: { GLD: 1, TLT: 1, SPY: 1 },
  });
  assert.deepStrictEqual(d.sweeps.sort(), ['SOXS', 'SQQQ']);
});

test('three-plus vanishing while the book shrinks is a feed glitch, not closes', () => {
  const d = sweepDecision({
    positions: [{ symbol: 'GLD' }],
    trackedSyms: ['SOXS', 'SQQQ', 'TLT', 'SPY', 'GLD'],
    heldQty: { GLD: 1 },
  });
  assert.strictEqual(d.suspect, true);
  assert.deepStrictEqual(d.sweeps, []);
});

test('a genuinely flat book with nothing tracked is not suspect', () => {
  const d = sweepDecision({ positions: [], trackedSyms: [] });
  assert.strictEqual(d.suspect, false);
});

// ── guard 3: ownership — only track what THIS engine trades ────────────────
const ourSyms = (signals, ladderKeys = [], entryKeys = []) =>
  new Set([...signals.map((s) => s.symbol.toUpperCase()), ...ladderKeys, ...entryKeys]);
const tracked = (heldPos, our) => Object.keys(heldPos).filter((k) => !our.size || our.has(k));

test('champion-book positions are never tracked by the day-trader', () => {
  const our = ourSyms([{ symbol: 'SOXS' }, { symbol: 'SQQQ' }, { symbol: 'GLD' }]);
  const t = tracked({ SOXS: {}, SQQQ: {}, GLD: {}, SPMO: {}, XMMO: {} }, our);
  assert.deepStrictEqual(t.sort(), ['GLD', 'SOXS', 'SQQQ']);
  assert.ok(!t.includes('SPMO') && !t.includes('XMMO'),
    'SPMO/XMMO belong to the champion book — their P&L must never enter this ledger');
});

test('a position held across a restart is still ours via ladder/entry state', () => {
  // After a restart the scan may not have signalled it yet, but engine state proves it.
  const our = ourSyms([{ symbol: 'SPY' }], ['SOXS'], ['TLT']);
  const t = tracked({ SPY: {}, SOXS: {}, TLT: {}, XMMO: {} }, our);
  assert.deepStrictEqual(t.sort(), ['SOXS', 'SPY', 'TLT']);
});

test('an empty signal set disables the filter rather than tracking nothing', () => {
  // Fail-open: a scan that produced no signals must not orphan real positions.
  const t = tracked({ SOXS: {}, SQQQ: {} }, ourSyms([]));
  assert.deepStrictEqual(t.sort(), ['SOXS', 'SQQQ']);
});
