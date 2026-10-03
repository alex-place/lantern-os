'use strict';
/**
 * two-sleeve-closeibs-scan.test.js — the close-IBS sleeve's scan (2026-10-03, draft).
 *
 * lib/two-sleeve/closeibs-scan.js says what the sleeve wants in the signal shape the brains trade; the brain does the rest
 * (sizing, the stop, the IBS exit with its opening gate, the max hold, the weekend flat). Pinned here on synthetic sessions:
 *   - Mon-Thu, once the 15:45 bar has closed (and its 20 s settle passed), a name closing near its session low (IBS <= 0.15)
 *     is BULLISH / ENTER; a mid-range name is NEUTRAL; a name at its session high (IBS >= 0.6) is BEARISH / ENTER;
 *   - before the 15:45 bar is read (15:44, or 15:50:10 inside the settle) nothing is offered to buy; the 15:50 bar decides too;
 *   - on a Friday nothing is offered to buy (no weekend carry), and the bearish read stays;
 *   - the next morning a bounce (IBS >= 0.6) reads BEARISH outside the entry window, so the brain sells;
 *   - every name is in every scan; a name with no bars is NEUTRAL with the reason said;
 *   - the scan worker runs it under TWO_SLEEVE_WORKER_SCAN=closeibs over the sleeve's universe and refuses to start without one.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloseIbsScan } = require('../lib/two-sleeve/closeibs-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

// 2026-09-22 is a Tuesday, 09-23 a Wednesday, 09-25 a Friday; all EDT (ET = UTC-4)
const at = (day, hh, mm, ss = 0) => Date.parse(`${day}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const session = (day, closes) => closes.map((c, i) => ({ t: Date.parse(`${day}T13:30:00Z`) + i * 300000, h: c + 0.05, l: c - 0.05, c }));
const falling = () => Array.from({ length: 78 }, (_, i) => 100 - 3 * (i / 77));                 // closes on its low all day
const midRange = () => Array.from({ length: 78 }, (_, i) => (i >= 70 ? 100 : (i % 2 ? 101 : 99)));            // swings, then sits mid-range
const rising = () => Array.from({ length: 78 }, (_, i) => 100 + 3 * (i / 77));                  // closes on its high all day
const bounce = () => Array.from({ length: 78 }, (_, i) => (i < 6 ? 97 - 0.1 * i : 96.5 + 0.1 * (i - 5)));   // dips, then rallies
function market(days) {
  const S = {};
  for (const [day, bySym] of Object.entries(days)) for (const [sym, closes] of Object.entries(bySym)) (S[sym] = S[sym] || []).push(...session(day, closes));
  const m = { now: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym) => ({ bars: (S[sym] || []).filter((b) => b.t <= m.now).map(fmt) });   // the in-progress bar included, as the live feed
  return m;
}
async function scanAt(m, ms, symbols = ['AAA', 'BBB', 'CCC']) { m.now = ms; return createCloseIbsScan({ symbols, getBars: m.getBars }).scan(ms); }
const sig = (r, sym) => r.signals.find((x) => x.symbol === sym);

test('Tuesday, once the 15:45 bar is read: the washed-out name is a buy, mid-range neutral, the one at its high a sell', async () => {
  const m = market({ '2026-09-22': { AAA: falling(), BBB: midRange(), CCC: rising() } });
  const r = await scanAt(m, at('2026-09-22', 15, 50, 30));
  assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(sig(r, 'AAA').convergence.decision, 'ENTER');
  assert.ok(sig(r, 'AAA').decision_context.ibs <= 0.15, 'AAA closes near its session low');
  assert.equal(sig(r, 'AAA').decision_context.close_ibs_bar, '15:50');
  assert.equal(sig(r, 'BBB').direction, 'NEUTRAL'); assert.equal(sig(r, 'BBB').convergence.decision, 'SKIP');
  assert.equal(sig(r, 'CCC').direction, 'BEARISH'); assert.equal(sig(r, 'CCC').convergence.decision, 'ENTER');
  assert.equal(r.closeIbs.window, true);
  assert.ok(sig(r, 'AAA').entry_price > 0 && sig(r, 'AAA').entry_price < 98, 'priced from the latest completed bar');
});

test('before the 15:45 bar is read nothing is offered to buy; the 15:50 bar decides too; 16:00 is past the window', async () => {
  const m = market({ '2026-09-22': { AAA: falling(), BBB: midRange(), CCC: rising() } });
  const early = await scanAt(m, at('2026-09-22', 15, 44));
  assert.equal(sig(early, 'AAA').direction, 'NEUTRAL'); assert.equal(early.closeIbs.window, false);
  const settle = await scanAt(m, at('2026-09-22', 15, 50, 10));          // the 15:45 bar closed 10 s ago: not read yet
  assert.equal(sig(settle, 'AAA').decision_context.close_ibs_bar, '15:45'); assert.equal(sig(settle, 'AAA').direction, 'NEUTRAL');
  const second = await scanAt(m, at('2026-09-22', 15, 56));              // the 15:50 bar (closes 15:55) is the second decision bar
  assert.equal(sig(second, 'AAA').decision_context.close_ibs_bar, '15:55'); assert.equal(sig(second, 'AAA').direction, 'BULLISH');
  const after = await scanAt(m, at('2026-09-22', 16, 1));                // the 15:55 bar is not a decision bar, and 16:00 has rung
  assert.equal(sig(after, 'AAA').direction, 'NEUTRAL');
  assert.equal(sig(after, 'CCC').direction, 'BEARISH', 'the sell read does not depend on the window');
});

test('Friday: nothing is offered to buy (no weekend carry); the sell read stays', async () => {
  const m = market({ '2026-09-25': { AAA: falling(), BBB: midRange(), CCC: rising() } });
  const r = await scanAt(m, at('2026-09-25', 15, 50, 30));
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(r.closeIbs.window, false);
  assert.equal(sig(r, 'CCC').direction, 'BEARISH');
});

test('the next morning a bounce reads BEARISH outside the entry window, so the brain sells the held name', async () => {
  const m = market({ '2026-09-22': { AAA: falling() }, '2026-09-23': { AAA: bounce() } });
  const r = await scanAt(m, at('2026-09-23', 10, 31), ['AAA']);
  assert.ok(sig(r, 'AAA').decision_context.ibs >= 0.6, 'bounced off the morning low');
  assert.equal(sig(r, 'AAA').direction, 'BEARISH'); assert.equal(r.closeIbs.window, false);
});

test('a name with no bars is NEUTRAL with the reason said; every name is listed', async () => {
  const m = market({ '2026-09-22': { AAA: falling() } });
  const r = await scanAt(m, at('2026-09-22', 15, 50, 30), ['AAA', 'ZZZ']);
  assert.deepEqual(r.signals.map((x) => x.symbol), ['AAA', 'ZZZ']);
  assert.equal(sig(r, 'ZZZ').direction, 'NEUTRAL');
  assert.match(String(r.closeIbs.reads.find((x) => x.symbol === 'ZZZ').why), /no completed bar today|no bars/);
  assert.throws(() => createCloseIbsScan({ symbols: ['AAA'], getBars: m.getBars, ibsMax: 0.7 }), /ibsMax/);
});

test('the scan worker runs the sleeve under TWO_SLEEVE_WORKER_SCAN=closeibs over its universe and refuses to start without one', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = path.resolve(__dirname, '..', 'lib', 'two-sleeve', 'closeibs-scan.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'closeibs-scan.js'), `module.exports = require(${JSON.stringify(real)});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async () => ({ bars: [bar(Date.now() - 86400000, 100)] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'C', app, envFile: null, env: { TRADER_CLOSE_IBS_MAX: '0.15' }, universe: ['SPY', 'QQQ', 'SOXL'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'closeibs' });
  const bad = new ScanWorker({ id: 'X', app, envFile: null, env: {}, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'closeibs' });
  try {
    assert.equal(W._childEnv().TWO_SLEEVE_WORKER_SCAN, 'closeibs');
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['QQQ', 'SOXL', 'SPY']);
    assert.ok(r.signals.every((x) => x.close_ibs === true && x.convergence.decision === 'SKIP'), 'no session today in the fake feed: nothing to do');
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'C');
    assert.ok(ready, 'the worker reported ready'); assert.equal(ready.scan, 'closeibs'); assert.equal(ready.symbols, 'SPY,QQQ,SOXL'); assert.equal(ready.ibsMax, 0.15);
    await assert.rejects(bad.scan(), /exited|failed|universe/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'X' && /universe/.test(String(x.error))));
  } finally { W.stop(); bad.stop(); }
});
