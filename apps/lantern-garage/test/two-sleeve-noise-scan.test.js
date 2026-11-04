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
 *   - the scan worker runs the leg when TWO_SLEEVE_WORKER_SCAN=noise and refuses to start without pairs;
 *   - THE CONTEXT GATE (2026-11-04, off by default): a break gamma and the sectors do not back offers no new entry, and every sell read stands.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { isTradingDay } = require('../lib/market-calendar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNoiseScan, sectorRead, contextVerdict, CONTEXT_SECTORS } = require('../lib/two-sleeve/noise-scan');
const { ScanWorker } = require('../lib/two-sleeve/runner-support');

const DAY = '2026-09-22';                                  // a Tuesday, EDT (ET = UTC-4)
const at = (hh, mm, ss = 0) => Date.parse(`${DAY}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const SIGMA = 0.003;
function priorDays() {
  const out = []; let t = Date.parse(`${DAY}T12:00:00Z`);
  while (out.length < 15) { t -= 86400000; const d = new Date(t); if (isTradingDay(d.toISOString().slice(0, 10))) out.unshift(d.toISOString().slice(0, 10)); }   // real sessions: no bars on Labor Day
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

// ---- THE CONTEXT GATE ---------------------------------------------------------------------------------------------------
const GAMMA = (tercile) => ({ gamma: { tercile, rank: 0.5, as_of: '2026-09-21' } });
const sectorBar = (day, withIt) => bars(day, Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : withIt ? 101 : 99)));
/** market() plus sector bars: the first `up` of the `n` sectors with bars rise after the first bar, the rest fall. `m.fetched` = the sector fetches. */
function gatedMarket(today, { up = 8, n = 8 } = {}) {
  const m = market(today);
  const base = m.getBars;
  const S = {};
  CONTEXT_SECTORS.slice(0, n).forEach((sym, i) => { S[sym] = sectorBar(DAY, i < up); });
  m.fetched = [];
  m.getBars = async (sym, tf) => {
    if (!CONTEXT_SECTORS.includes(sym)) return base(sym, tf);
    m.fetched.push(sym);
    return { bars: (S[sym] || []).filter((b) => b.t <= m.now).map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c })) };
  };
  return m;
}
const gated = (m, read, rows, extra = {}) => createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, contextGate: { dir: 'unused', read, log: (r) => rows.push(r), ...extra } });

test('the sectors: counted with the break since the first bar; a missing bar or a bad print is not counted; under 5 is no reading', () => {
  const at595 = (c0, c) => [{ min: 570, c: c0 }, { min: 595, c }];
  const up = {}; CONTEXT_SECTORS.forEach((x, i) => { up[x] = at595(100, i < 6 ? 101 : 99); });
  assert.deepEqual(sectorRead(up, 595, 'up'), { share: 0.75, n: 8, with: 6 });
  assert.deepEqual(sectorRead(up, 595, 'dn'), { share: 0.25, n: 8, with: 2 }, 'a falling break counts the sectors falling');
  const flat = {}; CONTEXT_SECTORS.forEach((x) => { flat[x] = at595(100, 100); });
  assert.deepEqual(sectorRead(flat, 595, 'up'), { share: 0, n: 8, with: 0 }, 'a flat sector moves with neither side');
  const holes = { ...up }; delete holes.XLE; holes.XLK = [{ min: 595, c: 101 }]; holes.KRE = [{ min: 570, c: 100 }];
  assert.deepEqual(sectorRead(holes, 595, 'up'), { share: 0.6, n: 5, with: 3 }, 'no first bar, no decision bar, no feed: not counted');
  const bad = { ...up }; bad.XLE = at595(100, 126); bad.XLK = at595(100, 74);
  assert.equal(sectorRead(bad, 595, 'up').n, 6, 'a move over 25 % is a bad print');
  const four = { XLE: at595(100, 101), XLK: at595(100, 101), KRE: at595(100, 101), XRT: at595(100, 101) };
  const none = sectorRead(four, 595, 'up');
  assert.equal(none.share, undefined); assert.match(none.why, /4 of 8 sectors have both bars/);
  assert.match(sectorRead(null, 595, 'up').why, /0 of 8/);
});

test('the score on every cell: closed only below zero, on both readings', () => {
  const sector = (w) => ({ share: w / 8, n: 8, with: w });
  const cells = [
    ['HIGH', 4, false, -2], ['HIGH', 5, false, -1], ['HIGH', 6, false, -1], ['HIGH', 7, true, 0], ['HIGH', 8, true, 0],
    ['MID', 4, false, -1], ['MID', 5, true, 0], ['MID', 6, true, 0], ['MID', 7, true, 1],
    ['LOW', 0, true, 0], ['LOW', 4, true, 0], ['LOW', 5, true, 1], ['LOW', 7, true, 2],
  ];
  for (const [g, w, open, score] of cells) {
    const v = contextVerdict({ tercile: g }, sector(w));
    assert.equal(v.open, open, `${g} ${w}`); assert.equal(v.score, score, `${g} ${w}`); assert.equal(v.why, `gamma ${g}, sectors ${w} of 8`);
  }
  const noGamma = contextVerdict({ why: 'the prior session is not in the CSV yet' }, sector(0));
  assert.equal(noGamma.open, true); assert.equal(noGamma.score, null); assert.match(noGamma.why, /no reading: the prior session is not in the CSV yet/);
  const noSector = contextVerdict({ tercile: 'HIGH' }, { why: '3 of 8 sectors have both bars' });
  assert.equal(noSector.open, true); assert.equal(noSector.score, null); assert.match(noSector.why, /no reading: 3 of 8 sectors/);
  const neither = contextVerdict(null, null);
  assert.equal(neither.open, true); assert.match(neither.why, /no gamma; no sectors/);
});

test('a refused break: the wrapper reads neutral so a held one is held, the other side still sells, one row for the bar', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 5 });
  const s = gated(m, () => GAMMA('HIGH'), rows);
  m.now = at(10, 0, 30); let r = await s.scan(m.now);
  assert.equal(r.noise.pairs[0].state, 'up'); assert.equal(r.noise.pairs[0].decision, true);
  assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL'); assert.equal(sig(r, 'UPRO').convergence.decision, 'SKIP');
  assert.deepEqual(sig(r, 'UPRO').decision_context.noise_context, { open: false, score: -1, why: 'gamma HIGH, sectors 5 of 8' });
  assert.equal(sig(r, 'SPXS').direction, 'BEARISH'); assert.equal(sig(r, 'SPXS').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'SPXS').decision_context.noise_context, undefined);
  assert.equal(r.noise.pairs[0].context.open, false); assert.deepEqual(r.noise.pairs[0].context.sector, { share: 0.625, n: 8, with: 5 });
  m.now = at(10, 1, 30); r = await s.scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL', 'the bar s one verdict');
  assert.equal(rows.length, 1, 'one row for the pair and bar');
  const row = rows[0];
  assert.equal(row.event, 'leg_context_gate'); assert.equal(row.day, DAY); assert.equal(row.bar, '10:00'); assert.equal(row.proxy, 'SPY'); assert.equal(row.side, 'up');
  assert.equal(row.open, false); assert.equal(row.score, -1); assert.equal(row.gamma.tercile, 'HIGH'); assert.equal(row.shadow, false);
});

test('an open verdict lets the entry through and journals it; a later bar gets its own verdict', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 7 });
  let gamma = 'HIGH';
  const s = gated(m, () => GAMMA(gamma), rows);
  m.now = at(10, 0, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.equal(sig(r, 'UPRO').convergence.decision, 'ENTER');
  assert.equal(sig(r, 'UPRO').decision_context.noise_context.score, 0);
  assert.equal(rows[0].open, true);
  gamma = 'LOW';
  m.now = at(10, 1, 30); r = await s.scan(m.now);
  assert.equal(r.noise.pairs[0].context.gamma.tercile, 'HIGH', 'the bar keeps its first verdict');
  m.now = at(10, 30, 30); r = await s.scan(m.now);
  assert.equal(r.noise.pairs[0].bar, '10:30'); assert.equal(r.noise.pairs[0].context.gamma.tercile, 'LOW');
  assert.equal(rows.length, 2); assert.deepEqual(rows.map((x) => x.bar), ['10:00', '10:30']);
});

test('a falling break reads the sectors falling: most sectors up refuses the inverse, most down lets it through', async () => {
  const rows = [];
  const m = gatedMarket(dropDay(), { up: 5 });    // 5 of 8 up = 3 of 8 with the fall
  m.now = at(10, 0, 30); let r = await gated(m, () => GAMMA('MID'), rows).scan(m.now);
  assert.equal(r.noise.pairs[0].state, 'dn');
  assert.equal(sig(r, 'SPXS').direction, 'NEUTRAL'); assert.equal(sig(r, 'UPRO').direction, 'BEARISH');
  assert.equal(rows[0].side, 'dn'); assert.equal(rows[0].why, 'gamma MID, sectors 3 of 8');
  const m2 = gatedMarket(dropDay(), { up: 1 });
  m2.now = at(10, 0, 30); r = await gated(m2, () => GAMMA('MID'), []).scan(m2.now);
  assert.equal(sig(r, 'SPXS').direction, 'BULLISH');
});

test('every sell read stands: back inside, nothing is read and both wrappers sell', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 0 });
  let reads = 0;
  const s = gated(m, () => { reads++; return GAMMA('HIGH'); }, rows);
  m.now = at(14, 5, 30); const r = await s.scan(m.now);
  assert.equal(r.noise.pairs[0].state, 'in');
  assert.equal(sig(r, 'UPRO').direction, 'BEARISH'); assert.equal(sig(r, 'SPXS').direction, 'BEARISH');
  assert.equal(reads, 0); assert.equal(m.fetched.length, 0); assert.equal(rows.length, 0); assert.equal(r.noise.pairs[0].context, undefined);
});

test('between decision bars nothing is read, and the gate never changes those signals', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 0 });
  let reads = 0;
  const s = gated(m, () => { reads++; return GAMMA('HIGH'); }, rows);
  m.now = at(10, 12); const r = await s.scan(m.now);
  assert.equal(r.noise.pairs[0].decision, false);
  assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL'); assert.equal(sig(r, 'SPXS').direction, 'BEARISH');
  assert.equal(reads, 0); assert.equal(m.fetched.length, 0); assert.equal(rows.length, 0);
});

test('the shadow reads the same and trades as without it', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 5 });
  m.now = at(10, 0, 30); const r = await gated(m, () => GAMMA('HIGH'), rows, { shadow: true }).scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.equal(sig(r, 'UPRO').convergence.decision, 'ENTER');
  assert.equal(r.noise.pairs[0].context.open, false, 'the same read');
  assert.equal(rows.length, 1); assert.equal(rows[0].open, false); assert.equal(rows[0].shadow, true);
});

test('no reading: the gate stays open, says why once, reads again, and closes when both readings arrive', async () => {
  const rows = [];
  const m = gatedMarket(rallyDay(), { up: 5 });
  let g = { gamma: { why: 'the prior session 2026-09-21 is not in the CSV yet' } };
  const s = gated(m, () => g, rows);
  m.now = at(10, 0, 30); let r = await s.scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH', 'with no data the leg trades as it would without the gate');
  assert.equal(r.noise.pairs[0].context.score, null);
  assert.equal(rows.length, 1); assert.equal(rows[0].score, null); assert.equal(rows[0].open, true); assert.match(rows[0].why, /not in the CSV yet/);
  m.now = at(10, 1, 0); r = await s.scan(m.now);
  assert.equal(rows.length, 1, 'said once for the bar');
  g = GAMMA('HIGH');
  m.now = at(10, 1, 30); r = await s.scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL', 'the reading arrived inside the window');
  assert.equal(rows.length, 2); assert.equal(rows[1].score, -1);
  // too few sectors
  const rows2 = [];
  const m2 = gatedMarket(rallyDay(), { up: 0, n: 4 });
  m2.now = at(10, 0, 30); r = await gated(m2, () => GAMMA('HIGH'), rows2).scan(m2.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.match(rows2[0].why, /4 of 8 sectors have both bars/);
  // the file read throws
  const rows3 = [];
  const m3 = gatedMarket(rallyDay(), { up: 0 });
  m3.now = at(10, 0, 30); r = await gated(m3, () => { throw new Error('boom'); }, rows3).scan(m3.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.match(rows3[0].why, /boom/);
  // a throwing journal is not a scan error
  const m4 = gatedMarket(rallyDay(), { up: 5 });
  m4.now = at(10, 0, 30); r = await createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m4.getBars, contextGate: { dir: 'x', read: () => GAMMA('HIGH'), log: () => { throw new Error('disk'); } } }).scan(m4.now);
  assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL');
});

test('a sector feed behind the proxy: no decision bar yet is no reading of that sector', async () => {
  const m = gatedMarket(rallyDay(), { up: 5 });
  const base = m.getBars;
  m.getBars = async (sym, tf) => { const b = await base(sym, tf); return CONTEXT_SECTORS.includes(sym) ? { bars: b.bars.filter((x) => Date.parse(x.timestamp) < at(9, 55)) } : b; };
  const rows = [];
  m.now = at(10, 0, 30); const r = await gated(m, () => GAMMA('HIGH'), rows).scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH', 'the sectors have no decision bar yet');
  assert.match(rows[0].why, /0 of 8 sectors have both bars/);
});

test('off by default: no sector is fetched, no file is read, no row, and the signals are the same', async () => {
  const m = gatedMarket(rallyDay(), { up: 0 });
  m.now = at(10, 0, 30);
  const r = await createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars }).scan(m.now);
  assert.equal(sig(r, 'UPRO').direction, 'BULLISH'); assert.equal(m.fetched.length, 0); assert.equal(r.noise.pairs[0].context, undefined);
  assert.equal(sig(r, 'UPRO').decision_context.noise_context, undefined);
  const noDir = await createNoiseScan({ pairs: 'SPY:UPRO:SPXS', getBars: m.getBars, contextGate: { log: () => { throw new Error('never'); } } }).scan(m.now);
  assert.equal(sig(noDir, 'UPRO').direction, 'BULLISH'); assert.equal(m.fetched.length, 0, 'a gate with no directory is no gate');
});

test('the worker: the knob reaches the scan through the real files, ready says so, a refused bar writes its row, no directory refuses to start', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-ctx-app-'));
  fs.mkdirSync(path.join(app, 'lib', 'two-sleeve'), { recursive: true });
  const reExport = (rel) => `module.exports = require(${JSON.stringify(path.resolve(__dirname, '..', rel).replace(/\\/g, '/'))});\n`;
  fs.writeFileSync(path.join(app, 'lib', 'two-sleeve', 'noise-scan.js'), reExport('lib/two-sleeve/noise-scan.js'));
  fs.writeFileSync(path.join(app, 'lib', 'file-queue.js'), reExport('lib/file-queue.js'));
  const fmt = (b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c });
  const feed = { SPY: [...PRIOR.flatMap((d, k) => bars(d, priorCloses(k))), ...bars(DAY, rallyDay())].map(fmt), UPRO: bars(DAY, wrapOf(rallyDay(), 50, 3)).map(fmt), SPXS: bars(DAY, wrapOf(rallyDay(), 20, -3)).map(fmt) };
  CONTEXT_SECTORS.forEach((sym, i) => { feed[sym] = sectorBar(DAY, i < 4).map(fmt); });
  fs.writeFileSync(path.join(app, 'feed.json'), JSON.stringify(feed));
  fs.writeFileSync(path.join(app, 'lib', 'market-data-yahoo.js'), [
    "'use strict';",
    "const S = require('../feed.json');",
    "module.exports = { getBars: async (s) => ({ bars: S[s] || [] }), getBarsWindow: async () => ({ bars: [] }) };",
  ].join('\n'));
  const tags = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-ctx-tags-'));
  const days = []; for (let d = new Date(`${DAY}T12:00:00Z`).getTime(); days.length < 300;) { d -= 86400000; const x = new Date(d).toISOString().slice(0, 10); if (isTradingDay(x)) days.unshift(x); }
  fs.writeFileSync(path.join(tags, 'gex.json'), JSON.stringify({ latest: days[days.length - 1], rows: days.map((d, i) => [d, i === days.length - 1 ? 1e9 : i]) }));   // the prior session ranks HIGH
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-ctx-dir-'));
  const log = [];
  const pairs = 'SPY:UPRO:SPXS';
  const worker = (id, env) => new ScanWorker({ id, app, envFile: null, env: { TRADER_NOISE_LEG_PAIRS: pairs, ...env }, universe: [], dir, timeoutMs: 8000, log: (r) => log.push(r), scan: 'noise', fakeNow: new Date(at(10, 0, 30)).toISOString() });
  const armed = worker('MA', { TRADER_NOISE_CONTEXT_GATE: '1', TRADER_ENTRY_TAGS_DIR: tags });
  const shadow = worker('MS', { TRADER_NOISE_CONTEXT_GATE: 'shadow', TRADER_ENTRY_TAGS_DIR: tags });
  const off = worker('MO', { TRADER_NOISE_CONTEXT_GATE: '', TRADER_ENTRY_TAGS_DIR: tags });
  const bad = worker('MX', { TRADER_NOISE_CONTEXT_GATE: '1', TRADER_ENTRY_TAGS_DIR: '' });
  try {
    const r = await armed.scan();
    assert.equal(r.noise.pairs[0].context.open, false); assert.equal(r.noise.pairs[0].context.why, 'gamma HIGH, sectors 4 of 8'); assert.equal(sig(r, 'UPRO').direction, 'NEUTRAL');
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'MA').contextGate, 'armed');
    const own = path.join(dir, 'MA.scan.jsonl');
    for (let i = 0; i < 40 && !fs.existsSync(own); i++) await new Promise((res) => setTimeout(res, 50));
    const rows = fs.readFileSync(own, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1); assert.equal(rows[0].event, 'leg_context_gate'); assert.equal(rows[0].open, false); assert.equal(rows[0].score, -2); assert.ok(rows[0].ts);
    const sh = await shadow.scan();
    assert.equal(sig(sh, 'UPRO').direction, 'BULLISH'); assert.equal(sh.noise.pairs[0].context.open, false);
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'MS').contextGate, 'shadow');
    const o = await off.scan();
    assert.equal(sig(o, 'UPRO').direction, 'BULLISH'); assert.equal(o.noise.pairs[0].context, undefined);
    assert.equal(log.find((x) => x.event === 'scan_worker_ready' && x.sleeve === 'MO').contextGate, null);
    await assert.rejects(bad.scan(), /exited|failed|TRADER_ENTRY_TAGS_DIR/);
    assert.ok(log.some((x) => x.event === 'scan_worker_failed' && x.sleeve === 'MX' && /TRADER_ENTRY_TAGS_DIR/.test(String(x.error))));
  } finally { armed.stop(); shadow.stop(); off.stop(); bad.stop(); }
});
