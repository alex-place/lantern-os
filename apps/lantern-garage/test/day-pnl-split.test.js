'use strict';
/**
 * day-pnl-split.test.js — the day split into what is banked and what is only marked (lib/day-pnl-split).
 *
 * The fixture is Wednesday 2026-11-04 on the engine's account, against Tuesday's close: realized M -$608,
 * C +$315, O +$139; -$33 at 16:00; -$329 at 20:00. The operator read that day as a win the trader failed
 * to capture; the page had one number for it. The real cents are pinned too (journals and the broker's
 * curve, read 11-05).
 *
 * Pinned here: the three add up to the equity change to the cent; the after-hours line starts at the
 * session's real close, 13:00 on an early close; the session follows the baseline's date, not the
 * calendar's (at 01:45 ET Thursday Alpaca's last_equity was still Tuesday's close); a missing journal,
 * an unlisted one and an exit with no P&L are unknown, never $0.00.
 * Run: node --test apps/lantern-garage/test/day-pnl-split.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const split = require('../lib/day-pnl-split');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'day-split-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

let dirs = 0;
/** A journal directory: { M: [rows], C: [rows] } -> sources in lib/day-pnl tradesLedgerSources' shape. */
function journals(byName, { primary = {}, list } = {}) {
  const dir = path.join(ROOT, 'd' + (++dirs));
  fs.mkdirSync(dir);
  const write = (file, rows) => fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  const pathOf = (n) => path.join(dir, n + '.autopilot-trades.jsonl');
  for (const [n, rows] of Object.entries(byName)) write(pathOf(n), rows);
  const own = path.join(dir, 'autopilot-trades.jsonl');
  write(own, primary.rows || [{ ts: '2026-09-01T14:00:00Z', event: 'noop' }]);
  return { dir, sources: { primary: own, extras: (list || Object.keys(byName)).map(pathOf) } };
}
const exit = (symbol, pnl, ts, more = {}) => ({ ts, event: 'exit', symbol, qty: 10, entry: 1, exit: 2, pnl, order_id: `${symbol}-${ts}-${pnl}`, ...more });
const session = (date, ts, equity) => ({ ts, event: 'session', date, equity });

// Wednesday 2026-11-04 is EST: 16:00 ET = 21:00Z, 20:00 ET = 01:00Z the next day.
const AT = {
  wed0930: Date.parse('2026-11-04T14:30:00Z'), wed1400: Date.parse('2026-11-04T19:00:00Z'), wed1559: Date.parse('2026-11-04T20:59:00Z'),
  wed1600: Date.parse('2026-11-04T21:00:00Z'), wed2000: Date.parse('2026-11-05T01:00:00Z'),
  thu0145: Date.parse('2026-11-05T06:45:00Z'), thu0700: Date.parse('2026-11-05T12:00:00Z'), thu0930: Date.parse('2026-11-05T14:30:00Z'),
};
const PREV = 98996.84;
const curve = (points) => async () => ({ timestamps: points.map(([iso]) => Date.parse(iso) / 1000), equity: points.map(([, e]) => e) });

// The task's round figures: M -608, C +315, O +139.
const ROUND = {
  M: [exit('UPRO', -200, '2026-11-04T15:51:34Z'), exit('SOXS', -408, '2026-11-04T16:45:32Z')],
  C: [exit('TNA', 190, '2026-11-04T20:50:51Z'), exit('IWM', 125, '2026-11-04T20:51:54Z')],
  O: [exit('SPY', 80, '2026-11-04T14:40:33Z'), exit('QQQ', 59, '2026-11-04T14:40:38Z')],
  S: [{ ts: '2026-11-04T15:00:00Z', event: 'skip', symbol: 'SPY', reason: 'no signal' }],
};
// The real rows.
const REAL = {
  M: [['UPRO', -83.76, '15:51:34'], ['TQQQ', -157.19, '16:00:35'], ['UPRO', -67.64, '16:05:31'], ['TQQQ', -120.16, '16:05:34'], ['SOXS', -147.39, '16:45:32'], ['SOXS', -50.1, '20:20:30'], ['UPRO', 19.3, '20:30:34'], ['SOXS', -1.05, '20:35:31']]
    .map(([s, p, t]) => exit(s, p, `2026-11-04T${t}Z`)),
  C: [exit('TNA', 189.36, '2026-11-04T20:50:51Z'), exit('IWM', 125.6, '2026-11-04T20:51:54Z')],
  O: [exit('QQQ', 59.22, '2026-11-04T14:40:38Z'), exit('SPY', 79.47, '2026-11-04T14:40:33Z')],
};
const pnlOf = (s, name) => s.realized.journals.find((j) => j.name === name);
const added = (s) => Math.round((s.realized.total + s.marks + (s.after_hours || 0)) * 100) / 100;

test('Wednesday 2026-11-04 at 20:00: banked -$154, marks +$121, after hours -$296, and they add up to -$329', async () => {
  const { sources } = journals(ROUND);
  const s = await split.forAccount({
    equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000,
    readHistory: curve([['2026-11-04T20:55:00Z', PREV - 169], ['2026-11-04T21:00:00Z', PREV - 33], ['2026-11-04T21:05:00Z', PREV + 15]]),
    historyKey: 'wed-round',
  });
  assert.strictEqual(s.session_date, '2026-11-04');
  assert.strictEqual(s.phase, 'after_close');
  assert.strictEqual(pnlOf(s, 'M').pnl, -608);
  assert.strictEqual(pnlOf(s, 'C').pnl, 315);
  assert.strictEqual(pnlOf(s, 'O').pnl, 139);
  assert.strictEqual(pnlOf(s, 'S').pnl, 0, 'a readable journal with nothing closed is a real zero');
  assert.strictEqual(pnlOf(s, 'S').exits, 0);
  assert.strictEqual(s.realized.total, -154);
  assert.strictEqual(s.marks, 121);
  assert.strictEqual(s.after_hours, -296);
  assert.strictEqual(s.after_hours_applies, true);
  assert.strictEqual(s.day_pnl, -329);
  assert.strictEqual(added(s), s.day_pnl);
  assert.strictEqual(s.close_source, 'broker history');
  assert.strictEqual(s.marks_include_after_hours, false);
});

test('the same day to the cent: the real journal rows and the broker curve', async () => {
  const { sources } = journals(REAL);
  const s = await split.forAccount({
    equity: 98667.94, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000,
    readHistory: curve([['2026-11-04T21:00:00Z', 98964.31]]), historyKey: 'wed-real',
  });
  assert.strictEqual(pnlOf(s, 'M').pnl, -607.99);
  assert.strictEqual(pnlOf(s, 'M').exits, 8);
  assert.strictEqual(pnlOf(s, 'C').pnl, 314.96);
  assert.strictEqual(pnlOf(s, 'O').pnl, 138.69);
  assert.strictEqual(s.realized.total, -154.34);
  assert.strictEqual(s.marks, 121.81);
  assert.strictEqual(s.after_hours, -296.37);
  assert.strictEqual(s.day_pnl, -328.9);
  assert.strictEqual(added(s), -328.9);
});

test('no after-hours line until the close; from 16:00 it is its own line', async () => {
  const { sources } = journals(ROUND);
  const hist = curve([['2026-11-04T21:00:00Z', PREV - 33]]);
  const open = await split.forAccount({ equity: PREV + 394, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed0930, readHistory: hist, historyKey: 'open' });
  assert.strictEqual(open.phase, 'session');
  assert.strictEqual(open.after_hours_applies, false);
  assert.strictEqual(open.after_hours, null);
  const last = await split.forAccount({ equity: PREV - 100, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed1559, readHistory: hist, historyKey: 'last' });
  assert.strictEqual(last.phase, 'session');
  assert.strictEqual(last.marks, last.day_pnl - last.realized.total, 'in the session marks are everything not banked');
  const bell = await split.forAccount({ equity: PREV - 33, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed1600, readHistory: hist, historyKey: 'bell' });
  assert.strictEqual(bell.phase, 'after_close');
  assert.strictEqual(bell.after_hours_applies, true);
  assert.strictEqual(bell.after_hours, 0, 'at the bell the move since the close is a real zero');
  assert.strictEqual(bell.marks, 121);
  assert.strictEqual(added(bell), -33);
});

test('the session follows the baseline, not the calendar: at 01:45 ET Thursday the day still holds all of Wednesday', async () => {
  const { sources } = journals(REAL);
  const s = await split.forAccount({
    equity: 98208.01, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.thu0145,   // the broker read at that hour: last_equity 98996.84
    readHistory: curve([['2026-11-04T21:00:00Z', 98964.31]]), historyKey: 'thu0145',
  });
  assert.strictEqual(s.session_date, '2026-11-04');
  assert.strictEqual(s.is_today, false);
  assert.strictEqual(s.phase, 'after_close');
  assert.strictEqual(s.realized.total, -154.34, 'not the $0.00 of a Thursday that has closed nothing');
  assert.strictEqual(s.marks, 121.81);
  assert.strictEqual(s.after_hours, -756.3);
  assert.strictEqual(s.day_pnl, -788.83);
  assert.strictEqual(added(s), -788.83);
});

test('once the baseline rolls the new session starts: everything since the close is marks, with nothing banked yet', async () => {
  const { sources } = journals(REAL);
  const s = await split.forAccount({ equity: 98303.39, prevEquity: 98962.28, baselineDate: '2026-11-04', sources, now: AT.thu0700, readHistory: async () => { throw new Error('not asked before the close'); }, historyKey: 'thu0700' });
  assert.strictEqual(s.session_date, '2026-11-05');
  assert.strictEqual(s.is_today, true);
  assert.strictEqual(s.phase, 'pre_open');
  assert.strictEqual(s.realized.total, 0);
  assert.strictEqual(s.marks, -658.89);
  assert.strictEqual(s.after_hours_applies, false);
});

test('a missing journal is unknown, never $0.00, and takes the total and the marks with it', async () => {
  const { sources, dir } = journals(ROUND);
  fs.unlinkSync(path.join(dir, 'M.autopilot-trades.jsonl'));
  const s = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000, readHistory: curve([['2026-11-04T21:00:00Z', PREV - 33]]), historyKey: 'missing' });
  const m = pnlOf(s, 'M');
  assert.strictEqual(m.status, 'missing');
  assert.strictEqual(m.pnl, null);
  assert.strictEqual(s.realized.total, null, 'C + O alone would be a partial figure that reads as the day');
  assert.strictEqual(s.marks, null, 'marks is what is left after banked');
  assert.strictEqual(pnlOf(s, 'C').pnl, 315, 'the journals that can be read keep their figures');
  assert.strictEqual(pnlOf(s, 'O').pnl, 139);
  assert.strictEqual(s.after_hours, -296, 'the after-hours move needs no journal');
  assert.strictEqual(s.day_pnl, -329);
  assert.match(s.notes.join(' '), /The M journal could not be read/);
  assert.ok(!s.notes.join(' ').includes(path.sep + 'd'), 'no directory on the page');
});

test('an unreadable primary ledger is unknown too, however many extras can be read', async () => {
  const { sources } = journals(ROUND);
  fs.unlinkSync(sources.primary);
  const s = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000, historyKey: 'primary' });
  assert.strictEqual(pnlOf(s, 'Trader').status, 'missing');
  assert.strictEqual(s.realized.total, null);
});

test('a sleeve the server was not told about: the 2026-10-05 failure. Unknown, not a silent $0', async () => {
  const { sources } = journals({ ...ROUND, R: [exit('TLT', -113.12, '2026-10-02T15:00:00Z')] }, { list: ['S', 'C', 'O'] });
  const s = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000, historyKey: 'unlisted' });
  assert.strictEqual(pnlOf(s, 'M').status, 'unlisted', "M closed trades today and is not in the list");
  assert.strictEqual(pnlOf(s, 'M').exits, 2);
  assert.strictEqual(pnlOf(s, 'M').pnl, null);
  assert.strictEqual(s.realized.total, null);
  assert.strictEqual(s.marks, null);
  assert.strictEqual(pnlOf(s, 'R'), undefined, 'an old journal with nothing today is not a problem');
  assert.match(s.notes.join(' '), /M has 2 closed trade\(s\) in this session but is not listed in TRADER_TRADES_LOG_EXTRA/);
});

test('an exit with no P&L on record is unknown too: dropping it would read as a smaller loss', async () => {
  const { sources } = journals({ ...ROUND, S: [exit('SMH', null, '2026-11-04T14:33:44Z', { entry: null })] });
  const s = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000, historyKey: 'nopnl' });
  assert.strictEqual(pnlOf(s, 'S').status, 'no_pnl');
  assert.strictEqual(pnlOf(s, 'S').pnl, null);
  assert.strictEqual(s.realized.total, null);
  assert.match(s.notes.join(' '), /S has 1 closed trade\(s\) with no P&L/);
});

test('the close comes from the broker\'s point AT the closing minute, never one near it', () => {
  const hist = (points) => ({ timestamps: points.map(([iso]) => Date.parse(iso) / 1000), equity: points.map(([, e]) => e) });
  assert.deepStrictEqual(split.closeFromHistory(hist([['2026-11-04T20:55:00Z', 98827.45], ['2026-11-04T21:00:00Z', 98964.31], ['2026-11-04T21:05:00Z', 98979.61]]), '2026-11-04'), { equity: 98964.31, source: 'broker history' });
  assert.strictEqual(split.closeFromHistory(hist([['2026-11-04T20:55:00Z', 98827.45], ['2026-11-04T21:05:00Z', 98979.61]]), '2026-11-04'), null, 'the auction moved the account $137 in those five minutes');
  assert.strictEqual(split.closeFromHistory(hist([['2026-11-03T21:00:00Z', 98996.84]]), '2026-11-04'), null, "another day's close");
  assert.strictEqual(split.closeFromHistory(hist([['2026-11-04T21:00:00Z', null]]), '2026-11-04'), null);
  assert.strictEqual(split.closeFromHistory({ ok: false, reason: 'no Alpaca account' }, '2026-11-04'), null);
});

test('without the broker\'s point: the session row in the minutes after the close, named as such; otherwise marks say they hold the after-hours move', async () => {
  const rows = [session('2026-11-04', '2026-11-04T21:00:22Z', PREV - 15), session('2026-11-04', '2026-11-04T21:00:23Z', PREV - 8)];
  const { sources } = journals({ ...ROUND, S: rows });
  const s = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.wed2000, readHistory: async () => ({ ok: false }), historyKey: 'row' });
  assert.strictEqual(s.close_equity, PREV - 15, 'the earliest row');
  assert.strictEqual(s.close_source, 'session row 16:00 ET');
  assert.strictEqual(s.after_hours, -314);
  assert.strictEqual(added(s), -329);

  const late = journals({ ...ROUND, S: [session('2026-11-04', '2026-11-04T21:47:31Z', PREV - 200)] });
  const n = await split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources: late.sources, now: AT.wed2000, readHistory: async () => { throw new Error('down'); }, historyKey: 'late-row' });
  assert.strictEqual(n.after_hours, null, 'a restart at 16:47 is not the close');
  assert.strictEqual(n.after_hours_applies, true, 'the line stays and says unknown');
  assert.strictEqual(n.marks_include_after_hours, true);
  assert.strictEqual(n.marks, -175);
  assert.strictEqual(n.realized.total + n.marks, n.day_pnl);
  assert.match(n.notes.join(' '), /account value at the close is not known yet/);
});

test('an early close: after hours starts at 13:00, and the 16:00 session row is not the close', async () => {
  // Friday 2026-11-27, the day after Thanksgiving. 13:00 ET = 18:00Z. The baseline is Wednesday 11-25.
  const rows = { M: [exit('UPRO', 50, '2026-11-27T17:00:00Z')], S: [session('2026-11-27', '2026-11-27T21:00:20Z', 100500)] };
  const hist = curve([['2026-11-27T18:00:00Z', 100100]]);
  const { sources } = journals(rows);
  const before = await split.forAccount({ equity: 100080, prevEquity: 100000, baselineDate: '2026-11-25', sources, now: Date.parse('2026-11-27T17:59:00Z'), readHistory: hist, historyKey: 'half-before' });
  assert.strictEqual(before.session_date, '2026-11-27');
  assert.strictEqual(before.phase, 'session');
  assert.strictEqual(before.after_hours_applies, false);
  const atClose = await split.forAccount({ equity: 100150, prevEquity: 100000, baselineDate: '2026-11-25', sources, now: Date.parse('2026-11-27T18:30:00Z'), readHistory: hist, historyKey: 'half-close' });
  assert.strictEqual(atClose.phase, 'after_close');
  assert.strictEqual(atClose.close_equity, 100100);
  assert.strictEqual(atClose.after_hours, 50);
  assert.strictEqual(atClose.marks, 50);
  assert.strictEqual(atClose.realized.total, 50);
  const noCurve = await split.forAccount({ equity: 100150, prevEquity: 100000, baselineDate: '2026-11-25', sources, now: Date.parse('2026-11-27T21:30:00Z'), historyKey: 'half-row' });
  assert.strictEqual(noCurve.after_hours, null, 'the brains write their row at 16:00 whatever the close was');
});

test('the broker is asked at most once a minute after a miss, and not at all once it has answered', async () => {
  const { sources } = journals(ROUND);
  let asked = 0, answer = { timestamps: [], equity: [] };
  const readHistory = async () => { asked++; return answer; };
  const at = (ms) => split.forAccount({ equity: PREV - 329, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: ms, readHistory, historyKey: 'throttle' });
  await at(AT.wed2000);
  await at(AT.wed2000 + 30000);
  assert.strictEqual(asked, 1, 'a poll every 30 s does not mean a broker call every 30 s');
  answer = { timestamps: [Date.parse('2026-11-04T21:00:00Z') / 1000], equity: [PREV - 33] };
  const s = await at(AT.wed2000 + 61000);
  assert.strictEqual(asked, 2);
  assert.strictEqual(s.after_hours, -296);
  await at(AT.wed2000 + 200000);
  assert.strictEqual(asked, 2, 'the close cannot change: it is pinned');
});

test('the point at the close is not pinned in the first minutes after it', async () => {
  const { sources } = journals(ROUND);
  let asked = 0;
  const readHistory = async () => { asked++; return { timestamps: [Date.parse('2026-11-04T21:00:00Z') / 1000], equity: [PREV - 33] }; };
  const at = (ms) => split.forAccount({ equity: PREV - 33, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: ms, readHistory, historyKey: 'settle' });
  await at(AT.wed1600 + 10000);
  await at(AT.wed1600 + 80000);
  assert.strictEqual(asked, 2, 'still settling at 16:01: asked again');
  await at(AT.wed1600 + 400000);
  assert.strictEqual(asked, 3);
  await at(AT.wed1600 + 500000);
  assert.strictEqual(asked, 3, 'pinned from 16:05');
});

test('one fill in two journals counts once; partial fills inside one journal all count', async () => {
  const { sources } = journals({
    M: [exit('UPRO', -10, '2026-11-04T15:00:00Z', { order_id: 'a' }), exit('UPRO', -5, '2026-11-04T15:00:01Z', { order_id: 'a' })],
    C: [exit('UPRO', -10, '2026-11-04T15:00:00Z', { order_id: 'a' }), exit('TNA', 7, '2026-11-04T15:10:00Z', { order_id: 'b' })],
  });
  const s = await split.forAccount({ equity: 100000, prevEquity: 100000, baselineDate: '2026-11-03', sources, now: AT.wed1400, historyKey: 'dedupe' });
  assert.strictEqual(pnlOf(s, 'M').pnl, -15);
  assert.strictEqual(pnlOf(s, 'C').pnl, 7, 'the fill M already booked is not C\'s too');
  assert.strictEqual(s.realized.total, -8);
});

test('a fill journaled today under an earlier date is said out loud, and left out', async () => {
  // SLV: stop placed 10-12, filled at the 10-14 open, row stamped at placement. -$8,132 on a page that read -$6,375.
  const { sources } = journals({ S: [exit('SLV', -8132.1, '2026-10-12T16:07:13Z', { discovered_at: '2026-10-14T13:30:25Z' })] });
  const s = await split.forAccount({ equity: 974554.44, prevEquity: 991696, baselineDate: '2026-10-13', sources, now: Date.parse('2026-10-14T18:00:00Z'), historyKey: 'late' });
  assert.strictEqual(pnlOf(s, 'S').pnl, 0);
  assert.match(s.notes.join(' '), /SLV \(S, -8132\.10\) was journaled this session under an earlier date/);
  const own = await split.forAccount({ equity: 974554.44, prevEquity: 991696, baselineDate: '2026-10-09', sources, now: Date.parse('2026-10-12T18:00:00Z'), historyKey: 'late2' });
  assert.strictEqual(pnlOf(own, 'S').pnl, -8132.1, 'it stays on the date the row carries');
});

test('estimated rows count, and the note says so', async () => {
  const { sources } = journals({ M: [exit('LNG', -40, '2026-11-04T15:00:00Z', { estimated: true, status: 'reconstructed' })] });
  const s = await split.forAccount({ equity: 100000, prevEquity: 100040, baselineDate: '2026-11-03', sources, now: AT.wed1400, historyKey: 'estimated' });
  assert.strictEqual(s.realized.total, -40);
  assert.match(s.notes.join(' '), /M includes 1 trade\(s\) priced from the last mark/);
});

test('exit_superseded, exit_intent and torn lines are not closed trades', async () => {
  const { sources } = journals({ M: [
    { ts: '2026-11-04T15:00:00Z', event: 'exit_superseded', symbol: 'UPRO', pnl: 9999, exit: 1 },
    { ts: '2026-11-04T15:00:00Z', event: 'exit_intent', symbol: 'UPRO', exit: 1 },
    '{"ts":"2026-11-04T15:00:00Z","event":"exit","symbol":"UPRO","pn',
    exit('UPRO', -1, '2026-11-04T15:01:00Z'),
  ] });
  const s = await split.forAccount({ equity: 100000, prevEquity: 100001, baselineDate: '2026-11-03', sources, now: AT.wed1400, historyKey: 'rows' });
  assert.strictEqual(pnlOf(s, 'M').pnl, -1);
  assert.strictEqual(pnlOf(s, 'M').exits, 1);
});

test('the stable server\'s overnight book is banked too: it closes on overnight_book_gone rows in the same ledger', async () => {
  const gone = (symbol, pnl, more = {}) => ({ ts: '2026-11-04T14:43:27Z', event: 'overnight_book_gone', symbol, qty: 69, bought_day: '2026-11-03', sold: true, why: 'sold', order_id: 'b-' + symbol, pnl, ...more });
  const { sources } = journals({}, { primary: { rows: [
    exit('NUGT', 10104.4, '2026-11-04T14:30:33Z'), exit('SMH', -1332.64, '2026-11-04T14:30:05Z'), exit('GDX', 6876.92, '2026-11-04T14:51:51Z'),
    gone('SPY', 789.74), gone('QQQ', 630.88),
    { ts: '2026-11-04T14:43:28Z', event: 'overnight_book_gone', symbol: 'SMH', qty: 23, bought_day: '2026-11-03', sold: false, why: 'not held at the broker' },
    gone('DIA', 5, { ts: '2026-11-03T14:43:27Z', order_id: 'b-yesterday' }),
  ] } });
  const s = await split.forAccount({ equity: 1000000, prevEquity: 980000, baselineDate: '2026-11-03', sources, now: AT.wed1400, historyKey: 'book' });
  assert.deepStrictEqual(s.realized.journals.map((j) => [j.name, j.pnl, j.exits]), [['Trader', 15648.68, 3], ['O', 1420.62, 2]]);
  assert.strictEqual(s.realized.total, 17069.3);
  assert.strictEqual(s.marks, 2930.7);

  const unpriced = journals({}, { primary: { rows: [gone('SPY', null, { fill_px: null, fill_why: 'broker never priced it' })] } });
  const u = await split.forAccount({ equity: 1000000, prevEquity: 980000, baselineDate: '2026-11-03', sources: unpriced.sources, now: AT.wed1400, historyKey: 'book2' });
  assert.strictEqual(u.realized.journals.find((j) => j.name === 'O').status, 'no_pnl', 'a sale the broker never priced is unknown');
  assert.strictEqual(u.realized.total, null);

  const none = journals({}, { primary: { rows: [exit('NUGT', 10, '2026-11-04T14:30:33Z')] } });
  const n = await split.forAccount({ equity: 1000000, prevEquity: 980000, baselineDate: '2026-11-03', sources: none.sources, now: AT.wed1400, historyKey: 'book3' });
  assert.deepStrictEqual(n.realized.journals.map((j) => j.name), ['Trader'], 'a day the book closed nothing has no line for it');
});

test('fills are dated in ET: a 20:30 ET fill is that day, though UTC says tomorrow', async () => {
  const { sources } = journals({ M: [exit('UPRO', -3, '2026-11-05T01:30:00Z')] });
  const s = await split.forAccount({ equity: 100000, prevEquity: 100003, baselineDate: '2026-11-03', sources, now: Date.parse('2026-11-05T02:00:00Z'), historyKey: 'et' });
  assert.strictEqual(s.session_date, '2026-11-04');
  assert.strictEqual(pnlOf(s, 'M').pnl, -3);
});

test('no previous close on record: banked is still known, marks are not', () => {
  const session_ = split.sessionFor('2026-11-03', AT.wed1400);
  const s = split.buildSplit({ equity: 100000, prevEquity: undefined, session: session_, journals: [{ name: 'Trader', pnl: -5, exits: 1, status: 'ok' }] });
  assert.strictEqual(s.realized.total, -5);
  assert.strictEqual(s.marks, null);
  assert.strictEqual(s.day_pnl, null);
  assert.match(s.notes.join(' '), /No previous close on record/);
});

test('a baseline older than the last session: everything unknown, rather than a label that is not true', async () => {
  const { sources } = journals(REAL);
  const s = await split.forAccount({ equity: 98000, prevEquity: PREV, baselineDate: '2026-11-03', sources, now: AT.thu0930, historyKey: 'stale' });
  assert.strictEqual(s.phase, 'stale');
  assert.strictEqual(s.realized.total, null);
  assert.strictEqual(s.marks, null);
  assert.strictEqual(s.after_hours_applies, false);
  assert.strictEqual(s.day_pnl, -996.84, 'the figure itself is untouched');
  assert.match(s.notes.join(' '), /older than the last session/);
});

test('sessionFor: weekends, holidays and a missing baseline', () => {
  const at = (iso) => Date.parse(iso);
  // Friday's close is the baseline on Saturday: the next session is Monday, and nothing has happened in it.
  assert.deepStrictEqual(split.sessionFor('2026-11-06', at('2026-11-07T15:00:00Z')), { date: '2026-11-09', phase: 'pre_open', is_today: false });
  // Not rolled yet on Saturday morning: still Friday's session, after its close.
  assert.deepStrictEqual(split.sessionFor('2026-11-05', at('2026-11-07T06:00:00Z')), { date: '2026-11-06', phase: 'after_close', is_today: false });
  // Thanksgiving: Wednesday's close leads to Friday, the early close.
  assert.deepStrictEqual(split.sessionFor('2026-11-25', at('2026-11-26T15:00:00Z')), { date: '2026-11-27', phase: 'pre_open', is_today: false });
  // No baseline date: the clock. Before 04:00 ET it is still yesterday's session; from 04:00 today's.
  assert.strictEqual(split.sessionFor(null, at('2026-11-05T06:45:00Z')).date, '2026-11-04');
  assert.strictEqual(split.sessionFor(null, at('2026-11-05T09:30:00Z')).date, '2026-11-05');
  assert.strictEqual(split.sessionFor('not a date', at('2026-11-05T15:00:00Z')).date, '2026-11-05');
  assert.strictEqual(split.sessionFor(null, at('2026-11-07T15:00:00Z')).date, '2026-11-06', 'a Saturday reads Friday');
});

test('journal names: the sleeve letter, and never a path', () => {
  assert.strictEqual(split.journalName('C:/dev/two-sleeve-armed/M.autopilot-trades.jsonl'), 'M');
  assert.strictEqual(split.journalName('/data/autopilot-trades.jsonl'), 'Trader');
  assert.strictEqual(split.journalName('/x/odd.jsonl'), 'odd');
  assert.strictEqual(split.journalName('/x/<img src=x>.jsonl'), 'imgsrcx');
});

test('the three add up to the cent on awkward numbers, and the journals add up to banked', () => {
  const session_ = split.sessionFor('2026-11-03', AT.wed2000);
  for (const [a, b, c, prev, close, eq] of [
    [0.1, 0.2, 0.3, 100000.1, 100000.7, 100001.3],
    [-607.99, 314.96, 138.69, 98996.84, 98964.31, 98667.94],
    [1234.56, -1234.55, 0.01, 963377, 965004.06, 964990.01],
    [33.33, 33.33, 33.34, 99999.99, 100100.01, 100099.98],
  ]) {
    const journals_ = [['M', a], ['C', b], ['O', c]].map(([name, pnl]) => ({ name, pnl, exits: 1, status: 'ok' }));
    const s = split.buildSplit({ equity: eq, prevEquity: prev, session: session_, journals: journals_, close: { equity: close, source: 'broker history' } });
    const toCents = (v) => Math.round(v * 100);
    assert.strictEqual(toCents(s.realized.total) + toCents(s.marks) + toCents(s.after_hours), Math.round((eq - prev) * 100), `${prev} -> ${eq}`);
    assert.strictEqual(toCents(s.realized.total), toCents(a) + toCents(b) + toCents(c));
  }
});
