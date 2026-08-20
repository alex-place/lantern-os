'use strict';
/**
 * leverage-visibility.test.js — MEASURE leveraged concentration; do not cap it
 * (#3354).
 *
 * 2026-08-18: SMH (12.1% of equity, 1x) and SOXL (6.0% notional, 3x = 18.1%
 * beta-adjusted) were entered in the same minute, putting 30.2% of the book in
 * semis. Semis fell 4.33% and those two produced 67% of the day's -$5,925.72.
 * Nothing reported that exposure: instrumentSign() carried {family, sign} only,
 * and maxGrossPct measures NOTIONAL, so a 3x wrapper reads at a third of the
 * risk it carries.
 *
 * No cap ships, and that is a measured decision, not an omission:
 *   - 3x round trips (2026-08): n=17, +$7,647, +0.714%/trade on notional;
 *     1x: n=59, +$2,991, +0.057%. Leverage is where the edge lives.
 *   - The two HIGHEST-concentration sessions were the two best days — SOXS alone
 *     at 53.7% beta on 8/13 (+$2,145) and 8/14 (+$6,803).
 *   - Every cap level in the observed range removes more profit than loss.
 * So: publish the number, let a human decide.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const dl = require('../lib/direction-lock');
const { buildSessionRecord } = require('../lib/session-record');

test('leverage magnitudes are correct and default to 1x', () => {
  for (const [s, l] of [['SOXL', 3], ['SOXS', 3], ['TQQQ', 3], ['SQQQ', 3], ['SPXL', 3],
                        ['TNA', 3], ['TZA', 3], ['SSO', 2], ['QID', 2],
                        ['SMH', 1], ['SPY', 1], ['GLD', 1], ['ZZZZ', 1]])
    assert.strictEqual(dl.leverageOf(s), l, `${s} should be ${l}x`);
});

test('leverage is a MAGNITUDE — an inverse 3x is 3, not -3 (sign stays separate)', () => {
  assert.strictEqual(dl.leverageOf('SOXS'), 3);
  assert.strictEqual(dl.instrumentSign('SOXS').sign, -1, 'direction still lives in sign');
});

test('the live 2026-08-18 book reproduces 30.2% semis', () => {
  const positions = [
    { symbol: 'SMH', qty: 203, market_value: 116770 },
    { symbol: 'SOXL', qty: 433, market_value: 58376 },
  ];
  const beta = dl.familyBetaNotional(positions);
  assert.ok(Math.abs(beta.SOX - 291898) < 1, `got ${beta.SOX}`);
  assert.ok(Math.abs((beta.SOX / 967210) * 100 - 30.2) < 0.1, 'the exposure nobody could see');
  // the notional view — what the gross cap actually saw — is barely half
  const notional = 116770 + 58376;
  assert.ok((notional / 967210) * 100 < 19, 'notional reads 18.1%, hiding 12 points of risk');
});

test('dust is excluded, matching familyExposure', () => {
  const beta = dl.familyBetaNotional([{ symbol: 'SOXS', qty: 0.8, market_value: 35 }]);
  assert.strictEqual(Object.keys(beta).length, 0);
});

test('the session record PUBLISHES the exposure with a max, so it is greppable', () => {
  const rec = buildSessionRecord({
    ledgerText: '', now: Date.parse('2026-08-18T20:10:00Z'),
    account: { equity: 967210, cash: 400000 },
    positions: [
      { symbol: 'SMH', qty: 203, market_value: 116770, unrealized_pl: -1557 },
      { symbol: 'SOXL', qty: 433, market_value: 58376, unrealized_pl: 0 },
      { symbol: 'SPY', qty: 76, market_value: 58400, unrealized_pl: -395 },
    ],
    dayPnl: {},
  });
  const fx = rec.family_beta_exposure;
  assert.ok(fx, 'exposure must be present');
  assert.ok(Math.abs(fx.pct_of_equity.SOX - 30.2) < 0.1, `SOX ${fx.pct_of_equity.SOX}`);
  assert.ok(Math.abs(fx.pct_of_equity.SPY - 6.0) < 0.2, 'a 1x position reports its plain notional');
  assert.ok(Math.abs(fx.max_pct - 30.2) < 0.1, 'max_pct is the one number to alert on');
});

test('NO CAP: a 53.7% single-wrapper book still records, never blocks', () => {
  // SOXS alone on 8/13 and 8/14 — the two best days on record.
  const rec = buildSessionRecord({
    ledgerText: '', now: Date.parse('2026-08-14T20:10:00Z'),
    account: { equity: 970000 },
    positions: [{ symbol: 'SOXS', qty: 4500, market_value: 173700, unrealized_pl: 0 }],
    dayPnl: {},
  });
  assert.ok(rec.family_beta_exposure.max_pct > 50, 'recorded in full');
  assert.strictEqual(rec.family_beta_exposure.pct_of_equity.SOX > 50, true);
});

test('stop attribution by PRICE: the SOXL exit the reason string missed', () => {
  const L = [
    JSON.stringify({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'SOXL', qty: 433, entry: 134.817, stop: 130.77 }),
    JSON.stringify({ ts: '2026-08-18T13:49:00Z', event: 'exit', symbol: 'SOXL', qty: 433, entry: 136.38, exit: 130.76, pnl: -2432.84, reason: 'broker fill' }),
  ].join('\n');
  const rec = buildSessionRecord({ ledgerText: L, now: Date.parse('2026-08-18T20:10:00Z'), account: { equity: 967210 }, positions: [], dayPnl: {} });
  assert.strictEqual(rec.stops_fired, 0, 'the reason string genuinely does not say stop');
  assert.strictEqual(rec.stops_by_price, 1, 'but it printed through the stop — that is a stop fill');
  assert.strictEqual(rec.stops_total, 1, '"0 stop-outs" was never true');
  assert.ok(Math.abs(rec.stops_by_price_pnl - -2432.84) < 0.01);
});

test('an exit well ABOVE its stop is not miscounted as a stop', () => {
  const L = [
    JSON.stringify({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'GLD', qty: 290, entry: 399.76, stop: 387.77 }),
    JSON.stringify({ ts: '2026-08-18T18:00:00Z', event: 'exit', symbol: 'GLD', qty: 290, exit: 404.10, pnl: 1258, reason: 'zone ladder R1' }),
  ].join('\n');
  const rec = buildSessionRecord({ ledgerText: L, now: Date.parse('2026-08-18T20:10:00Z'), account: { equity: 967210 }, positions: [], dayPnl: {} });
  assert.strictEqual(rec.stops_by_price, 0);
  assert.strictEqual(rec.stops_total, 0);
});

test('a reason-matched stop is not double counted', () => {
  const L = [
    JSON.stringify({ ts: '2026-08-18T13:30:00Z', event: 'entry', symbol: 'QQQ', qty: 80, entry: 730, stop: 708 }),
    JSON.stringify({ ts: '2026-08-18T18:00:00Z', event: 'exit', symbol: 'QQQ', qty: 80, exit: 707.5, pnl: -1800, reason: 'stop hit' }),
  ].join('\n');
  const rec = buildSessionRecord({ ledgerText: L, now: Date.parse('2026-08-18T20:10:00Z'), account: { equity: 967210 }, positions: [], dayPnl: {} });
  assert.strictEqual(rec.stops_fired, 1);
  assert.strictEqual(rec.stops_by_price, 0, 'already counted by reason — not counted twice');
  assert.strictEqual(rec.stops_total, 1);
});
