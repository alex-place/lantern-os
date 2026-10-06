'use strict';
/**
 * two-sleeve-noise-late-gate.test.js — the leg's late-reversal gate, journal-only (2026-10-05).
 *
 * lib/two-sleeve/noise-scan.js keeps one observation per session per proxy (sign(15:30 price / previous close - 1) x
 * (15:55 price / 15:30 price - 1)) and says, once a day after the 15:30 bar, whether the 40- and 60-session means are
 * negative (the regime in which selling the leg at 15:30 paid on both replay surfaces). It trades nothing. Pinned here on
 * synthetic sessions (65 prior sessions, each up 0.3% from a 100 close and then giving 0.1% back in its last half hour):
 *   - at the first read after the 15:30 bar: one late_gate_shadow row per proxy with n = 64 (the first session of a
 *     history has no previous close), both means negative, both
 *     gates on, the band state and both wrappers' prices; a later read the same day adds no second row;
 *   - after the 15:55 bar: one late_drift_shadow row with the day's own observation;
 *   - the observations survive in the state file: a fresh scan on a short feed still reads 65 sessions;
 *   - a continuation regime (the last half hour extends the day) reads the gate off;
 *   - the signals are identical with the shadow on and off, and off means no state file and no `late` read;
 *   - the worker builds the shadow from TRADER_NOISE_LATE_GATE_SHADOW=1 and reports it ready; the runner hands it a
 *     state-file path.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNoiseScan } = require('../lib/two-sleeve/noise-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

const DAY = '2026-09-22';                                  // a Tuesday, EDT (ET = UTC-4)
const at = (hh, mm, ss = 0) => Date.parse(`${DAY}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
function priorDays(n) {
  const out = []; let t = Date.parse(`${DAY}T12:00:00Z`);
  while (out.length < n) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); }
  return out;
}
function bars(day, closes) {
  const t0 = Date.parse(`${day}T13:30:00Z`);
  return closes.map((c, i) => ({ t: t0 + i * 300000, h: c * 1.0005, l: c * 0.9995, c }));
}
// A prior session: 100 at the open, 100.3 all day (the band's sigma = 0.3%), the 15:50 bar closes 100.3 x (1 + late),
// the 15:55 bar back at 100 (so every session starts from a previous close of 100 and is an UP day at 15:30).
const priorCloses = (late) => Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : i === 76 ? 100.3 * (1 + late) : i === 77 ? 100 : 100.3));
function rallyDay() {
  return Array.from({ length: 78 }, (_, i) => {
    if (i === 0) return 100;
    if (i <= 5) return 100 * (1 + 0.002 * i);              // 101.0 at the bar closing 10:00
    if (i < 54) return 101.0;
    if (i < 59) return 100.5;
    return 101.2;                                          // 101.2 from 14:25 on, through the 15:30 and 15:55 bars
  });
}
const wrapOf = (closes, base, lev) => closes.map((c) => base * (1 + lev * (c / 100 - 1)));
function market({ late = -0.001, priorN = 65, feedPrior = null } = {}) {
  const prior = priorDays(priorN); const fed = feedPrior == null ? prior : prior.slice(-feedPrior);
  const proxy = (days) => [...days.flatMap((d) => bars(d, priorCloses(late))), ...bars(DAY, rallyDay())];
  const wrap = (days, base, lev) => [...days.flatMap((d) => bars(d, wrapOf(priorCloses(late), base, lev))), ...bars(DAY, wrapOf(rallyDay(), base, lev))];
  const S = { SPY: proxy(fed), UPRO: wrap(fed, 50, 3), SPXS: wrap(fed, 20, -3) };
  const full = proxy(prior);
  const m = { now: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym) => ({ bars: (S[sym] || []).filter((b) => b.t <= m.now).map(fmt) });
  m.getHistory = async (sym, from, to) => ({ bars: (sym === 'SPY' ? full : []).filter((b) => b.t >= from && b.t <= to).map(fmt) });
  return m;
}
function shadow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-gate-'));
  const rows = [];
  return { dir, rows, stateFile: path.join(dir, 'M.scan-state.json'), log: (r) => rows.push(r) };
}
async function scanAt(m, s, ms, opts = {}) { m.now = ms; return s.scan(ms); }

test('after the 15:30 bar: one gate row per proxy, from the sessions before today, with both wrappers prices', async () => {
  const m = market(); const sh = shadow();
  const s = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, getHistory: m.getHistory, lateGate: { stateFile: sh.stateFile, log: sh.log } });
  const early = await scanAt(m, s, at(15, 25, 30));         // the latest completed bar closed 15:25: not yet
  assert.equal(sh.rows.length, 0); assert.equal(early.noise.pairs[0].late, undefined);
  const r = await scanAt(m, s, at(15, 30, 25));             // the 15:25 bar (closing 15:30) has settled
  const gate = sh.rows.filter((x) => x.event === 'late_gate_shadow');
  assert.equal(gate.length, 1);
  const g = gate[0];
  assert.equal(g.proxy, 'SPY'); assert.equal(g.day, DAY); assert.equal(g.bar, '15:30'); assert.equal(g.state, 'up'); assert.equal(g.shadow, true);
  assert.equal(g.n, 64, 'every prior session with a previous close counted (the first has none), none of today');
  assert.ok(g.m60 < 0 && g.m40 < 0, 'the last half hour has been giving the day back');
  assert.ok(Math.abs(g.m60 - -0.0997) < 0.002, `mean of sign x return in percent: ${g.m60}`);
  assert.equal(g.gate60, true); assert.equal(g.gate40, true);
  assert.equal(g.up.symbol, 'UPRO'); assert.ok(Math.abs(g.up.px - 51.8) < 1e-6, 'the long wrapper at the 15:30 bar');
  assert.equal(g.dn.symbol, 'SPXS'); assert.ok(Math.abs(g.dn.px - 19.28) < 1e-6, 'the inverse wrapper at the 15:30 bar');
  assert.deepEqual(r.noise.pairs[0].late, { n: 64, m40: g.m40, gate40: true, m60: g.m60, gate60: true });
  await scanAt(m, s, at(15, 40, 25));
  assert.equal(sh.rows.filter((x) => x.event === 'late_gate_shadow').length, 1, 'one gate row a day');
  assert.equal(sh.rows.filter((x) => x.event === 'late_drift_shadow').length, 0, 'the day is not over');
  // the signals are the leg's own: 15:30 is a decision bar and the proxy is above the band, so the long wrapper is still
  // offered (BULLISH / ENTER) and a held one is held; nothing is sold by the shadow
  const up = r.signals.find((x) => x.symbol === 'UPRO');
  assert.equal(up.direction, 'BULLISH'); assert.equal(up.convergence.decision, 'ENTER');
});

test('after the 15:55 bar: the day s own observation is journaled once and kept in the state file', async () => {
  const m = market(); const sh = shadow();
  const s = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, getHistory: m.getHistory, lateGate: { stateFile: sh.stateFile, log: sh.log } });
  await scanAt(m, s, at(15, 55, 10));                       // inside the settle: the 15:50 bar is not read yet
  assert.equal(sh.rows.filter((x) => x.event === 'late_drift_shadow').length, 0);
  await scanAt(m, s, at(15, 55, 25));
  await scanAt(m, s, at(15, 58, 0));
  const drift = sh.rows.filter((x) => x.event === 'late_drift_shadow');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].proxy, 'SPY'); assert.equal(drift[0].day, DAY);
  assert.equal(drift[0].p1530, 101.2); assert.equal(drift[0].p1555, 101.2); assert.equal(drift[0].prev_close, 100);
  assert.equal(drift[0].sr_pct, 0, 'an up day that neither gave back nor extended in its last half hour');
  assert.equal(drift[0].n, 65);
  const state = JSON.parse(fs.readFileSync(sh.stateFile, 'utf8'));
  assert.equal(state.obs.SPY.length, 65); assert.equal(state.obs.SPY[64].d, DAY);
  assert.equal(state.logged.SPY.gate, DAY); assert.equal(state.logged.SPY.drift, DAY);
  // a fresh scan on a feed holding only the last 13 sessions still reads the whole history from the state file
  const m2 = market({ feedPrior: 13 }); m2.getHistory = async () => ({ bars: [] });
  const s2 = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m2.getBars, getHistory: m2.getHistory, lateGate: { stateFile: sh.stateFile, log: () => {} } });
  await scanAt(m2, s2, at(9, 35, 25));
  const read = s2.lateGate.read('SPY', '2026-09-23');
  assert.equal(read.n, 65); assert.equal(read.gate60, true);
});

test('a continuation regime reads the gate off; too little history reads it null', async () => {
  const m = market({ late: +0.001 }); const sh = shadow();
  const s = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, getHistory: m.getHistory, lateGate: { stateFile: sh.stateFile, log: sh.log } });
  await scanAt(m, s, at(15, 30, 25));
  const g = sh.rows.find((x) => x.event === 'late_gate_shadow');
  assert.ok(g.m60 > 0); assert.equal(g.gate60, false); assert.equal(g.gate40, false);
  const m3 = market({ priorN: 20 }); const sh3 = shadow();
  const s3 = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m3.getBars, getHistory: m3.getHistory, lateGate: { stateFile: sh3.stateFile, log: sh3.log } });
  await scanAt(m3, s3, at(15, 30, 25));
  const g3 = sh3.rows.find((x) => x.event === 'late_gate_shadow');
  assert.equal(g3.n, 19); assert.equal(g3.gate60, null); assert.equal(g3.m60, null, '19 of the 48 needed'); assert.equal(g3.gate40, null);
});

test('the shadow changes no signal; off, it leaves no state file and no late read', async () => {
  const m = market(); const sh = shadow();
  const on = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, getHistory: m.getHistory, lateGate: { stateFile: sh.stateFile, log: sh.log } });
  const off = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, getHistory: m.getHistory });
  for (const ms of [at(10, 0, 30), at(14, 5, 30), at(15, 30, 25), at(15, 55, 25)]) {
    const a = await scanAt(m, on, ms), b = await scanAt(m, off, ms);
    assert.deepEqual(a.signals, b.signals, `the same signals at ${new Date(ms).toISOString()}`);
    assert.equal(b.noise.pairs[0].late, undefined);
  }
  assert.ok(sh.rows.length >= 2, 'the shadow wrote its rows');
  assert.equal(off.lateGate, null);
});

test('the worker builds the shadow from TRADER_NOISE_LATE_GATE_SHADOW=1 and the runner hands it a state-file path', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'late-gate-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = (p) => path.resolve(__dirname, '..', 'lib', ...p).replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'noise-scan.js'), `module.exports = require(${JSON.stringify(real(['two-sleeve', 'noise-scan.js']))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), `module.exports = require(${JSON.stringify(real(['file-queue.js']))});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async () => ({ bars: [bar(Date.now() - 86400000, 100)] }), getBarsWindow: async () => ({ bars: [] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-gate-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'M', app, envFile: null, env: { TRADER_NOISE_LEG_PAIRS: 'SPY:UPRO:SPXS', TRADER_NOISE_LATE_GATE_SHADOW: '1' }, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'noise' });
  const plain = new ScanWorker({ id: 'N', app, envFile: null, env: { TRADER_NOISE_LEG_PAIRS: 'SPY:UPRO:SPXS' }, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'noise' });
  try {
    assert.equal(W._childEnv().TWO_SLEEVE_WORKER_STATE_FILE, path.join(dir, 'M.scan-state.json'));
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['SPXS', 'UPRO']);
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'M');
    assert.ok(ready); assert.equal(ready.lateGate, 'shadow');
    await plain.scan();
    const readyPlain = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'N');
    assert.ok(readyPlain); assert.equal(readyPlain.lateGate, null);
  } finally { W.stop(); plain.stop(); }
});
