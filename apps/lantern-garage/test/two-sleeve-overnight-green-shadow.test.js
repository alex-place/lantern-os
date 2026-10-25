'use strict';
/**
 * two-sleeve-overnight-green-shadow.test.js — the 09:35 green-exit shadow (2026-10-25,
 * ledger tier0-winrate-c-lock-and-o-open-exits / live-engine-o-green-exit-shadow-2026-10-26).
 *
 * The rule under test sells a held overnight name at the 09:35 print when it is above its entry (the prior session's
 * 15:55 print), else at the 09:40 print as the armed book does. The shadow journals it beside the armed book and
 * changes no signal. Pinned on synthetic sessions (as two-sleeve-overnight-scan.test.js):
 *   - a green open: one overnight_green_shadow row at the 09:35 read (would sell_0935), none again that day; the armed
 *     signals are unchanged (no sell before 09:40); at 09:40 one close row with the rule's return = the 09:35 return;
 *   - a red open: would hold_to_0940; the close row's rule return = the live 09:40 return;
 *   - off by default: no rows and identical signals; a scan object created on the morning (a runner restart) still finds
 *     the entry from the 5m bars;
 *   - the worker passes TRADER_OVERNIGHT_GREEN_SHADOW=1 through and journals in armed mode.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOvernightScan } = require('../lib/two-sleeve/overnight-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

const D1 = '2026-09-22', D2 = '2026-09-23';   // Tue, Wed; EDT (ET = UTC-4)
const at = (day, hh, mm, ss = 0) => Date.parse(`${day}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const session = (day, closes) => closes.map((c, i) => ({ t: Date.parse(`${day}T13:30:00Z`) + i * 300000, h: c + 0.05, l: c - 0.05, c }));
const flat = (lvl) => Array.from({ length: 78 }, () => lvl);
const morning = (lvl, f0930, f0935) => Array.from({ length: 78 }, (_, i) => (i < 1 ? lvl * f0930 : lvl * f0935));   // the 09:30 bar closes at f0930, the rest at f0935
function dailyBars(day, n, slope) {
  const out = []; let t = Date.parse(`${day}T12:00:00Z`); let k = 0;
  while (out.length < n) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; k++; out.unshift({ timestamp: new Date(t).toISOString(), close: 100 - slope * k }); }
  return out;
}
function market() {
  // GRN: green at 09:35 (+0.5 %), +0.4 % at 09:40.  RED: -0.3 % at 09:35, +0.2 % at 09:40.
  const S5 = { GRN: [...session(D1, flat(100)), ...session(D2, morning(100, 1.005, 1.004))], RED: [...session(D1, flat(50)), ...session(D2, morning(50, 0.997, 1.002))] };
  const S1 = { GRN: dailyBars(D1, 260, 0.05), RED: dailyBars(D1, 260, 0.05) };   // both above their 200-session mean
  const m = { now: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym, tf) => (tf === '1d' ? { bars: S1[sym] || [] } : { bars: (S5[sym] || []).filter((b) => b.t <= m.now).map(fmt) });
  return m;
}
const sig = (r, sym) => r.signals.find((x) => x.symbol === sym);
const close = (a, b) => Math.abs(a - b) < 1e-6;

test('a green open: one 09:35 row (would sell_0935), signals unchanged, and a close row with the 09:35 return', async () => {
  const m = market(); const rows = [];
  const s = createOvernightScan({ symbols: ['GRN', 'RED'], getBars: m.getBars, greenShadow: true, log: (r) => rows.push(r) });
  m.now = at(D1, 15, 55, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'GRN').direction, 'BULLISH', 'the armed book still buys at 15:55');
  assert.equal(rows.length, 0, 'nothing is journaled in the evening');
  m.now = at(D2, 9, 35, 30); r = await s.scan(m.now);
  assert.equal(sig(r, 'GRN').direction, 'NEUTRAL', 'no sell before the 09:40 read: the shadow changes no signal');
  m.now = at(D2, 9, 37, 30); await s.scan(m.now);
  const early = rows.filter((x) => x.event === 'overnight_green_shadow');
  assert.equal(early.length, 2, 'one 09:35 row per name per day');
  const g = early.find((x) => x.symbol === 'GRN');
  assert.equal(g.bar, '09:35'); assert.equal(g.entry_day, D1); assert.ok(close(g.entry_px, 100)); assert.ok(close(g.px, 100.5));
  assert.equal(g.green, true); assert.equal(g.would, 'sell_0935'); assert.ok(close(g.ret_pct, 0.5)); assert.equal(g.held_gate, true); assert.equal(g.shadow, true);
  m.now = at(D2, 9, 40, 30); r = await s.scan(m.now);
  assert.equal(sig(r, 'GRN').direction, 'BEARISH', 'the armed 09:40 sale'); assert.ok(close(sig(r, 'GRN').price, 100.4));
  m.now = at(D2, 12, 0, 30); await s.scan(m.now);
  const done = rows.filter((x) => x.event === 'overnight_green_shadow_close');
  assert.equal(done.length, 2, 'one close row per name per day');
  const c = done.find((x) => x.symbol === 'GRN');
  assert.equal(c.bar, '09:40'); assert.ok(close(c.px_0935, 100.5)); assert.ok(close(c.px_0940, 100.4)); assert.equal(c.green_0935, true);
  assert.ok(close(c.live_ret_pct, 0.4)); assert.ok(close(c.rule_ret_pct, 0.5), 'the rule sells at the 09:35 print');
});

test('a red open: would hold_to_0940 and the rule return equals the live 09:40 return', async () => {
  const m = market(); const rows = [];
  const s = createOvernightScan({ symbols: ['RED'], getBars: m.getBars, greenShadow: true, log: (r) => rows.push(r) });
  m.now = at(D2, 9, 35, 30); await s.scan(m.now);
  m.now = at(D2, 9, 40, 30); await s.scan(m.now);
  const e = rows.find((x) => x.event === 'overnight_green_shadow'); const c = rows.find((x) => x.event === 'overnight_green_shadow_close');
  assert.equal(e.green, false); assert.equal(e.would, 'hold_to_0940'); assert.ok(close(e.ret_pct, -0.3));
  assert.equal(c.green_0935, false); assert.ok(close(c.live_ret_pct, 0.2)); assert.ok(close(c.rule_ret_pct, 0.2));
  assert.ok(close(e.entry_px, 50), 'a scan created on the morning (a restart) still finds the entry from the 5m bars');
});

test('off by default: no rows and the same signals as with the shadow on', async () => {
  const m = market(); const rows = []; const rowsOn = [];
  const off = createOvernightScan({ symbols: ['GRN', 'RED'], getBars: m.getBars, log: (r) => rows.push(r) });
  const on = createOvernightScan({ symbols: ['GRN', 'RED'], getBars: m.getBars, greenShadow: true, log: (r) => rowsOn.push(r) });
  assert.equal(off.greenShadow, false); assert.equal(on.greenShadow, true);
  for (const [h, mm] of [[9, 35], [9, 40], [12, 0], [15, 55]]) {
    m.now = at(D2, h, mm, 30);
    const a = await off.scan(m.now), b = await on.scan(m.now);
    assert.deepEqual(a.signals, b.signals, `identical signals at ${h}:${mm}`);
  }
  assert.equal(rows.length, 0); assert.ok(rowsOn.length >= 2);
});

test('the worker passes TRADER_OVERNIGHT_GREEN_SHADOW=1 through and reports armed+green-shadow', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-green-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = (...p) => path.resolve(__dirname, '..', 'lib', ...p).replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'overnight-scan.js'), `module.exports = require(${JSON.stringify(real('two-sleeve', 'overnight-scan.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), `module.exports = require(${JSON.stringify(real('file-queue.js'))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async (s, tf) => ({ bars: tf === '1d' ? [] : [bar(Date.now() - 86400000, 100)] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-green-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'O', app, envFile: null, env: { TRADER_OVERNIGHT_GREEN_SHADOW: '1', TRADER_TRADES_LOG: path.join(dir, 'O.jsonl') }, universe: ['SPY', 'QQQ', 'SMH'], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'overnight' });
  try {
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['QQQ', 'SMH', 'SPY']);
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'O');
    assert.ok(ready); assert.equal(ready.overnight, 'armed+green-shadow');
  } finally { W.stop(); }
});
