'use strict';
/**
 * two-sleeve-noise-scan.test.js — the noise-area leg as an engine sleeve's scan (2026-10-02).
 *
 * lib/two-sleeve/noise-scan.js says what the leg wants in the signal shape the brains trade; the brain does the rest
 * (stop, 15:50 de-carry, sizing, ownership). Pinned here, on the synthetic sessions of noise-shadow.test.js (15 prior
 * sessions with the proxy 0.3% from its open at every bar, so sigma = 0.3% after the first bar):
 *   - at a decision bar (the bar closing 10:00) the wrapper on the proxy's side of the band is BULLISH / ENTER and the
 *     other wrapper BEARISH / ENTER (sell it if held); the inverse on a falling day;
 *   - between decision bars, and later than 3 minutes after a decision bar's close, nothing is offered to buy;
 *   - back inside the band, both wrappers are BEARISH / ENTER;
 *   - every wrapper of every pair is in every scan (the feed guard never sees the leg as absent);
 *   - a feed holding only 13 prior sessions has no band (all NEUTRAL, the reason said), the settled history window
 *     restores it;
 *   - the scan worker runs the leg when TWO_SLEEVE_WORKER_SCAN=noise and refuses to start without pairs.
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
const SIGMA = 0.003;
function priorDays() {
  const out = []; let t = Date.parse(`${DAY}T12:00:00Z`);
  while (out.length < 15) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); }
  return out;
}
const PRIOR = priorDays();
function bars(day, closes) {
  const t0 = Date.parse(`${day}T13:30:00Z`);
  return closes.map((c, i) => ({ t: t0 + i * 300000, h: c * 1.0005, l: c * 0.9995, c }));
}
const priorCloses = (k) => Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : 100 * (1 + (k % 2 ? -SIGMA : SIGMA))));
// upper = 100.3 x 1.003 = 100.6009, lower = 100 x 0.997 = 99.7
function rallyDay() {
  return Array.from({ length: 78 }, (_, i) => {
    if (i === 0) return 100;
    if (i <= 5) return 100 * (1 + 0.002 * i);              // 101.0 at the bar closing 10:00
    if (i < 54) return 101.0;
    if (i < 59) return 100.5;                              // back inside from the bar closing 14:05
    return 101.2;
  });
}
const dropDay = () => Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : i <= 5 ? 100 * (1 - 0.002 * i) : 99.0));
const wrapOf = (closes, base, lev) => closes.map((c) => base * (1 + lev * (c / 100 - 1)));
function market(today, { onlyPriorFrom = 0 } = {}) {
  const prior = PRIOR.slice(onlyPriorFrom);
  const proxy = [...prior.flatMap((d, k) => bars(d, priorCloses(k + onlyPriorFrom))), ...bars(DAY, today)];
  const sessions = (base, lev) => [...prior.flatMap((d, k) => bars(d, wrapOf(priorCloses(k + onlyPriorFrom), base, lev))), ...bars(DAY, wrapOf(today, base, lev))];
  const fullProxy = [...PRIOR.flatMap((d, k) => bars(d, priorCloses(k))), ...bars(DAY, today)];
  const S = { SPY: proxy, UPRO: sessions(50, 3), SPXS: sessions(20, -3) };
  const m = { now: 0 };
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  m.getBars = async (sym) => ({ bars: (S[sym] || []).filter((b) => b.t <= m.now).map(fmt) });          // the in-progress bar included, as the live feed
  m.getHistory = async (sym, from, to) => ({ bars: (sym === 'SPY' ? fullProxy : []).filter((b) => b.t >= from && b.t <= to).map(fmt) });
  return m;
}
async function scanAt(m, ms, opts = {}) { m.now = ms; const s = createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, ...opts }); return s.scan(ms); }
const sig = (r, sym) => r.signals.find((x) => x.symbol === sym);

test('a rally: the long wrapper is offered at the 10:00 decision bar, the inverse is a sell; both always listed', async () => {
  const m = market(rallyDay());
  const r = await scanAt(m, at(10, 0, 30));
  assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['SPXS', 'UPRO']);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.equal(sig(r, 'UPRO').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'SPXS').direction, 'BEARISH'); assert.equal(sig(r, 'SPXS').convergence.decision, 'ENTER');
  assert.ok(sig(r, 'UPRO').entry_price > 50, 'priced from the wrapper s latest completed bar');
  assert.equal(r.noise.pairs[0].state, 'up'); assert.equal(r.noise.pairs[0].decision, true); assert.equal(r.noise.pairs[0].bar, '10:00');
  assert.ok(Math.abs(r.noise.pairs[0].upper - 100.6009) < 1e-3);
});

test('between decision bars and after the 3-minute window nothing is offered to buy; the sell stays', async () => {
  const m = market(rallyDay());
  const mid = await scanAt(m, at(10, 12));                 // the latest completed bar closed 10:10: not a decision bar
  assert.equal(sig(mid, 'UPRO').direction, 'NEUTRAL'); assert.equal(sig(mid, 'UPRO').convergence.decision, 'SKIP');
  assert.equal(sig(mid, 'SPXS').direction, 'BEARISH');
  const late = await scanAt(m, at(10, 4));                 // 4 minutes after the 10:00 close, the 10:05 bar not done yet
  assert.equal(late.noise.pairs[0].bar, '10:00'); assert.equal(late.noise.pairs[0].decision, false);
  assert.equal(sig(late, 'UPRO').direction, 'NEUTRAL');
  const early = await scanAt(m, at(10, 0, 10));            // inside the 20 s settle: the 10:00 bar is not read yet
  assert.equal(early.noise.pairs[0].bar, '09:55'); assert.equal(sig(early, 'UPRO').direction, 'NEUTRAL');
});

test('back inside the band: both wrappers are sells', async () => {
  const m = market(rallyDay());
  const r = await scanAt(m, at(14, 5, 30));                // the bar closing 14:05 is back inside
  assert.equal(r.noise.pairs[0].state, 'in');
  assert.equal(sig(r, 'UPRO').direction, 'BEARISH'); assert.equal(sig(r, 'UPRO').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'SPXS').direction, 'BEARISH');
});

test('a falling day: the inverse is offered, the long wrapper is a sell', async () => {
  const m = market(dropDay());
  const r = await scanAt(m, at(10, 0, 30));
  assert.equal(r.noise.pairs[0].state, 'dn');
  assert.equal(sig(r, 'SPXS').direction, 'BULLISH'); assert.equal(sig(r, 'SPXS').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'UPRO').direction, 'BEARISH');
});

test('no band on a short feed (13 prior sessions): nothing to do, the reason said; the history window restores the band', async () => {
  const m = market(rallyDay(), { onlyPriorFrom: 2 });      // the feed holds only the last 13 prior sessions
  const r = await scanAt(m, at(10, 0, 30));
  assert.equal(r.noise.pairs[0].state, null);
  assert.match(String(r.noise.pairs[0].why), /13 prior sessions/);
  for (const s of r.signals) { assert.equal(s.direction, 'NEUTRAL'); assert.equal(s.convergence.decision, 'SKIP'); }
  const r2 = await scanAt(m, at(10, 0, 30), { getHistory: m.getHistory });
  assert.equal(r2.noise.pairs[0].state, 'up');
  assert.equal(sig(r2, 'UPRO').direction, 'BULLISH');
});

test('the scan worker runs the leg under TWO_SLEEVE_WORKER_SCAN=noise and refuses to start without pairs', async () => {
  // a fake app tree: a market-data module serving synthetic bars, and the real noise scan re-exported
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-leg-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const real = path.resolve(__dirname, '..', 'lib', 'two-sleeve', 'noise-scan.js').replace(/\\/g, '/');
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'noise-scan.js'), `module.exports = require(${JSON.stringify(real)});\n`);
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const bar = (t, c) => ({ timestamp: new Date(t).toISOString(), open: c, high: c, low: c, close: c });",
    "module.exports = { getBars: async () => ({ bars: [bar(Date.now() - 86400000, 100)] }), getBarsWindow: async () => ({ bars: [] }) };",
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-leg-dir-'));
  const log = [];
  const W = new ScanWorker({ id: 'M', app, envFile: null, env: { TRADER_NOISE_LEG_PAIRS: 'SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ' }, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'noise' });
  const bad = new ScanWorker({ id: 'X', app, envFile: null, env: {}, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'noise' });
  try {
    assert.equal(W._childEnv().TWO_SLEEVE_WORKER_SCAN, 'noise');
    const r = await W.scan();
    assert.deepEqual(r.signals.map((x) => x.symbol).sort(), ['SPXS', 'SQQQ', 'TQQQ', 'UPRO']);
    assert.ok(r.signals.every((x) => x.noise_leg === true && x.convergence.decision === 'SKIP'), 'no session today in the fake feed: nothing to do');
    assert.equal(r.noise.pairs.length, 2);
    const ready = log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'M');
    assert.ok(ready, 'the worker reported ready'); assert.equal(ready.scan, 'noise'); assert.equal(ready.pairs, 'SPY:UPRO:SPXS,QQQ:TQQQ:SQQQ');
    assert.equal(W.status().scan, 'noise');
    await assert.rejects(bad.scan(), /exited|failed|TRADER_NOISE_LEG_PAIRS/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'X' && /TRADER_NOISE_LEG_PAIRS/.test(String(x.error))));
    // a sleeve without the scan mode keeps the tree's trader-agent scan (no TWO_SLEEVE_WORKER_SCAN in its child env)
    const plain = new ScanWorker({ id: 'S', app, envFile: null, env: {}, universe: [], dir });
    assert.equal(plain._childEnv().TWO_SLEEVE_WORKER_SCAN, undefined);
  } finally { W.stop(); bad.stop(); }
});
