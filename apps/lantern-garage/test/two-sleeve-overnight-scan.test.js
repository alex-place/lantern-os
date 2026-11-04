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
 *   - the scan worker runs it under TWO_SLEEVE_WORKER_SCAN=overnight over the sleeve's universe, as a shadow or armed;
 *   - THE BOND GATE (2026-11-04, off by default): no entry on a night after bonds fell, and the morning sale stands.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOvernightScan, bondVerdict, BOND_SYMBOL, BOND_CUT_PCT } = require('../lib/two-sleeve/overnight-scan');
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

test('the missed night: a late feed never opens the entry window, so one row after the close names the names; a normal night, a scan that never read the window and a weekend say nothing', async () => {
  // A late feed (10-30): on D1 the newest bar any read gets is the 15:45 bar (it ends 15:50), so the 15:50 bar never settles.
  const lateMarket = () => { const m = market(); const g = m.getBars; m.getBars = async (sym, tf) => { const r = await g(sym, tf); return tf === '1d' ? r : { bars: r.bars.filter((b) => Date.parse(b.timestamp) < at(D1, 15, 50)) }; }; return m; };
  const m = lateMarket(); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA', 'BBB'], getBars: m.getBars, log: (r) => rows.push(r) });
  for (const [hh, mm, ss] of [[15, 56, 0], [15, 59, 30], [16, 0, 30], [16, 5, 0]]) {
    m.now = at(D1, hh, mm, ss); const r = await s.scan(m.now);
    if (hh === 15) assert.equal(r.overnight.window, 'sell', 'the 15:45 bar is the newest: still the sell window, nothing is bought');
  }
  const miss = rows.filter((x) => x.event === 'overnight_entry_missed');
  assert.equal(miss.length, 1, 'one row, after the close, once');
  assert.equal(miss[0].day, D1); assert.deepEqual(miss[0].symbols, ['AAA', 'BBB']); assert.equal(miss[0].reads, 2);
  assert.deepEqual(miss[0].newest_bar_end, { AAA: '15:50', BBB: '15:50' }); assert.equal(miss[0].last_read, new Date(at(D1, 15, 59, 30)).toISOString());
  assert.match(miss[0].why, /15:50 bar never settled/);
  // control: the same night on the normal feed opens the window (for the name below its trend too): no row
  const n = market(); const nrows = [];
  const ns = createOvernightScan({ symbols: ['AAA', 'BBB'], getBars: n.getBars, log: (r) => nrows.push(r) });
  for (const [hh, mm, ss] of [[15, 56, 0], [16, 0, 30]]) { n.now = at(D1, hh, mm, ss); await ns.scan(n.now); }
  assert.equal(nrows.filter((x) => x.event === 'overnight_entry_missed').length, 0);
  // a scan that never read the window (a worker started after 16:00) cannot tell and says nothing
  const l = lateMarket(); const lrows = [];
  const ls = createOvernightScan({ symbols: ['AAA'], getBars: l.getBars, log: (r) => lrows.push(r) });
  l.now = at(D1, 16, 1); await ls.scan(l.now);
  assert.equal(lrows.length, 0);
  // a Saturday is not a session: no row
  const w = market(); const wrows = [];
  const ws = createOvernightScan({ symbols: ['AAA'], getBars: w.getBars, log: (r) => wrows.push(r) });
  for (const [hh, mm] of [[15, 56], [16, 1]]) { w.now = at('2026-09-26', hh, mm); await ws.scan(w.now); }
  assert.equal(wrows.length, 0);
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

// ---- THE BOND GATE --------------------------------------------------------------------------------------------------------
/** market() plus TLT: D1 closes `prior` on its last bar, D2 trades at `today` from the first bar. `m.tlt` counts the fetches. */
function bondMarket({ prior = 100, today = 99, tlt = true } = {}) {
  const m = market();
  const base = m.getBars;
  m.tlt = 0;
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  const S = tlt ? [...session('2026-09-21', flat(prior)), ...session(D1, flat(today))] : [];
  m.getBars = async (sym, tf) => {
    if (sym !== BOND_SYMBOL) return base(sym, tf);
    m.tlt++;
    return { bars: S.filter((b) => b.t <= m.now).map(fmt) };
  };
  return m;
}

test('the bond verdict: closed at or below the cut, open above it; a move it cannot trust is no reading', () => {
  assert.equal(BOND_SYMBOL, 'TLT'); assert.equal(BOND_CUT_PCT, -0.30);
  assert.equal(bondVerdict(100, 99.7).open, false, 'exactly at the cut');
  assert.equal(bondVerdict(100, 99.69).open, false);
  assert.equal(bondVerdict(100, 99.71).open, true);
  assert.equal(bondVerdict(100, 101).open, true);
  assert.equal(bondVerdict(100, 99.5).ret_pct, -0.5); assert.equal(bondVerdict(100, 99.5).why, 'TLT -0.5 % on the day');
  for (const [p, c, why] of [[null, 99, /no prior close/], [0, 99, /no prior close/], [100, null, /no entry bar/], [100, 0, /no entry bar/], [100, 84, /a move of -16/], [100, 116, /a move of 16/]]) {
    const v = bondVerdict(p, c);
    assert.equal(v.open, true, `${p} ${c}`); assert.equal(v.ret_pct, null); assert.match(v.why, why); assert.match(v.why, /^no reading/);
  }
});

test('bonds down: the name above its trend reads neutral with the reason said, one row a day, and the morning sale stands', async () => {
  const m = bondMarket({ prior: 100, today: 99 }); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA', 'BBB'], getBars: m.getBars, bondGate: {}, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); let r = await s.scan(m.now);
  assert.equal(r.overnight.window, 'entry');
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(sig(r, 'AAA').convergence.decision, 'SKIP');
  assert.match(r.overnight.reads.find((x) => x.symbol === 'AAA').why, /bond gate: TLT -1 % on the day/);
  assert.equal(r.overnight.bond.open, false); assert.equal(r.overnight.bond.ret_pct, -1);
  assert.equal(sig(r, 'BBB').direction, 'NEUTRAL'); assert.match(r.overnight.reads.find((x) => x.symbol === 'BBB').why, /below the trend/);
  const fetched = m.tlt;
  m.now = at(D1, 15, 57, 30); r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(m.tlt, fetched, 'the day has its reading: no second fetch');
  const bond = rows.filter((x) => x.event === 'overnight_bond_gate');
  assert.equal(bond.length, 1, 'one row a day');
  assert.equal(bond[0].day, D1); assert.equal(bond[0].open, false); assert.equal(bond[0].ret_pct, -1); assert.equal(bond[0].cut_pct, -0.3); assert.equal(bond[0].px, 99); assert.equal(bond[0].prior, 100);
  assert.deepEqual(bond[0].refused, ['AAA']); assert.deepEqual(bond[0].offered, []); assert.equal(bond[0].shadow, false);
  m.now = at(D2, 9, 40, 30); r = await s.scan(m.now);
  assert.equal(r.overnight.window, 'sell'); assert.equal(sig(r, 'AAA').direction, 'BEARISH', 'a name bought the night before is still sold');
  assert.equal(r.overnight.bond, undefined);
});

test('bonds up or little changed: the entry goes through and the row says who passed', async () => {
  const m = bondMarket({ prior: 100, today: 99.8 }); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA'], getBars: m.getBars, bondGate: {}, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(r.overnight.bond.open, true);
  assert.deepEqual(rows[0].offered, ['AAA']); assert.deepEqual(rows[0].refused, []);
});

test('the shadow reads the same and trades as without it', async () => {
  const m = bondMarket({ prior: 100, today: 99 }); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA'], getBars: m.getBars, bondGate: { shadow: true }, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(r.overnight.bond.open, false);
  const bond = rows.filter((x) => x.event === 'overnight_bond_gate');
  assert.equal(bond.length, 1); assert.equal(bond[0].open, false); assert.equal(bond[0].shadow, true); assert.deepEqual(bond[0].offered, ['AAA']);
});

test('no reading: open, said once, read again, and a later reading closes the night', async () => {
  const m = bondMarket({ tlt: false }); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA'], getBars: m.getBars, bondGate: {}, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH', 'with no data the sleeve trades as it would without the gate');
  assert.match(r.overnight.bond.why, /no reading/);
  m.now = at(D1, 15, 56, 30); await s.scan(m.now);
  let bond = rows.filter((x) => x.event === 'overnight_bond_gate');
  assert.equal(bond.length, 1, 'said once'); assert.equal(bond[0].ret_pct, null); assert.equal(bond[0].open, true);
  assert.ok(m.tlt >= 2, 'read again at the next scan');
  const rows2 = []; let feed = bondMarket({ tlt: false }); const live = { fn: feed.getBars };
  const s2 = createOvernightScan({ symbols: ['AAA'], getBars: (a, b) => live.fn(a, b), bondGate: {}, log: (x) => rows2.push(x) });
  feed.now = at(D1, 15, 55, 30); r = await s2.scan(feed.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH');
  feed = bondMarket({ prior: 100, today: 99 }); live.fn = feed.getBars; feed.now = at(D1, 15, 56, 30);
  r = await s2.scan(feed.now);
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL', 'the reading arrived inside the window');
  bond = rows2.filter((x) => x.event === 'overnight_bond_gate');
  assert.equal(bond.length, 2); assert.equal(bond[0].ret_pct, null); assert.equal(bond[1].ret_pct, -1);
});

test('a 13:00 close: the entry bar moves with the close, and the prior close is the last session bar', async () => {
  const day = '2026-12-24';   // Thursday, a 13:00 close; EST
  const est = (hh, mm, ss = 0) => Date.parse(`${day}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  const sess = (d, closes) => closes.map((c, i) => ({ t: Date.parse(`${d}T14:30:00Z`) + i * 300000, h: c + 0.05, l: c - 0.05, c }));
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  const feed = { AAA: [...sess('2026-12-23', Array(78).fill(100)), ...sess(day, Array(42).fill(100))], TLT: [...sess('2026-12-23', Array(78).fill(100)), ...sess(day, Array(42).fill(99))] };
  let now = 0;
  const daily = dailyBars(day, 260, 0.05);
  const rows = [];
  const s = createOvernightScan({ symbols: ['AAA'], getBars: async (sym, tf) => (tf === '1d' ? { bars: daily } : { bars: (feed[sym] || []).filter((b) => b.t <= now).map(fmt) }), bondGate: {}, log: (r) => rows.push(r) });
  now = est(12, 55, 30); const r = await s.scan(now);
  assert.equal(r.overnight.window, 'entry');
  assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(r.overnight.bond.ret_pct, -1);
  assert.equal(rows.filter((x) => x.event === 'overnight_bond_gate').length, 1);
});

test('off by default: TLT is never fetched, no row, no field', async () => {
  const m = bondMarket({ prior: 100, today: 90 }); const rows = [];
  const s = createOvernightScan({ symbols: ['AAA'], getBars: m.getBars, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r, 'AAA').direction, 'BULLISH'); assert.equal(m.tlt, 0); assert.equal(r.overnight.bond, undefined);
  assert.equal(rows.filter((x) => x.event === 'overnight_bond_gate').length, 0);
});

test('a name below its trend needs no bond read: no name to refuse, no fetch, no row', async () => {
  const m = bondMarket({ prior: 100, today: 99 }); const rows = [];
  const s = createOvernightScan({ symbols: ['BBB'], getBars: m.getBars, bondGate: {}, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); const r = await s.scan(m.now);
  assert.equal(sig(r, 'BBB').direction, 'NEUTRAL'); assert.equal(m.tlt, 0); assert.equal(rows.filter((x) => x.event === 'overnight_bond_gate').length, 0);
});

test('the worker: the knob reaches the scan, ready says so, the row lands in its own log', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-bond-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const reExport = (rel) => `module.exports = require(${JSON.stringify(path.resolve(__dirname, '..', rel).replace(/\\/g, '/'))});\n`;
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'overnight-scan.js'), reExport('lib/two-sleeve/overnight-scan.js'));
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), reExport('lib/file-queue.js'));
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  fs.writeFileSync(path.join(app, 'feed.json'), JSON.stringify({
    d: dailyBars(D1, 260, 0.05),
    AAA: session(D1, flat(100)).map(fmt),
    TLT: [...session('2026-09-21', flat(100)), ...session(D1, flat(99))].map(fmt),
  }));
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const S = require('../feed.json');",
    "module.exports = { getBars: async (s, tf) => ({ bars: tf === '1d' ? S.d : (S[s] || []) }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-bond-dir-'));
  const log = [];
  const worker = (id, env) => new ScanWorker({ id, app, envFile: null, env, universe: ['AAA'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'overnight', fakeNow: new Date(at(D1, 15, 55, 30)).toISOString() });
  const armed = worker('OA', { TRADER_OVERNIGHT_BOND_GATE: '1' });
  const shadow = worker('OS', { TRADER_OVERNIGHT_BOND_GATE: 'shadow' });
  const off = worker('OO', { TRADER_OVERNIGHT_BOND_GATE: '' });
  try {
    const r = await armed.scan();
    assert.equal(sig(r, 'AAA').direction, 'NEUTRAL'); assert.equal(r.overnight.bond.open, false);
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'OA').bondGate, 'armed');
    const own = path.join(dir, 'OA.scan.jsonl');
    for (let i = 0; i < 40 && !fs.existsSync(own); i++) await new Promise((res) => setTimeout(res, 50));
    const rows = fs.readFileSync(own, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((x) => x.event === 'overnight_bond_gate');
    assert.equal(rows.length, 1); assert.equal(rows[0].open, false); assert.ok(rows[0].ts);
    const sh = await shadow.scan();
    assert.equal(sig(sh, 'AAA').direction, 'BULLISH'); assert.equal(sh.overnight.bond.open, false);
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'OS').bondGate, 'shadow');
    const o2 = await off.scan();
    assert.equal(sig(o2, 'AAA').direction, 'BULLISH'); assert.equal(o2.overnight.bond, undefined);
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'OO').bondGate, null);
  } finally { armed.stop(); shadow.stop(); off.stop(); }
});
