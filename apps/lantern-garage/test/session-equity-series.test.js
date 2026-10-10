'use strict';
/**
 * session-equity-series.test.js — the journal's Account measure from the brains' nightly session rows
 * (the fallback for a box whose broker returns no history; stable / IBKR, 2026-10-09).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/session-equity-series');

const row = (date, equity, extra = {}) => JSON.stringify({ ts: `${date}T20:01:01.000Z`, user: 'u', event: 'session', date, equity, day_pnl: 0, ...extra });

test('one point per session close, oldest first, in the adapters\' shape', () => {
  const text = [row('2026-10-07', 981000.5), row('2026-10-08', 991468.2), row('2026-10-09', 995942.25)].join('\n') + '\n';
  const s = S.fromRows(text);
  assert.equal(s.ok, true); assert.equal(s.source, 'session-rows'); assert.equal(s.range, 'ALL');
  assert.deepEqual(s.dates, ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(s.equity, [981000.5, 991468.2, 995942.25]);
  assert.equal(s.base_value, 981000.5); assert.equal(s.days, 3);
  assert.equal(s.timestamps[0], Math.round(Date.parse('2026-10-07T20:00:00Z') / 1000), 'the point sits at that date\'s close, not at the row\'s own ts');
  assert.ok(s.timestamps[0] < s.timestamps[1] && s.timestamps[1] < s.timestamps[2]);
});

test('a row written after 20:00 ET (a late restart) still lands on its own exchange day', () => {
  const late = JSON.stringify({ ts: '2026-10-10T01:30:00.000Z', event: 'session', date: '2026-10-09', equity: 5 });   // 21:30 ET on the 9th
  const s = S.fromRows([row('2026-10-07', 1), row('2026-10-08', 2), late].join('\n'));
  assert.equal(new Date(s.timestamps[2] * 1000).toISOString().slice(0, 10), '2026-10-09');
});

test('fewer than three closes is not a history (the page\'s own floor)', () => {
  const s = S.fromRows([row('2026-10-08', 1), row('2026-10-09', 2)].join('\n'));
  assert.equal(s.ok, false); assert.match(s.reason, /only 2 session row/);
});

test('two rows for one date: the latest wins; other events, bad dates and bad equities are ignored', () => {
  const rows = [
    JSON.parse(row('2026-10-09', 100, { ts: '2026-10-09T20:00:03.758Z' })),   // S's row
    JSON.parse(row('2026-10-09', 101, { ts: '2026-10-09T20:00:04.100Z' })),   // M's row, written a moment later: the same account
    { event: 'exit', date: '2026-10-09', equity: 5 },
    JSON.parse(row('not-a-date', 7)),
    JSON.parse(row('2026-10-07', -3)),
    JSON.parse(row('2026-10-07', 98)),
    JSON.parse(row('2026-10-08', 99)),
  ];
  const s = S.fromRows(rows);
  assert.equal(s.ok, true);
  assert.deepEqual(s.dates, ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(s.equity, [98, 99, 101]);
});

test('the ledgers of a multi-sleeve box merge; an unreadable extra is skipped; no readable file is an honest no', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-series-'));
  const primary = path.join(dir, 'S.jsonl'), extra = path.join(dir, 'M.jsonl');
  fs.writeFileSync(primary, [row('2026-10-07', 98), row('2026-10-08', 99), '{"event":"skip","why":"x"}', 'torn {'].join('\n') + '\n');
  fs.writeFileSync(extra, [row('2026-10-08', 99), row('2026-10-09', 101)].join('\n') + '\n');
  const s = S.fromLedgers({ primary, extras: [extra, path.join(dir, 'missing.jsonl')] });
  assert.equal(s.ok, true); assert.deepEqual(s.dates, ['2026-10-07', '2026-10-08', '2026-10-09']); assert.deepEqual(s.equity, [98, 99, 101]);
  const none = S.fromLedgers({ primary: path.join(dir, 'nope.jsonl'), extras: [] });
  assert.equal(none.ok, false); assert.match(none.reason, /no ledger/);
});

test('the real row shape: a stable session row as written on 2026-10-09', () => {
  const real = '{"ts":"2026-10-09T20:01:01.627Z","user":"local-owner","event":"session","date":"2026-10-09","equity":995942.25,"cash":1016990.13,"day_pnl":3036.27,"realized_today":3095.1,"realized_booked":1708.57,"unrealized_today":-58.84,"carry_adjustment":-1386.53,"pnl_basis":"realized(ET ledger fills) + unrealized change today"}';
  const s = S.fromRows([real, row('2026-10-07', 1), row('2026-10-08', 2)].join('\n'));
  assert.equal(s.ok, true); assert.equal(s.equity[2], 995942.25); assert.equal(s.dates[2], '2026-10-09');
});
