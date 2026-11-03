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
 * The two choices of the design L25 + C1 (2026-11-03), off by default:
 *   - one decision bar: nothing is offered on the 15:45 bar's read, the 15:50 bar decides, also on a 13:00 close;
 *   - the news gate: every cell of SHOCK x gamma on real file shapes, closed only on two good readings; a closed gate refuses the buy and
 *     keeps the sell; every missing or untrusted reading leaves it open; it reads once a day and writes one row; off, the files are not read.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloseIbsScan, newsGate, ONE_DECISION_BAR, NEWS_MAX_AGE_MS } = require('../lib/two-sleeve/closeibs-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');
const cal = require('../lib/market-calendar');

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

test('a dry run s clock pin reaches the custom scan: an after-hours rehearsal replays Tuesday 15:50 and the washout is a buy', async () => {
  // the fake feed holds one synthetic Tuesday (2026-09-22) on which SPY closes on its low all day
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-pin-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = path.resolve(__dirname, '..', 'lib', 'two-sleeve', 'closeibs-scan.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'closeibs-scan.js'), `module.exports = require(${JSON.stringify(real)});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const t0 = Date.parse('2026-09-22T13:30:00Z');",
    "const bars = Array.from({ length: 78 }, (_, i) => { const c = 100 - 3 * (i / 77); return { timestamp: new Date(t0 + i * 300000).toISOString(), open: c, high: c + 0.05, low: c - 0.05, close: c }; });",
    "module.exports = { getBars: async () => ({ bars }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-pin-dir-'));
  const pinned = new ScanWorker({ id: 'C', app, envFile: null, env: {}, universe: ['SPY'], dir, timeoutMs: 8000, scan: 'closeibs', fakeNow: '2026-09-22T19:50:30.000Z' });
  const live = new ScanWorker({ id: 'C2', app, envFile: null, env: {}, universe: ['SPY'], dir, timeoutMs: 8000, scan: 'closeibs' });
  try {
    assert.equal(pinned._childEnv().TWO_SLEEVE_WORKER_FAKE_NOW, '2026-09-22T19:50:30.000Z');
    assert.equal(live._childEnv().TWO_SLEEVE_WORKER_FAKE_NOW, undefined, 'no pin, no variable: an armed runner reads the real clock');
    const r = await pinned.scan();
    assert.equal(r.signals[0].direction, 'BULLISH'); assert.equal(r.closeIbs.window, true);
    const r2 = await live.scan();
    assert.equal(r2.signals[0].direction, 'NEUTRAL', 'on the real clock the synthetic Tuesday is long past');
  } finally { pinned.stop(); live.stop(); }
});

// ---- the design L25 + C1 ----------------------------------------------------------------------------------------------
const DAY = '2026-09-22';                   // a Tuesday; the prior session is Monday 09-21
const dec155 = at(DAY, 15, 55, 22);         // the decision: the first bar-aligned tick that reads the 15:50 bar
const sessionsBefore = (day, n) => { const out = []; for (let d = cal.prevTradingDay(day); out.length < n; d = cal.prevTradingDay(d)) out.unshift(d); return out; };
const TYPES = ['NEWS', 'WRAP', 'SHOCK', 'RATES', 'DATA', 'FED', 'TRADE', 'GEO', 'POLICY', 'HEALTH', 'CORP'];
const groups = (shockSession) => Object.fromEntries(TYPES.map((k) => [k, k === 'SHOCK' ? [0, shockSession] : [0, 0]]));
/**
 * The two shared files as lib/entry-tags.js writes them. shock = the day's session SHOCK count against a history of 0, 1 ... 119: 10 ranks LOW, 60 MID,
 * 100 HIGH. gex = the prior session's rank in its year: 'LOW' | 'MID' | 'HIGH'. seTo = where the day's count ends. Any of them null = that part absent.
 */
function tagFiles({ shock = 60, gex = 'MID', seTo = '2026-09-22T19:50:00.000Z', news = true, gexFile = true, typedHistory = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-gate-'));
  if (news) {
    const history = sessionsBefore(DAY, 120).map((d, i) => ({ d, nOn: 0, nSe: i, on: 0, se: i / (380 / 60), onH: 17.5, ...(typedHistory ? { g: groups(i) } : {}) }));
    fs.writeFileSync(path.join(dir, 'news.json'), JSON.stringify({ v: 1, history,
      today: { d: DAY, nOn: 0, on_final: true, nSe: shock, g: groups(shock), se_to: seTo, final: false, fetched_at: seTo } }));
  }
  if (gexFile) {
    const rows = sessionsBefore(DAY, 300).map((d, i) => [d, i]);
    rows[rows.length - 1][1] = { LOW: -1, MID: rows[rows.length - 127][1], HIGH: 1e9 }[gex];
    if (gex === 'STALE') rows.pop();
    fs.writeFileSync(path.join(dir, 'gex.json'), JSON.stringify({ latest: rows[rows.length - 1][0], rows }));
  }
  return dir;
}
const washout = () => market({ [DAY]: { AAA: falling(), BBB: midRange(), CCC: rising() } });
const gatedScan = (m, dir, log = null, extra = {}) => createCloseIbsScan({ symbols: ['AAA', 'BBB', 'CCC'], getBars: m.getBars, ibsMax: 0.25, decisionBars: ONE_DECISION_BAR, newsGateDir: dir, log, ...extra });

test('one decision bar: the 15:45 bar is not read as a decision, the 15:50 bar decides from 15:55:20, 16:00 ends it', async () => {
  const m = washout();
  const s = createCloseIbsScan({ symbols: ['AAA', 'BBB', 'CCC'], getBars: m.getBars, ibsMax: 0.25, decisionBars: ONE_DECISION_BAR });
  m.now = at(DAY, 15, 50, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').decision_context.close_ibs_bar, '15:50'); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(r.closeIbs.window, false);
  m.now = at(DAY, 15, 55, 10); r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL', 'inside the 20 s settle the 15:50 bar is not read yet');
  m.now = dec155; r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').decision_context.close_ibs_bar, '15:55'); assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(r.closeIbs.window, true);
  assert.equal(r.closeIbs.ibsMax, 0.25); assert.equal(r.closeIbs.gate, undefined, 'no gate asked for, none in the reply');
  assert.equal(sig(r, 'CCC').direction, 'BEARISH');
  m.now = at(DAY, 16, 0, 22); r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL');
});

test('one decision bar on a 13:00 close: the 12:50 bar decides, the 12:45 bar does not', async () => {
  const day = '2026-12-24';   // a Thursday, EST
  const est = (hh, mm, ss = 0) => Date.parse(`${day}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  const t0 = est(9, 30);
  const bars = Array.from({ length: 42 }, (_, i) => { const c = 101 - (2 * i) / 41; return { timestamp: new Date(t0 + i * 300000).toISOString(), open: c, high: c + 0.05, low: c - 0.05, close: c }; });
  let now = 0;
  const s = createCloseIbsScan({ symbols: ['AAA'], getBars: async () => ({ bars: bars.filter((b) => Date.parse(b.timestamp) <= now) }), ibsMax: 0.25, decisionBars: ONE_DECISION_BAR });
  now = est(12, 50, 30); let r = await s.scan(now);
  assert.equal(r.closeIbs.window, false); assert.equal(r.signals[0].direction, 'NEUTRAL');
  now = est(12, 55, 30); r = await s.scan(now);
  assert.equal(r.closeIbs.window, true); assert.equal(r.signals[0].direction, 'BULLISH');
});

test('the news gate on every cell: open on SHOCK HIGH or gamma LOW, closed on the rest', () => {
  const cells = [
    [100, 'LOW', true, 'SHOCK HIGH, gamma LOW'], [100, 'MID', true, 'SHOCK HIGH'], [100, 'HIGH', true, 'SHOCK HIGH'],
    [60, 'LOW', true, 'gamma LOW'], [60, 'MID', false, 'SHOCK MID, gamma MID'], [60, 'HIGH', false, 'SHOCK MID, gamma HIGH'],
    [10, 'LOW', true, 'gamma LOW'], [10, 'MID', false, 'SHOCK LOW, gamma MID'], [10, 'HIGH', false, 'SHOCK LOW, gamma HIGH'],
  ];
  for (const [shock, gex, open, why] of cells) {
    const g = newsGate(tagFiles({ shock, gex }), dec155);
    assert.equal(g.open, open, `${shock} ${gex}`); assert.equal(g.why, why);
    assert.equal(g.gamma.as_of, '2026-09-21'); assert.equal(g.shock.n, shock); assert.equal(g.shock.to, '2026-09-22T19:50:00.000Z');
  }
});

test('a closed gate refuses the buy and keeps the sell; the refused name says why; one row, once a day', async () => {
  const rows = [];
  const m = washout();
  const s = gatedScan(m, tagFiles({ shock: 10, gex: 'HIGH' }), (row) => rows.push(row));
  m.now = dec155; const r = await s.scan(m.now);
  assert.equal(r.closeIbs.window, true); assert.equal(r.closeIbs.gate.open, false);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(sig(r, 'AAA').convergence.decision, 'SKIP');
  assert.match(r.closeIbs.reads.find((x) => x.symbol === 'AAA').why, /news gate: SHOCK LOW, gamma HIGH/);
  assert.equal(sig(r, 'BBB').direction, 'NEUTRAL');
  assert.equal(sig(r, 'CCC').direction, 'BEARISH', 'the sell read does not depend on the gate');
  m.now = at(DAY, 15, 56, 22); await s.scan(m.now);
  assert.equal(rows.length, 1, 'one row a decision day');
  const row = rows[0];
  assert.equal(row.event, 'close_ibs_gate'); assert.equal(row.day, DAY); assert.equal(row.bar, '15:55'); assert.equal(row.open, false);
  assert.deepEqual(row.refused, ['AAA']); assert.deepEqual(row.offered, []);
  assert.equal(row.shock.tercile, 'LOW'); assert.equal(row.gamma.tercile, 'HIGH');
});

test('an open gate lets the buy through and says who passed', async () => {
  const rows = [];
  const m = washout();
  const s = gatedScan(m, tagFiles({ shock: 100, gex: 'HIGH' }), (row) => rows.push(row));
  m.now = dec155; const r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(r.closeIbs.gate.open, true);
  assert.deepEqual(rows[0].offered, ['AAA']); assert.deepEqual(rows[0].refused, []);
});

test('the gate decides once a day: a later read of the files does not change the day', async () => {
  const rows = [];
  const m = washout();
  const dir = tagFiles({ shock: 10, gex: 'HIGH' });
  const s = gatedScan(m, dir, (row) => rows.push(row));
  m.now = dec155; await s.scan(m.now);
  fs.rmSync(path.join(dir, 'news.json'));
  m.now = at(DAY, 15, 56, 22); const r = await s.scan(m.now);
  assert.equal(r.closeIbs.gate.open, false, 'still the 15:55 decision'); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL');
  assert.equal(rows.length, 1);
});

test('missing or untrusted readings leave the gate open, with the reason said', async () => {
  const opens = [
    [{ news: false, gex: 'HIGH' }, /no news counts file/],
    [{ gexFile: false, shock: 10 }, /no CSV row before the entry day/],
    [{ news: false, gexFile: false }, /no news counts file.*no CSV row/],
    [{ gex: 'STALE', shock: 10 }, /the prior session 2026-09-21 is not in the CSV yet/],
    [{ typedHistory: false, shock: 10, gex: 'HIGH' }, /0 of 120 history sessions have type counts/],
    [{ seTo: '2026-09-22T13:45:00.000Z', shock: 10, gex: 'HIGH' }, /the news count runs to/],   // 09:45: past the age limit and under 30 minutes
    [{ seTo: new Date(dec155 - NEWS_MAX_AGE_MS - 1000).toISOString(), shock: 10, gex: 'HIGH' }, /the news count runs to/],
  ];
  for (const [o, why] of opens) {
    const g = newsGate(tagFiles(o), dec155);
    assert.equal(g.open, true, JSON.stringify(o)); assert.match(g.why, why);
    assert.match(g.why, /^no reading/);
  }
  const fresh = newsGate(tagFiles({ seTo: new Date(dec155 - NEWS_MAX_AGE_MS + 60000).toISOString(), shock: 10, gex: 'HIGH' }), dec155);
  assert.equal(fresh.open, false, 'a count inside the age limit is a reading');
  const otherDay = newsGate(tagFiles({ shock: 10, gex: 'HIGH' }), at('2026-09-23', 15, 55, 22));
  assert.equal(otherDay.open, true); assert.match(otherDay.why, /no news counts for 2026-09-23/);
  const threw = newsGate('x', dec155, () => { throw new Error('boom'); });
  assert.equal(threw.open, true); assert.match(threw.why, /no reading \(boom\)/);
  const m = washout();
  m.now = dec155; const r = await gatedScan(m, tagFiles({ news: false, gexFile: false })).scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH', 'with no data the sleeve trades as it would without the gate');
});

test('a corrupt file reads as no reading', () => {
  const dir = tagFiles({ shock: 10, gex: 'HIGH' });
  fs.writeFileSync(path.join(dir, 'news.json'), '{"v":1,"history":[{"d"');
  const g = newsGate(dir, dec155);
  assert.equal(g.open, true); assert.match(g.why, /no news counts file/);
});

test('the gate is never read off its window or without its knob; Friday has no decision', async () => {
  const m = market({ [DAY]: { AAA: falling() }, '2026-09-25': { AAA: falling() } });
  const rows = [];
  const dir = tagFiles({ shock: 10, gex: 'HIGH' });
  const s = createCloseIbsScan({ symbols: ['AAA'], getBars: m.getBars, ibsMax: 0.25, decisionBars: ONE_DECISION_BAR, newsGateDir: dir, log: (row) => rows.push(row) });
  m.now = at(DAY, 11, 0); let r = await s.scan(m.now);
  assert.equal(r.closeIbs.gate, undefined); assert.equal(rows.length, 0);
  m.now = at('2026-09-25', 15, 55, 22); r = await s.scan(m.now);
  assert.equal(r.closeIbs.window, false); assert.equal(r.closeIbs.gate, undefined); assert.equal(rows.length, 0);
  const m2 = washout();
  const off = createCloseIbsScan({ symbols: ['AAA', 'BBB', 'CCC'], getBars: m2.getBars, ibsMax: 0.25, log: (row) => rows.push(row) });
  m2.now = dec155; r = await off.scan(m2.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(r.closeIbs.gate, undefined); assert.equal(rows.length, 0, 'knob off: no gate, no row');
});

test('the worker: the knobs reach the scan, ready says so, a closed day writes its row, the gate without a directory refuses to start', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-knobs-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const reExport = (rel) => `module.exports = require(${JSON.stringify(path.resolve(__dirname, '..', rel).replace(/\\/g, '/'))});\n`;
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'closeibs-scan.js'), reExport('lib/two-sleeve/closeibs-scan.js'));
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), reExport('lib/file-queue.js'));
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const t0 = Date.parse('2026-09-22T13:30:00Z');",
    "const bars = Array.from({ length: 78 }, (_, i) => { const c = 100 - 3 * (i / 77); return { timestamp: new Date(t0 + i * 300000).toISOString(), open: c, high: c + 0.05, low: c - 0.05, close: c }; });",
    "module.exports = { getBars: async () => ({ bars }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closeibs-knobs-dir-'));
  const log = [];
  const tags = tagFiles({ shock: 10, gex: 'HIGH' });
  const on = { TRADER_CLOSE_IBS_MAX: '0.25', TRADER_CLOSE_IBS_ONE_BAR: '1', TRADER_CLOSE_IBS_NEWS_GATE: '1', TRADER_ENTRY_TAGS_DIR: tags };
  const W = new ScanWorker({ id: 'C', app, envFile: null, env: on, universe: ['SPY'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'closeibs', fakeNow: '2026-09-22T19:55:22.000Z' });
  const plain = new ScanWorker({ id: 'P', app, envFile: null, env: { TRADER_CLOSE_IBS_ONE_BAR: '', TRADER_CLOSE_IBS_NEWS_GATE: '' }, universe: ['SPY'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'closeibs', fakeNow: '2026-09-22T19:50:30.000Z' });
  const bad = new ScanWorker({ id: 'X', app, envFile: null, env: { TRADER_CLOSE_IBS_NEWS_GATE: '1', TRADER_ENTRY_TAGS_DIR: '' }, universe: ['SPY'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'closeibs' });
  try {
    const r = await W.scan();
    assert.equal(r.closeIbs.ibsMax, 0.25); assert.equal(r.closeIbs.gate.open, false); assert.equal(r.signals[0].direction, 'NEUTRAL');
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'C');
    assert.equal(ready.oneBar, true); assert.equal(ready.newsGate, true); assert.equal(ready.ibsMax, 0.25);
    const own = path.join(dir, 'C.scan.jsonl');
    for (let i = 0; i < 40 && !fs.existsSync(own); i++) await new Promise((res) => setTimeout(res, 50));
    const rows = fs.readFileSync(own, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1); assert.equal(rows[0].event, 'close_ibs_gate'); assert.deepEqual(rows[0].refused, ['SPY']); assert.ok(rows[0].ts);
    const p = await plain.scan();
    assert.equal(p.signals[0].direction, 'BULLISH', 'blank pins: both bars decide, no gate'); assert.equal(p.closeIbs.ibsMax, 0.15); assert.equal(p.closeIbs.gate, undefined);
    const ready2 = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'P');
    assert.equal(ready2.oneBar, false); assert.equal(ready2.newsGate, false);
    await assert.rejects(bad.scan(), /exited|failed|TRADER_ENTRY_TAGS_DIR/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'X' && /TRADER_ENTRY_TAGS_DIR/.test(String(x.error))));
  } finally { W.stop(); plain.stop(); bad.stop(); }
});
