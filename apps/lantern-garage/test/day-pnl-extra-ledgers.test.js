'use strict';
/**
 * day-pnl-extra-ledgers.test.js — an account with more than one writer (2026-09-28).
 *
 * The day panel is computed from the trade ledger. One ledger is right while one
 * process trades the account. The two-sleeve engine journals each sleeve to its
 * own file and the server on the account's port trades nothing, so that server's
 * own ledger had no entry and no exit for the session. Live 2026-09-28 the page
 * showed -$263 on a +$901 day: SMH, bought that morning, was charged the whole
 * move from Friday's close (its ledger held SMH entries from weeks earlier, so
 * the unknown-lot rule did not apply), and the engine's realized was not counted.
 *
 * TRADER_TRADES_LOG_EXTRA names the other ledgers. These pin: unset = unchanged;
 * only entry/exit rows are merged; nothing is counted twice; unreadable files
 * degrade instead of breaking; and the live case computes the right day.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeDayPnl, readTradesLedger, tradesLedgerSources, extraTradesLogs } = require('../lib/day-pnl');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dpl-extra-'));
const PRIMARY = path.join(DIR, 'autopilot-trades.jsonl');
const S = path.join(DIR, 'S.autopilot-trades.jsonl');
const R = path.join(DIR, 'R.autopilot-trades.jsonl');
const row = (o) => JSON.stringify(o);
const NOW = Date.parse('2026-09-28T18:00:00.000Z');   // Monday 14:00 ET, session live

// the server's own ledger: it traded SMH weeks ago, nothing today
fs.writeFileSync(PRIMARY, [
  row({ ts: '2026-09-10T15:00:00.000Z', event: 'entry', symbol: 'SMH', qty: 10, entry: 580 }),
  row({ ts: '2026-09-10T17:00:00.000Z', event: 'exit', symbol: 'SMH', qty: 10, entry: 580, exit: 585, pnl: 50, order_id: 'old-1' }),
  row({ ts: '2026-09-28T15:00:00.000Z', event: 'scan_timing', ms: 12 }),
].join('\n') + '\n');
// the engine's two sleeves
fs.writeFileSync(S, [
  row({ ts: '2026-09-28T15:09:41.000Z', event: 'entry', symbol: 'TLT', qty: 85, entry: 78.385 }),
  row({ ts: '2026-09-28T16:28:04.000Z', event: 'exit', symbol: 'TLT', qty: 85, entry: 78.39, exit: 78.76, pnl: 31.45, order_id: 'tlt-1' }),
  row({ ts: '2026-09-28T15:30:00.000Z', event: 'skip', symbol: '*', reason: 'noise the merge must not carry' }),
].join('\n') + '\n');
fs.writeFileSync(R, [
  row({ ts: '2026-09-23T15:36:00.000Z', event: 'entry', symbol: 'GLD', qty: 9, entry: 392.89 }),
  row({ ts: '2026-09-28T13:31:00.000Z', event: 'exit', symbol: 'GLD', qty: 6, entry: 392.79, exit: 379.47, pnl: -79.91, order_id: 'gld-1' }),
  row({ ts: '2026-09-28T14:57:59.000Z', event: 'entry', symbol: 'SMH', qty: 25, entry: 594.095 }),
].join('\n') + '\n');

const withEnv = (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
};
const count = (text, needle) => text.split(needle).length - 1;

test('unset: the primary ledger, byte for byte, exactly as before', () => {
  withEnv({ TRADER_TRADES_LOG: null, TRADER_TRADES_LOG_EXTRA: null }, () => {
    assert.deepStrictEqual(extraTradesLogs(), []);
    assert.strictEqual(readTradesLedger(DIR), fs.readFileSync(PRIMARY, 'utf8'));
    assert.deepStrictEqual(tradesLedgerSources(DIR), { primary: PRIMARY, extras: [] });
  });
});

test('extras: entry/exit rows are merged, other rows are not', () => {
  withEnv({ TRADER_TRADES_LOG: null, TRADER_TRADES_LOG_EXTRA: `${S} ; ${R}` }, () => {
    assert.deepStrictEqual(tradesLedgerSources(DIR).extras, [path.resolve(S), path.resolve(R)]);
    const text = readTradesLedger(DIR);
    assert.ok(text.startsWith(fs.readFileSync(PRIMARY, 'utf8')), 'the primary text leads, untouched');
    assert.strictEqual(count(text, '"symbol":"TLT"'), 2, 'TLT entry + exit');
    assert.strictEqual(count(text, '"order_id":"gld-1"'), 1);
    assert.strictEqual(count(text, '"symbol":"SMH"'), 3, 'the old SMH pair + today\'s engine entry');
    assert.strictEqual(count(text, 'noise the merge must not carry'), 0);
    for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);   // still one JSON row per line
  });
});

test('a fill journaled in two ledgers is counted once', () => {
  const dupPrimary = path.join(DIR, 'dup.jsonl');
  fs.writeFileSync(dupPrimary, fs.readFileSync(S, 'utf8'));   // the same rows the extra holds
  withEnv({ TRADER_TRADES_LOG: dupPrimary, TRADER_TRADES_LOG_EXTRA: `${S};${dupPrimary}` }, () => {
    const text = readTradesLedger(DIR);
    assert.strictEqual(count(text, '"order_id":"tlt-1"'), 1, 'exit by order id');
    assert.strictEqual(count(text, '"event":"entry"'), 1, 'entry by timestamp + quantity');
    assert.deepStrictEqual(tradesLedgerSources(DIR).extras, [path.resolve(S)], 'the primary is not its own extra');
  });
});

test('unreadable files degrade, they do not break the page', () => {
  const gone = path.join(DIR, 'nope.jsonl');
  withEnv({ TRADER_TRADES_LOG: null, TRADER_TRADES_LOG_EXTRA: `${gone};${S}` }, () => {
    assert.strictEqual(count(readTradesLedger(DIR), '"order_id":"tlt-1"'), 1, 'a missing extra is skipped');
  });
  withEnv({ TRADER_TRADES_LOG: gone, TRADER_TRADES_LOG_EXTRA: S }, () => {
    assert.strictEqual(count(readTradesLedger(DIR), '"order_id":"tlt-1"'), 1, 'no primary, one extra read: proceed');
  });
  withEnv({ TRADER_TRADES_LOG: gone, TRADER_TRADES_LOG_EXTRA: path.join(DIR, 'nope2.jsonl') }, () => {
    assert.throws(() => readTradesLedger(DIR), /ENOENT/, 'nothing readable: throw, the route falls back to broker figures');
  });
  withEnv({ TRADER_TRADES_LOG: gone, TRADER_TRADES_LOG_EXTRA: null }, () => {
    assert.throws(() => readTradesLedger(DIR), /ENOENT/, 'single-ledger behaviour unchanged');
  });
});

test('the live case, 2026-09-28: the engine bought SMH this morning and closed TLT and part of GLD', async () => {
  const positions = [
    { symbol: 'SMH', qty: 25, current_price: 599.75, unrealized_pl: 135.75 },
    { symbol: 'GLD', qty: 3, current_price: 377.27, unrealized_pl: -46.55 },
    { symbol: 'DIA', qty: 7, current_price: 514.05, unrealized_pl: -23.73 },
  ];
  const PREV = { SMH: 606.56, GLD: 393.41, DIA: 517.49 };
  const run = () => computeDayPnl({ positions, ledgerText: readTradesLedger(DIR), now: NOW, getQuotes: async () => [], getPrevClose: async (s) => PREV[s] || null });
  const by = (d) => Object.fromEntries(d.per_position.map((p) => [p.symbol, p]));

  // the server's own ledger alone: SMH is "carried" on the strength of a September 10 entry
  const alone = await withEnv({ TRADER_TRADES_LOG: null, TRADER_TRADES_LOG_EXTRA: null }, run);
  assert.strictEqual(by(alone).SMH.day_basis, 'prev_close');
  assert.strictEqual(by(alone).SMH.day_pnl, -170.25);
  assert.strictEqual(alone.realized_today, 0);
  assert.ok(alone.pnl_today < -200, `the page's wrong answer: ${alone.pnl_today}`);

  // with the engine's journals: bought today, so since entry; the exits count
  const merged = await withEnv({ TRADER_TRADES_LOG: null, TRADER_TRADES_LOG_EXTRA: `${S};${R}` }, run);
  assert.strictEqual(by(merged).SMH.day_basis, 'entry');
  assert.strictEqual(by(merged).SMH.day_pnl, 135.75);
  assert.strictEqual(by(merged).GLD.day_basis, 'prev_close', 'GLD was bought on the 23rd: carried, today\'s move only');
  assert.strictEqual(by(merged).GLD.day_pnl, -48.42);
  assert.strictEqual(by(merged).DIA.day_basis, 'since_entry_unknown_lot', 'no ledger holds a DIA entry: declared, not guessed');
  // TLT opened and closed today (+31.45 whole) + GLD carried lot, today's leg only: (379.47 - 393.41) x 6 = -83.64
  assert.strictEqual(merged.realized_today, -52.19);
  assert.strictEqual(merged.realized_booked, -48.46, 'the cash the closed trades banked: 31.45 - 79.91');
  assert.strictEqual(merged.pnl_today, 11.41);
});
