'use strict';

/**
 * transparency-route.test.js — the glass-factory feed (#3598) tells the truth
 * about the ledger it reads: hit rates count only resolved verdicts, reversals
 * stay visible, open rows surface with due dates, and the journal strip comes
 * from session rows only.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transparency-test-'));
const ledgerPath = path.join(tmp, 'ledger.jsonl');
const journalPath = path.join(tmp, 'journal.jsonl');
process.env.TRADER_PREDICTION_LEDGER = ledgerPath;
process.env.TRADER_TRADES_LOG = journalPath;

fs.writeFileSync(ledgerPath, [
  { id: 'a', instrument: 'replay', outcome: 'CONFIRMED', scored: '2026-09-08' },
  { id: 'b', instrument: 'replay', outcome: 'REVERSED', scored: '2026-09-05', evidence: 'the replay said up; live said down' },
  { id: 'c', instrument: 'replay', outcome: 'OPEN', change: 'knob X', prediction: 'improves Y', due: '2026-09-19' },
  { id: 'd', instrument: 'study', outcome: 'MISLEADING', scored: '2026-09-04' },
].map(JSON.stringify).join('\n') + '\n');

fs.writeFileSync(journalPath, [
  { event: 'exit', symbol: 'SPY', pnl: 5 },                                       // not a session row
  { event: 'session', date: '2026-09-10', equity: 100000, day_pnl: 250, entries: 3, exits: 2, exits_by_reason: { signal_exit: { n: 2, pnl: 250 } } },
  { event: 'session', date: '2026-09-11', equity: 99500, day_pnl: -500, entries: 1, exits: 4 },
].map(JSON.stringify).join('\n') + '\n');

const routes = require('../routes/trading/transparency');

function call(pathname = '/api/trading/transparency', method = 'GET') {
  const cap = {};
  const handled = routes(
    { method, headers: {} }, {},
    new URL('http://127.0.0.1' + pathname),
    { sendJson: (_res, body, code) => { cap.body = body; cap.code = code; } },
  );
  return handled.then((h) => ({ handled: h, ...cap }));
}

test('non-matching path is declined', async () => {
  const r = await call('/api/trading/other');
  assert.strictEqual(r.handled, false);
});

test('scoreboard: hit rate counts resolved only; reversals visible; open surfaced', async () => {
  const r = await call();
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.code, 200);
  const replay = r.body.scoreboard.find((x) => x.instrument === 'replay');
  assert.deepStrictEqual(
    { n: replay.n, confirmed: replay.confirmed, bad: replay.bad, open: replay.open, hit_rate: replay.hit_rate },
    { n: 3, confirmed: 1, bad: 1, open: 1, hit_rate: 50 },   // 1 of 2 RESOLVED — the open row must not dilute it
  );
  assert.strictEqual(r.body.discipline.reversals_total, 2, 'REVERSED + MISLEADING both stay visible');
  assert.strictEqual(r.body.open_predictions.length, 1);
  assert.strictEqual(r.body.open_predictions[0].due, '2026-09-19');
  const rev = r.body.recent_verdicts.find((v) => v.id === 'b');
  assert.match(rev.evidence, /live said down/);
});

test('journal strip: session rows only, today = the latest session', async () => {
  const r = await call();
  assert.strictEqual(r.body.equity_strip.length, 2, 'exit rows are not sessions');
  assert.strictEqual(r.body.today.date, '2026-09-11');
  assert.strictEqual(r.body.today.day_pnl, -500);
});
