'use strict';
/**
 * two-sleeve-overnight-scan.test.js — the overnight book's scan (2026-10-09, draft).
 *
 * lib/two-sleeve/overnight-scan.js says what the sleeve wants in the signal shape the brains trade. Pinned on synthetic
 * sessions (5m bars for two days) and synthetic daily bars (260 sessions; AAA rising = above its 200-session mean, BBB
 * falling = below, CCC with 50 sessions = no reading):
 *   - once the 15:50 bar is read (15:55:20 on): AAA is BULLISH / ENTER, BBB NEUTRAL (below the trend), CCC NEUTRAL (no reading);
 *   - before the 15:50 bar is read the sell window still reads (nothing is bought); at 16:00 the window is closed;
 *   - the next morning, from the first read after the 09:35 bar closes (09:40:20): every name is BEARISH / ENTER, and stays
 *     so until the entry window; pre-market and before the 09:35 bar nothing reads (a held name is held);
 *   - the shadow reads the same, offers nothing, and journals one entry row and one exit row per name per day, with the
 *     overnight return between the 15:55 and the 09:40 prints;
 *   - every name is in every scan; a name with no bars is NEUTRAL with the reason said;
 *   - the scan worker runs it under TWO_SLEEVE_WORKER_SCAN=overnight over the sleeve's universe, as a shadow or armed.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOvernightScan } = require('../lib/two-sleeve/overnight-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

// 2026-09-22 is a Tuesday, 09-23 a Wednesday; EDT (ET = UTC-4)
const D1 = '2026-09-22', D2 = '2026-09-23';
const at = (day, hh, mm, ss = 0) => Date.parse(`${day}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const session = (day, closes) => closes.map((c, i) => ({ t: Date.parse(`${day}T13:30:00Z`) + i * 300000, h: c + 0.05, l: c - 0.05, c }));
const flat = (lvl) => Array.from({ length: 78 }, () => lvl);
const gapUp = (lvl) => Array.from({ length: 78 }, (_, i) => (i < 1 ? lvl * 1.005 : lvl * 1.004));   // the 09:30 bar closes +0.5%, the 09:35 bar +0.4%
function dailyBars(day, n, slope) {   // n session closes before `day`, ending at 100, with a slope per session
  const out = []; let t = Date.parse(`${day}T12:00:00Z`); let k = 0;
  while (out.length < n) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; k++; out.unshift({ timestamp: new Date(t).toISOString(), close: 100 - slope * k }); }
  return out;
}
function market() {
  const S5 = { AAA: [...session(D1, flat(100)), ...session(D2, gapUp(100))], BBB: [...session(D1, flat(50)), ...session(D2, gapUp(50))], CCC: [...session(D1, flat(20)), ...session(D2, gapUp(20))] };
  const S1 = { AAA: dailyBars(D1, 260, 0.05), BBB: dailyBars(D1, 260, -0.05), CCC: dailyBars(D1, 50, 0.05) };   // AAA rose into 100 (above its mean), BBB fell into 100 (below)
  const m = { now: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym, tf) => (tf === '1d' ? { bars: S1[sym] || [] } : { bars: (S5[sym] || []).filter((b) => b.t <= m.now).map(fmt) });
  return m;
}
const sig = (r, sym) => r.signals.find((x) => x.symbol === sym);

test('once the 15:50 bar is read: the name above its trend is a buy, the one below and the one without history are not', async () => {
  const m = market(); const s = createOvernightScan({ symbols: ['AAA', 'BBB', 'CCC'], getBars: m.getBars });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(r.overnight.window, 'entry');
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(sig(r, 'AAA').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'AAA').decision_context.overnight_above, true); assert.equal(sig(r, 'AAA').decision_context.overnight_bar, '15:55');
  assert.ok(Math.abs(sig(r, 'AAA').entry_price - 100) < 1e-9, 'priced from the 15:50 bar');
  assert.equal(sig(r, 'BBB').direction, 'NEUTRAL'); assert.equal(sig(r, 'BBB').decision_context.overnight_above, false);
  assert.equal(sig(r, 'CCC').direction, 'NEUTRAL'); assert.match(r.overnight.reads.find((x) => x.symbol === 'CCC').why, /trend: 50 sessions/);
  const g = r.overnight.reads.find((x) => x.symbol === 'AAA').gate; assert.equal(g.n, 200); assert.ok(g.prior > g.mean);
});

test('before the 15:50 bar is read the sell window still reads and nothing is bought; at 16:00 the window has closed', async () => {
  const m = market(); const s = createOvernightScan({ symbols: ['AAA'], getBars: m.getBars });
  m.now = at(D1, 15, 54); let r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'BEARISH', 'the sell window runs to the entry window'); assert.equal(r.overnight.window, 'sell');
  m.now = at(D1, 15, 55, 10); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'BEARISH', 'inside the 15:50 bar s settle the sell window still reads');
  m.now = at(D1, 15, 59, 30); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'BULLISH', 'the signal persists to the close');
  m.now = at(D1, 16, 0, 30); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL', 'the window is closed at 16:00'); assert.equal(r.overnight.window, null);
});

test('the next morning, from the first read after the 09:35 bar closes, every name is a sell, until the entry window', async () => {
  const m = market(); const s = createOvernightScan({ symbols: ['AAA', 'BBB'], getBars: m.getBars });
  m.now = at(D2, 9, 20); let r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL', 'pre-market: no completed bar, a held name is held'); assert.equal(r.overnight.window, null);
  assert.equal(r.overnight.reads.find((x) => x.symbol === 'AAA').why, 'no completed bar today');
  m.now = at(D2, 9, 40, 10); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL', 'the 09:35 bar is inside its settle');
  m.now = at(D2, 9, 40, 30); r = await s.scan(m.now);
  assert.equal(r.overnight.window, 'sell'); assert.equal(sig(r, 'AAA').direction, 'BEARISH'); assert.equal(sig(r, 'AAA').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'AAA').decision_context.overnight_bar, '09:40'); assert.ok(Math.abs(sig(r, 'AAA').price - 100.4) < 1e-6, 'priced from the 09:35 bar');
  assert.equal(sig(r, 'BBB').direction, 'BEARISH', 'a name the brain does not hold reads bearish too: it skips it as no long to exit');
  m.now = at(D2, 12, 0, 30); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'BEARISH', 'still a sell at noon');
  m.now = at(D2, 15, 55, 30); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'BULLISH', 'the entry window again');
});

test('the shadow offers nothing and journals the entry and the exit with the overnight return', async () => {
  const m = market(); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA', 'BBB'], getBars: m.getBars, shadow: true, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(sig(r, 'AAA').convergence.decision, 'SKIP'); assert.equal(r.overnight.shadow, true);
  assert.equal(r.overnight.window, 'entry', 'the shadow reads the window all the same');
  m.now = at(D1, 15, 57, 30); await s.scan(m.now);
  const en = rows.filter((x) => x.event === 'overnight_shadow'); assert.equal(en.length, 2, 'one entry row per name per day');
  const a = en.find((x) => x.symbol === 'AAA'); assert.equal(a.would, 'buy'); assert.equal(a.above, true); assert.equal(a.px, 100); assert.equal(a.bar, '15:55'); assert.equal(a.n, 200);
  assert.equal(en.find((x) => x.symbol === 'BBB').would, 'skip');
  m.now = at(D2, 9, 40, 30); r = await s.scan(m.now); assert.equal(sig(r, 'AAA').direction, 'NEUTRAL');
  m.now = at(D2, 9, 41, 30); await s.scan(m.now);
  const ex = rows.filter((x) => x.event === 'overnight_shadow_exit'); assert.equal(ex.length, 1, 'only the name the shadow would have bought');
  assert.equal(ex[0].symbol, 'AAA'); assert.equal(ex[0].bar, '09:40'); assert.ok(Math.abs(ex[0].px - 100.4) < 1e-6); assert.ok(Math.abs(ex[0].ret_pct - 0.4) < 1e-6, 'the 15:55 -> 09:40 return');
});

test('a name with no bars is neutral with the reason said', async () => {
  const m = market(); const s = createOvernightScan({ symbols: ['AAA', 'ZZZ'], getBars: m.getBars });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r, 'ZZZ').direction, 'NEUTRAL'); assert.equal(r.overnight.reads.find((x) => x.symbol === 'ZZZ').why, 'no bars');
  assert.equal(sig(r, 'AAA').direction, 'BULLISH');
});

test('the worker runs it under TWO_SLEEVE_WORKER_SCAN=overnight, as a shadow or armed', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = (...p) => path.resolve(__dirname, '..', 'lib', ...p).replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'overnight-scan.js'), `module.exports = require(${JSON.stringify(real('two-sleeve', 'overnight-scan.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), `module.exports = require(${JSON.stringify(real('file-queue.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async (s, tf) => ({ bars: tf === '1d' ? [] : [bar(Date.now() - 86400000, 100)] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'O', app, envFile: null, env: { TRADER_OVERNIGHT_SHADOW: '1' }, universe: ['SPY', 'QQQ', 'SMH'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'overnight' });
  const A = new ScanWorker({ id: 'P', app, envFile: null, env: {}, universe: ['SPY'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'overnight' });
  const bad = new ScanWorker({ id: 'X', app, envFile: null, env: {}, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'overnight' });
  try {
    assert.equal(W._childEnv().TWO_SLEEVE_WORKER_SCAN, 'overnight');
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['QQQ', 'SMH', 'SPY']);
    assert.ok(r.signals.every((x) => x.overnight === true && x.convergence.decision === 'SKIP'), 'no session today in the fake feed: nothing to do');
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'O');
    assert.ok(ready, 'the worker reported ready'); assert.equal(ready.scan, 'overnight'); assert.equal(ready.overnight, 'shadow'); assert.equal(ready.symbols, 'SPY,QQQ,SMH'); assert.equal(ready.trendN, 200);
    assert.equal(W.status().overnight, 'shadow');
    await A.scan();
    const readyA = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'P');
    assert.ok(readyA); assert.equal(readyA.overnight, 'armed');
    await assert.rejects(bad.scan(), /exited|failed|universe/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'X' && /universe/.test(String(x.error))));
  } finally { W.stop(); A.stop(); bad.stop(); }
});
