'use strict';
/**
 * test/chart-trade-marks.test.js — the trader's entries and exits on the ticker charts.
 *
 * Three halves of one feature:
 *   lib/chart-trade-marks      journal rows → trades (the mapping)
 *   routes/trading/chart-trades  the read endpoint: per reader, cheap to poll
 *   public/js/trade-marks      trades → the bar each sits on, and the card's words
 *
 * The fixture is REAL: test/fixtures/chart-trade-marks.jsonl is 66 rows copied from the
 * paper traders' own journals (2026-07 to 2026-11), chosen for the cases that make this
 * mapping hard — a close journalled twice, a sale that filled in pieces, fills stamped
 * when they were found, the overnight book, shadow rows beside real ones, and the old
 * ledger's statuses that never became a fill.
 *
 * Run: node --test apps/lantern-garage/test/chart-trade-marks.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// The route reads the ledger the scorecard reads; point both at a scratch copy first.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-trades-'));
const LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LOG;
delete process.env.TRADER_TRADES_LOG_EXTRA;

const { buildTradeMarks, isTradeRow } = require('../lib/chart-trade-marks');
const route = require('../routes/trading/chart-trades');
const TM = require('../public/js/trade-marks');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'chart-trade-marks.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const marks = buildTradeMarks(FIXTURE);
const one = (sym) => { assert.strictEqual((marks[sym] || []).length, 1, sym + ' should be one trade'); return marks[sym][0]; };

// ── the mapping ──────────────────────────────────────────────────────────────

test('an entry is marked at the moment the order went in, at the broker\'s fill price', () => {
  const smh = one('SMH');
  assert.strictEqual(smh.entry.ts, '2026-11-19T17:29:13.240Z');   // 12:29:13 in New York
  assert.strictEqual(smh.entry.price, 457.426408, 'the entry_fill row\'s fill, not the 457.149 quote');
  assert.strictEqual(smh.entry.price_from, 'fill');
  assert.strictEqual(smh.entry.quote, 457.149);
  assert.strictEqual(smh.qty, 178);
  assert.strictEqual(smh.stop_at_entry, 443.43);
});

test('an entry with no fill row keeps the order\'s quote, and says that is what it is', () => {
  const soxl = one('SOXL');
  assert.strictEqual(soxl.entry.price, 135.48);
  assert.strictEqual(soxl.entry.price_from, 'quote');
});

test('a closed trade carries its exit: time, price, P&L and the reason', () => {
  const smh = one('SMH');
  assert.strictEqual(smh.open, false);
  assert.strictEqual(smh.exits.length, 1);
  const ex = smh.exits[0];
  assert.strictEqual(ex.price, 436.203483);
  assert.strictEqual(ex.pnl, -3777.68);
  assert.strictEqual(smh.pnl, -3777.68);
  assert.strictEqual(ex.qty, 178);
  assert.strictEqual(ex.reason, 'stop order filled', '"broker fill" on a stop order says what happened');
  assert.strictEqual(smh.stop, null, 'a closed trade has no live stop to draw');
});

test('a close journalled twice on one New York day is ONE exit: the later row\'s price, the first row\'s time', () => {
  // JNUG 2026-11-18: the engine's max_loss row at 91.47, then the broker's row at 89.65.
  const jnug = one('JNUG');
  assert.strictEqual(jnug.exits.length, 1, 'two rows, one exit');
  const ex = jnug.exits[0];
  assert.strictEqual(ex.price, 89.65164, 'the later row has the real price');
  assert.strictEqual(ex.pnl, -8360.66);
  assert.strictEqual(ex.ts, '2026-11-18T12:47:24.511Z', 'the later row was stamped two hours after the fact');
  assert.match(ex.reason, /^max_loss/, 'the engine\'s reason beats "broker fill"');

  // XOP 2026-11-17: both rows are the fill ledger's; still one exit.
  const xop = one('XOP');
  assert.strictEqual(xop.exits.length, 1);
  assert.strictEqual(xop.exits[0].price, 182.247761);
  assert.strictEqual(xop.pnl, 754.71);
});

test('the same exit on another day is another exit', () => {
  const rows = [
    { ts: '2026-11-02T15:00:00.000Z', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T19:00:00.000Z', event: 'exit', symbol: 'ABC', qty: 10, entry: 50, exit: 51, pnl: 10, status: 'filled' },
    { ts: '2026-11-03T15:00:00.000Z', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-03T19:00:00.000Z', event: 'exit', symbol: 'ABC', qty: 10, entry: 50, exit: 49, pnl: -10, status: 'filled' },
  ];
  const abc = buildTradeMarks(rows).ABC;
  assert.deepStrictEqual(abc.map((t) => t.pnl), [10, -10]);
});

test('only filled and reconstructed exits are drawn — needs_confirmation, error and placed are not', () => {
  // AMD, July: two needs_confirmation rows (the order was never sent). No exit.
  const amd = marks.AMD;
  assert.strictEqual(amd.length, 2);
  assert.ok(amd.every((t) => t.exits.length === 0), 'a needs_confirmation row drew an exit');
  // SOXS, July: two `error` rows and no entry. Nothing at all.
  assert.strictEqual(marks.SOXS, undefined, 'an error row drew a trade');
  // SOXL, August: an order-accepted (`placed`) row. Not drawn as an exit…
  const soxl = one('SOXL');
  assert.strictEqual(soxl.exits.length, 0);
  // …but it does end the trade, so an August entry is not a position still open today.
  assert.strictEqual(soxl.open, false);
  assert.strictEqual(soxl.closed_note, 'unconfirmed');

  const status = (s) => buildTradeMarks([
    { ts: '2026-11-02T15:00:00.000Z', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T19:00:00.000Z', event: 'exit', symbol: 'ABC', qty: 10, entry: 50, exit: 51, pnl: 10, status: s },
  ]).ABC[0];
  assert.strictEqual(status('filled').exits.length, 1);
  assert.strictEqual(status('reconstructed').exits.length, 1);
  for (const s of ['needs_confirmation', 'placed', 'error', 'frozen', 'dry_run', '']) {
    assert.strictEqual(status(s).exits.length, 0, s + ' was drawn as an exit');
  }
  assert.strictEqual(status('needs_confirmation').open, true, 'an order that was never sent leaves the position on');
});

test('shadow rows are research, never trades', () => {
  const shadows = FIXTURE.filter((r) => /_shadow_/.test(r.event) || /-shadow$|^entry-tags$/.test(r.user || ''));
  assert.ok(shadows.length >= 6, 'the fixture lost its shadow rows');
  for (const r of shadows) assert.strictEqual(isTradeRow(r), false, r.event + ' / ' + r.user + ' read as a trade row');
  // SPXS and SOXS appear ONLY in shadow rows (and SOXS in two error rows): no marks.
  assert.strictEqual(marks.SPXS, undefined);
  assert.strictEqual(marks.SOXS, undefined);
  // XLE has a real trade and three shadow rows on the same second: still one trade.
  assert.strictEqual(one('XLE').qty, 1278);

  // Even a row that borrows a trade event's name is ignored when a shadow user wrote it.
  const forged = buildTradeMarks([
    { ts: '2026-11-02T15:00:00.000Z', user: 'trend-shadow', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T15:00:00.000Z', user: 'noise-shadow', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T15:00:00.000Z', user: 'rise-shadow', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T15:00:00.000Z', user: 'entry-tags', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T15:00:00.000Z', user: 'local-owner', event: 'trend_shadow_entry', symbol: 'ABC', entry_px: 50 },
  ]);
  assert.deepStrictEqual(forged, {});
});

test('a sale that filled in pieces is several exits on one trade', () => {
  const spxl = one('SPXL');
  assert.deepStrictEqual(spxl.exits.map((e) => e.qty), [119, 100, 200]);
  assert.deepStrictEqual(spxl.exits.map((e) => e.price), [279.88, 280.28, 280.33]);
  assert.strictEqual(spxl.pnl, 655.84, 'the trade\'s P&L is its exits added up');
  assert.strictEqual(spxl.open, false);
});

test('a time the journal cannot vouch for is marked approximate, with the reason', () => {
  // Stamped when the fill was found (ts_from: discovered).
  assert.deepStrictEqual([one('GDX').exits[0].time_approx, one('GDX').exits[0].time_note], [true, 'seen']);
  // A stop "filled" on the second its order was moved: that is the order's time.
  const uso = one('USO');
  assert.strictEqual(uso.exits[0].time_note, 'order_time');
  assert.strictEqual(uso.exits[0].ts, '2026-10-08T10:30:24.000Z');
  // An ordinary market exit is exact.
  assert.strictEqual(one('SPXL').exits[0].time_approx, false);
  // A reconstructed close is an estimate in time and in price.
  const rec = buildTradeMarks([
    { ts: '2026-09-16T13:00:00.000Z', event: 'entry', symbol: 'QQQ', qty: 164, entry: 704.69 },
    { ts: '2026-09-16T13:32:04.612Z', event: 'exit', symbol: 'QQQ', qty: 164, entry: 704.6861006, exit: 708.19, pnl: 574.64, status: 'reconstructed', estimated: true },
  ]).QQQ[0].exits[0];
  assert.deepStrictEqual([rec.time_note, rec.price_estimated], ['reconstructed', true]);
});

test('an exit row with no entry price still closes what is left of the position', () => {
  // USO 2026-10-08: 793 shares sold by the stop, then the last 100 on a row with entry: null.
  const uso = one('USO');
  assert.deepStrictEqual(uso.exits.map((e) => e.qty), [793, 100]);
  assert.strictEqual(uso.exits[1].pnl, null, 'an unpriced exit stays unpriced');
  assert.strictEqual(uso.pnl, 4123.98);
  assert.strictEqual(uso.open, false);
});

test('an exit the broker stamped to the whole second still finds the entry row written after it', () => {
  const rows = [
    { ts: '2026-09-30T16:01:20.000Z', event: 'exit', symbol: 'NUGT', qty: 1197, entry: 149.011661, exit: 144.0, pnl: -5994.51,
      status: 'filled', order_type: 'Stop', opened_at: Date.parse('2026-09-30T16:01:11.000Z') },
    { ts: '2026-09-30T16:01:20.412Z', event: 'entry', symbol: 'NUGT', qty: 1197, entry: 149.0, stop: 144.33 },
    { ts: '2026-09-30T16:02:31.000Z', event: 'entry_fill', symbol: 'NUGT', quote_px: 149.0, fill_px: 149.011661 },
  ];
  const nugt = buildTradeMarks(rows).NUGT;
  assert.strictEqual(nugt.length, 1, 'the exit became a second, orphan trade');
  assert.strictEqual(nugt[0].open, false);
  assert.strictEqual(nugt[0].exits[0].time_note, 'order_time');
});

test('two sleeves in one name: each exit closes the entry it names, not the newest one', () => {
  const rows = [
    { ts: '2026-11-10T15:00:00.000Z', event: 'entry', symbol: 'SMH', qty: 20, entry: 500.0, stop: 485 },
    { ts: '2026-11-10T20:55:00.000Z', event: 'entry', symbol: 'SMH', qty: 17, entry: 510.0, stop: 469 },
    // the OLDER sleeve exits first, at its own basis
    { ts: '2026-11-11T14:40:00.000Z', event: 'exit', symbol: 'SMH', qty: 20, entry: 500.0, exit: 505, pnl: 100, status: 'filled' },
  ];
  const smh = buildTradeMarks(rows, { ledgers: 2 }).SMH;
  assert.strictEqual(smh[0].exits.length, 1, 'the exit went to the wrong sleeve\'s entry');
  assert.strictEqual(smh[0].open, false);
  assert.strictEqual(smh[1].exits.length, 0);
  assert.strictEqual(smh[1].open, true);
  assert.strictEqual(smh[1].stop, 469);
});

test('an open trade is open, with the newest stop the journal has for it', () => {
  const dia = one('DIA');
  assert.strictEqual(dia.open, true);
  assert.strictEqual(dia.entry.price, 491.700666);
  assert.strictEqual(dia.stop, 452.57);
  const moved = buildTradeMarks([
    { ts: '2026-11-19T16:00:00.000Z', event: 'entry', symbol: 'QQQ', qty: 10, entry: 660.9, stop: 641.1 },
    { ts: '2026-11-19T16:42:16.780Z', event: 'stop_resize', symbol: 'QQQ', entry: 660.9081331, stop_want: 661.57 },
    { ts: '2026-11-19T16:43:00.000Z', event: 'stop_resize', symbol: 'QQQ', reason: 'oversized stop' },   // no stop_want: ignored
  ]).QQQ[0];
  assert.deepStrictEqual([moved.stop, moved.stop_at_entry], [661.57, 641.1]);
});

test('an old entry with no exit does not read as open once the symbol has been entered again', () => {
  // AMD, July: two entries, no confirmed exit for either. One ledger holds one position a
  // symbol, so only the newest can still be on.
  assert.deepStrictEqual(marks.AMD.map((t) => t.open), [false, true]);
  assert.strictEqual(marks.AMD[0].closed_note, 'unconfirmed');
});

test('the overnight book: a buy opens, the morning sale closes, the broker\'s prices win', () => {
  const book = marks.SPY.find((t) => t.book === 'overnight');
  assert.ok(book, 'no overnight book trade for SPY');
  assert.strictEqual(book.entry.ts, '2026-11-18T20:56:13.448Z');   // 15:56:13 New York
  assert.strictEqual(book.entry.price, 731.28, 'the position\'s cost from the gone row, not the 731.288 quote');
  assert.strictEqual(book.entry.price_from, 'position');
  assert.strictEqual(book.exits[0].ts, '2026-11-19T14:40:30.082Z'); // 09:40:30 New York
  assert.strictEqual(book.exits[0].price, 735.88, 'the sale\'s fill, not the 736.44 quote');
  assert.strictEqual(book.exits[0].price_estimated, false);
  assert.strictEqual(book.pnl, 230);
  assert.strictEqual(book.open, false);
  // The day trade in the same name on the next afternoon is its own trade, still open.
  const day = marks.SPY.find((t) => t.book === 'day');
  assert.deepStrictEqual([day.qty, day.open], [10, true]);

  const refused = buildTradeMarks([
    { ts: '2026-11-18T20:56:13.448Z', event: 'overnight_book_buy', symbol: 'QQQ', qty: 50, px: 600, ok: false, status: 'error' },
  ]);
  assert.deepStrictEqual(refused, {}, 'a refused buy drew an entry');
});

test('rows it cannot place are skipped, not guessed at', () => {
  const out = buildTradeMarks([
    null, 'nonsense', {},
    { event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },                              // no time
    { ts: 'not a date', event: 'entry', symbol: 'ABC', qty: 10, entry: 50 },
    { ts: '2026-11-02T15:00:00.000Z', event: 'entry', qty: 10, entry: 50 },             // no symbol
    { ts: '2026-11-02T15:00:00.000Z', event: 'entry', symbol: 'ABC', qty: 10 },         // no price
    { ts: '2026-11-02T15:00:00.000Z', event: 'skip', symbol: 'ABC' },
  ]);
  assert.deepStrictEqual(out, {});
});

// ── the endpoint ─────────────────────────────────────────────────────────────

function seed(rows) { fs.writeFileSync(LOG, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); route._resetForTests(); }
function call(qs, { userId = 'local-owner', method = 'GET', pathname = '/api/trading/chart-trades' } = {}) {
  const url = new URL('http://x' + pathname + (qs || ''));
  const req = Object.assign(new EventEmitter(), { method, headers: {}, socket: {}, url: url.pathname + url.search });
  if (userId != null) req.session = { user: { id: userId } };
  const out = {};
  const ctx = { sendJson: (res, obj, code) => { out.json = obj; out.status = code || 200; } };
  return route(req, {}, url, ctx).then((handled) => ({ handled, ...out }));
}

test('the route declines other paths and methods, so the rest of the router still sees them', async () => {
  assert.strictEqual((await call('', { pathname: '/api/trading/trades' })).handled, false);
  assert.strictEqual((await call('', { method: 'POST' })).handled, false);
});

test('the route serves the reader\'s own trades by symbol, and nobody else\'s', async () => {
  seed(FIXTURE.concat([
    { ts: '2026-11-19T15:00:00.000Z', user: 'u-2', event: 'entry', symbol: 'SECRET', qty: 1, entry: 10 },
  ]));
  const mine = await call('');
  assert.strictEqual(mine.status, 200);
  assert.ok(mine.json.symbols.SMH && mine.json.symbols.SPY, 'the house book is missing');
  assert.strictEqual(mine.json.symbols.SECRET, undefined, 'another account\'s trade leaked');
  assert.strictEqual(mine.json.symbols.SPXS, undefined, 'a shadow row was served as a trade');

  const theirs = await call('', { userId: 'u-2' });
  assert.deepStrictEqual(Object.keys(theirs.json.symbols), ['SECRET']);

  const only = await call('?symbol=smh');
  assert.deepStrictEqual(Object.keys(only.json.symbols), ['SMH']);
  assert.deepStrictEqual((await call('?symbol=NOPE')).json.symbols, {});
});

test('a page that already has the trades gets a one-line answer until a trade row is added', async () => {
  seed(FIXTURE);
  const first = await call('');
  assert.ok(first.json.version);
  const again = await call('?have=' + encodeURIComponent(first.json.version));
  assert.deepStrictEqual(again.json, { version: first.json.version, unchanged: true });

  // A scan's `skip` row grows the file and changes nothing a chart draws…
  seed(FIXTURE.concat([{ ts: '2026-11-20T15:00:00.000Z', user: 'local-owner', event: 'skip', symbol: 'SMH' }]));
  assert.strictEqual((await call('?have=' + encodeURIComponent(first.json.version))).json.unchanged, true);
  // …a new entry does.
  seed(FIXTURE.concat([{ ts: '2026-11-20T15:00:00.000Z', user: 'local-owner', event: 'entry', symbol: 'TLT', qty: 5, entry: 80 }]));
  const fresh = await call('?have=' + encodeURIComponent(first.json.version));
  assert.ok(fresh.json.symbols && fresh.json.symbols.TLT, 'the new entry was not served');
});

test('a missing ledger is an empty answer, not an error', async () => {
  fs.rmSync(LOG, { force: true }); route._resetForTests();
  const r = await call('');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.symbols, {});
});

// ── the chart's half: which bar, and what the card says ───────────────────────

const bar = (iso) => ({ timestamp: iso, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
// 2026-11-19 and -20, regular hours, five-minute bars (14:30Z-21:00Z is 09:30-16:00 ET).
function session(day) {
  const out = [];
  for (let m = 14 * 60 + 30; m < 21 * 60; m += 5) out.push(bar(day + 'T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00.000Z'));
  return out;
}
const FIVE = session('2026-11-19').concat(session('2026-11-20'));
const at5 = (iso) => TM.placer(FIVE, '5m').at(Date.parse(iso));
const tsOf = (i) => FIVE[i].timestamp;

test('intraday: a moment sits on the bar whose five minutes hold it', () => {
  // SMH, bought 12:29:13 ET: the 12:25 bar.
  assert.strictEqual(tsOf(at5('2026-11-19T17:29:13.240Z').idx), '2026-11-19T17:25:00.000Z');
  // The exact start of a bar belongs to that bar.
  assert.strictEqual(tsOf(at5('2026-11-19T17:30:00.000Z').idx), '2026-11-19T17:30:00.000Z');
  // SMH's stop, seen 09:32:57 ET the next morning: the 09:30 bar of the 20th.
  assert.strictEqual(tsOf(at5('2026-11-20T14:32:57.245Z').idx), '2026-11-20T14:30:00.000Z');
});

test('intraday: a moment in a gap goes to the nearer side, and says it was moved', () => {
  // 07:47 ET, pre-market on a regular-hours chart: the open it preceded, not yesterday's close.
  const pre = at5('2026-11-20T12:47:24.000Z');
  assert.deepStrictEqual([tsOf(pre.idx), pre.gap], ['2026-11-20T14:30:00.000Z', true]);
  // 16:30 ET, after hours: the close it followed.
  const post = at5('2026-11-19T21:30:00.000Z');
  assert.deepStrictEqual([tsOf(post.idx), post.gap], ['2026-11-19T20:55:00.000Z', true]);
});

test('a moment older than the loaded bars is not on the chart; a newer one sits on the last bar', () => {
  assert.strictEqual(at5('2026-11-18T19:00:00.000Z').idx, -1);
  assert.strictEqual(at5('2026-11-20T21:30:00.000Z').idx, FIVE.length - 1);
  assert.strictEqual(TM.placer([], '5m').at(Date.now()).idx, -1, 'no bars, no mark');
});

test('daily: the mark is on the bar of its New York DAY, however the feed stamps its bars', () => {
  const evening = Date.parse('2026-11-20T00:55:00.000Z');   // 19:55 ET on the 19th
  // A feed that stamps a day at its 09:30 open…
  const open = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((d) => bar(d + 'T14:30:00.000Z'));
  assert.strictEqual(TM.placer(open, '1d').at(evening).idx, 2);
  // …and one that stamps it at midnight UTC, where "the last bar before this instant" is the 20th.
  const utc = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((d) => bar(d + 'T00:00:00.000Z'));
  assert.strictEqual(TM.placer(utc, '1d').at(evening).idx, 2, 'an evening fill landed on tomorrow\'s bar');
  // SMH bought 12:29 ET on the 19th, stopped at the open of the 20th.
  assert.strictEqual(TM.placer(open, '1d').at(Date.parse('2026-11-19T17:29:13.240Z')).idx, 2);
  assert.strictEqual(TM.placer(open, '1d').at(Date.parse('2026-11-20T14:32:57.245Z')).idx, 3);
  // Before the first bar: not on this chart. A day the feed has no bar for yet: the next slot.
  assert.strictEqual(TM.placer(open, '1d').at(Date.parse('2026-11-14T15:00:00.000Z')).idx, -1);
  assert.strictEqual(TM.placer(open, '1d').at(Date.parse('2026-11-23T15:00:00.000Z')).idx, 4);
  // A weekend has no bar: Saturday's moment sits on Friday's.
  assert.strictEqual(TM.placer(open.slice(0, 3), '1w').at(Date.parse('2026-11-21T15:00:00.000Z')).idx, 2);
});

test('layout: every entry and exit on the chart is a mark at its price; older trades are left out', () => {
  const L = TM.layout(marks.SMH.concat(marks.XOP), FIVE, '5m');
  // SMH is on these two days; XOP (11-16 / 11-17) is older than the bars.
  assert.deepStrictEqual(L.marks.map((m) => [m.kind, m.trade.symbol, m.price]), [
    ['entry', 'SMH', 457.426408], ['exit', 'SMH', 436.203483],
  ]);
  assert.strictEqual(tsOf(L.marks[0].idx), '2026-11-19T17:25:00.000Z');
  assert.strictEqual(tsOf(L.marks[1].idx), '2026-11-20T14:30:00.000Z');
  // An open trade is reported open even when its entry is older than the chart.
  const old = TM.layout(marks.DIA, session('2026-11-20'), '5m');
  assert.strictEqual(old.marks.length, 0);
  assert.strictEqual(old.open.length, 1);
});

test('the card gives the exact New York time, the fill price, the quantity and the result', () => {
  const L = TM.layout(marks.SMH, FIVE, '5m');
  const d = TM.describe(L.marks[1], false);
  assert.strictEqual(d.title, 'SMH · bought 178');
  const row = (k) => d.rows.find((r) => r.k === k);
  assert.strictEqual(row('In').v, 'Thu, Nov 19, 12:29:13 PM ET  @ 457.43');
  assert.strictEqual(row('In').note, 'fill');
  assert.strictEqual(row('Out').v, '≈ Fri, Nov 20, 9:32:57 AM ET  @ 436.20');
  assert.match(row('Out').note, /when the fill was seen/);
  assert.strictEqual(row('Out').here, true, 'the row for the mark being pointed at is not flagged');
  assert.strictEqual(row('P&L').v, '−$3,777.68  (−4.64%)');
  assert.strictEqual(row('P&L').tone, 'loss');
  assert.strictEqual(row('Why').v, 'stop order filled');
  assert.strictEqual(row('Held').v, '21h 3m');
});

test('the card for a trade in pieces lists each piece and the total', () => {
  const m = { kind: 'entry', trade: marks.SPXL[0], k: -1 };
  const d = TM.describe(m, null);
  const outs = d.rows.filter((r) => /^Out \d\/3$/.test(r.k));
  assert.strictEqual(outs.length, 3);
  assert.match(outs[0].v, /11:39:52 AM ET {2}@ 279\.88 {2}× 119$/);
  assert.strictEqual(d.rows.find((r) => r.k === 'P&L').v, '+$655.84');
  assert.strictEqual(d.rows.find((r) => r.k === 'P&L').tone, 'win');
});

test('the card for an open trade says so, and does not claim a position the account no longer holds', () => {
  const m = { kind: 'entry', trade: marks.DIA[0], k: -1 };
  assert.strictEqual(TM.describe(m, true).rows.find((r) => r.k === 'Now').v, 'Open  ·  stop 452.57');
  assert.strictEqual(TM.describe(m, null).rows.find((r) => r.k === 'Now').v, 'Open  ·  stop 452.57');
  assert.match(TM.describe(m, false).rows.find((r) => r.k === 'Now').v, /no longer holds it/);
  // A trade the old ledger never confirmed closed says that instead of inventing an exit.
  const soxl = TM.describe({ kind: 'entry', trade: marks.SOXL[0], k: -1 }, null);
  assert.strictEqual(soxl.rows.find((r) => r.k === 'Out').v, 'No confirmed exit in the journal.');
});

test('times are New York times whatever zone the machine is in', () => {
  // 2026-07-14T19:38:05Z is 3:38:05 PM EDT; 2026-11-19T17:29:13Z is 12:29:13 PM EST.
  assert.strictEqual(TM.fmtTime('2026-07-14T19:38:05.513Z'), 'Tue, Jul 14, 3:38:05 PM ET');
  assert.strictEqual(TM.fmtTime('2026-11-19T17:29:13.240Z', { short: true }), 'Nov 19, 12:29 PM ET');
  assert.strictEqual(TM.fmtTime('garbage'), '');
});

// ── drawing, against a canvas that only records ──────────────────────────────

function fakeCtx() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const ctx = { calls, measureText: (t) => ({ width: String(t).length * 6 }) };
  for (const m of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'fill', 'fillRect', 'fillText', 'setLineDash']) ctx[m] = rec(m);
  return ctx;
}
const SCALE = { slotW: 4, pw: 800, priceH: 300, y: (p) => 300 - (p - 400) * 3,
  colors: { entry: '#00f', win: '#0f0', loss: '#f00', flat: '#888', bg: '#000' } };

test('draw: a mark\'s tip is on the bar\'s centre at the fill price, and each mark can be pointed at', () => {
  const ctx = fakeCtx();
  const hits = TM.draw(ctx, { trades: marks.SMH, bars: FIVE, tf: '5m', held: false, ...SCALE });
  assert.strictEqual(hits.length, 2);
  const L = TM.layout(marks.SMH, FIVE, '5m');
  const tips = ctx.calls.filter((c, i) => c[0] === 'moveTo' && ctx.calls[i + 2] && ctx.calls[i + 3] && ctx.calls[i + 3][0] === 'closePath');
  assert.deepStrictEqual(tips.map((c) => [c[1], Math.round(c[2] * 1000) / 1000]), [
    [L.marks[0].idx * 4 + 2, Math.round(SCALE.y(457.426408) * 1000) / 1000],
    [L.marks[1].idx * 4 + 2, Math.round(SCALE.y(436.203483) * 1000) / 1000],
  ]);
  assert.strictEqual(hits[0].mark.kind, 'entry');
  assert.strictEqual(hits[1].mark.exit.pnl, -3777.68);
  // The labels carry the clock time at a glance.
  const labels = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(labels.includes('Buy 12:29 PM'), 'labels: ' + labels.join(' | '));
  assert.ok(labels.some((t) => /^Sell ≈9:32 AM −\$3,777$/.test(t)), 'labels: ' + labels.join(' | '));
});

test('draw: an open position gets its entry and stop lines only while the account holds it', () => {
  const lines = (held) => {
    const ctx = fakeCtx();
    TM.draw(ctx, { trades: marks.DIA, bars: FIVE, tf: '5m', held, ...SCALE, y: (p) => 300 - (p - 440) * 4 });
    return ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]).filter((t) => /^(Entry|Stop) /.test(t));
  };
  assert.deepStrictEqual(lines(true), ['Entry 491.70', 'Stop 452.57']);
  assert.deepStrictEqual(lines(null), ['Entry 491.70', 'Stop 452.57'], 'unknown positions: the journal is trusted');
  assert.deepStrictEqual(lines(false), [], 'a line was drawn for a position the account does not hold');
});

test('draw: an open position older than the chart still shows its lines, with the entry time written on', () => {
  const ctx = fakeCtx();
  const hits = TM.draw(ctx, { trades: marks.DIA, bars: session('2026-11-20'), tf: '5m', held: true, ...SCALE, y: (p) => 300 - (p - 440) * 4 });
  assert.strictEqual(hits.length, 0, 'a mark was drawn for a moment that is not on the chart');
  const labels = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(labels.includes('Entry 491.70  ·  in Nov 19, 3:55 PM ET'), 'labels: ' + labels.join(' | '));
});

test('draw: a stop beyond the visible prices is named at the edge it lies past, not dropped', () => {
  const ctx = fakeCtx();
  // 470..545 on screen: the 491.70 entry is in view, the 452.57 stop is below it.
  TM.draw(ctx, { trades: marks.DIA, bars: FIVE, tf: '5m', held: true, ...SCALE, y: (p) => 300 - (p - 470) * 4 });
  const labels = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(labels.includes('Entry 491.70'), 'labels: ' + labels.join(' | '));
  assert.ok(labels.includes('Stop 452.57 ↓'), 'labels: ' + labels.join(' | '));
});

test('hitAt finds the nearest mark within reach, and nothing beyond it', () => {
  TM._resetForTests();
  TM.remember('chart-X', [{ x: 100, y: 100, mark: 'a' }, { x: 130, y: 100, mark: 'b' }], null);
  assert.strictEqual(TM.hitAt('chart-X', 104, 103).mark, 'a');
  assert.strictEqual(TM.hitAt('chart-X', 127, 99).mark, 'b');
  assert.strictEqual(TM.hitAt('chart-X', 113, 100), null);
  assert.strictEqual(TM.hitAt('chart-X', 113, 100, 26).mark, 'a', 'a finger reaches further than a mouse');
  assert.strictEqual(TM.hitAt('chart-nope', 100, 100), null);
});

test('load keeps what it has when the server says nothing changed, and never throws', async () => {
  TM._resetForTests();
  const reply = (body, ok = true) => async () => ({ ok, headers: { get: () => 'application/json' }, json: async () => body });
  assert.strictEqual(await TM.load(reply({ version: '3:x', symbols: { SMH: marks.SMH } })), true);
  assert.strictEqual(TM.forSymbol('smh').length, 1);
  let asked = '';
  assert.strictEqual(await TM.load(async (u) => { asked = u; return reply({ version: '3:x', unchanged: true })(); }), false);
  assert.strictEqual(asked, '/api/trading/chart-trades?have=3%3Ax');
  assert.strictEqual(TM.forSymbol('SMH').length, 1, 'an unchanged answer wiped the trades');
  assert.strictEqual(await TM.load(reply({}, false)), false);                                 // 403 for a guest
  assert.strictEqual(await TM.load(async () => { throw new Error('offline'); }), false);
  assert.strictEqual(await TM.load(async () => ({ ok: true, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } })), false);
  assert.strictEqual(TM.forSymbol('SMH').length, 1);
});

// ── the page ─────────────────────────────────────────────────────────────────

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');

test('the trader page loads the module, draws from it inside the price pane, and follows the pointer', () => {
  assert.ok(PAGE.indexOf('/js/trade-marks.js') > 0 && PAGE.indexOf('/js/trade-marks.js') < PAGE.indexOf('</head>'));
  assert.match(PAGE, /_cs\('trading\.tradeMarks'\) !== false && window\.TradeMarks/);
  assert.match(PAGE, /TradeMarks\.remember\(canvas\.id, TradeMarks\.draw\(ctx, \{ trades:_tmTrades, bars, tf:timeframe, slotW, pw, priceH, y, held:_tmHeld/);
  assert.match(PAGE, /TradeMarks\.hover\(ladder, canvasId, x, y/);
  assert.match(PAGE, /TradeMarks\.unhover\(ladder\)/);
  // The journal is trade-gated: a signed-out page never asks for it.
  assert.match(PAGE, /async function loadTradeMarks\(\)\{\n {2}if\(window\.GUEST \|\|/);
  assert.match(PAGE, /setInterval\(loadTradeMarks,\s+30000\)/);
});

test('the endpoint stays behind the trade entitlement and is wired into the trading router', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const pub = server.slice(server.indexOf('const PUBLIC_TRADING_READS'), server.indexOf('function tradeApiGuard'));
  assert.ok(!pub.includes('chart-trades'), 'the journal\'s trades must not be a public read');
  const router = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trading.js'), 'utf8');
  assert.match(router, /require\('\.\/trading\/chart-trades'\)/);
  assert.match(router, /await chartTradesRoutes\(req, res, url, ctx\)/);
});
