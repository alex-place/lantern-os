'use strict';
/**
 * noise-shadow.test.js — the noise-area shadow journals, and only journals (2026-10-01).
 *
 * The rule (Zarattini, Aziz and Barbon 2024, as the replay measured it): sigma(m) = the mean over the
 * 14 prior sessions of |close(m) / open - 1|; upper = max(open, prevClose) x (1 + sigma), lower =
 * min(open, prevClose) x (1 - sigma); at the bars closing 10:00 ... 15:30 a flat pair "buys" its long
 * wrapper above the band, its inverse below; a held wrapper is "sold" at the first completed bar back
 * inside on its side (no entry on that bar), at the 8% stop, or at 15:50 by the clock.
 *
 * Sessions are synthetic: 15 prior sessions in which the proxy sits 0.3% from its open at every bar
 * (so sigma = 0.3% everywhere after the first bar), then a test day. These pin: the band and the
 * volatility reading; one check row per decision bar and one position per pair however often the pass
 * runs; the band exit and the re-entry at a later decision; the inverse on a falling day; the 15:50
 * sale at the live quote; the stop; a restart repeats nothing; a late process reads the missed bars and
 * says so; the gate and breadth labels; no row is ever a trade; the brain's kick is off without
 * TRADER_NOISE_SHADOW and tags every row with the user 'noise-shadow' when on.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('../lib/trend-shadow');

const DAY = '2026-09-22';                                  // a Tuesday, EDT (ET = UTC-4)
const at = (hh, mm, ss = 0) => Date.parse(`${DAY}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
const SIGMA = 0.003;

/** The 15 weekdays before DAY, oldest first. */
function priorDays() {
  const out = []; let t = Date.parse(`${DAY}T12:00:00Z`);
  while (out.length < 15) { t -= 86400000; const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); }
  return out;
}
const PRIOR = priorDays();
/** 78 5m bars of a session from closes[i] (bar starting 09:30 + 5i); the 09:30 bar's midpoint is the open. */
function bars(day, closes, { lows = {} } = {}) {
  const t0 = Date.parse(`${day}T13:30:00Z`);
  return closes.map((c, i) => ({ t: t0 + i * 300000, h: c * 1.0005, l: lows[i] != null ? lows[i] : c * 0.9995, c }));
}
/** A prior session: open 100, every later bar 0.3% above (k even) or below (k odd) it. */
const priorCloses = (k) => Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : 100 * (1 + (k % 2 ? -SIGMA : SIGMA))));
// The previous session (k = 14, even) closes at 100.3: hiRef = 100.3, loRef = 100 (today's open)
const UPPER = 100.3 * (1 + SIGMA), LOWER = 100 * (1 - SIGMA);

/** Proxy path for a rally: +0.2% a bar to 101.0 by the bar closing 10:00, back inside at the bar closing 14:05, out again by 14:30. */
function rallyDay() {
  return Array.from({ length: 78 }, (_, i) => {
    if (i === 0) return 100;
    if (i <= 5) return 100 * (1 + 0.002 * i);
    if (i < 54) return 101.0;
    if (i < 59) return 100.5;                             // 100.5 < UPPER 100.6009: back inside
    return 101.2;
  });
}
const dropDay = () => Array.from({ length: 78 }, (_, i) => (i === 0 ? 100 : i <= 5 ? 100 * (1 - 0.002 * i) : 99.0));
const wrapOf = (closes, base, lev) => closes.map((c) => base * (1 + lev * (c / 100 - 1)));

/** A market: the proxy's sessions plus each wrapper derived from the proxy (3x / -3x); SPY daily closes for the gate. */
function market(today, { dailyMove = 0.01, wrapLows = {} } = {}) {
  const proxy = [...PRIOR.flatMap((d, k) => bars(d, priorCloses(k))), ...bars(DAY, today)];
  const sessions = (base, lev, lows) => [...PRIOR.flatMap((d, k) => bars(d, wrapOf(priorCloses(k), base, lev))), ...bars(DAY, wrapOf(today, base, lev), { lows })];
  const S = { SPY: proxy, UPRO: sessions(50, 3, wrapLows.UPRO), SPXS: sessions(20, -3, wrapLows.SPXS) };
  const daily = []; let c = 400;
  for (let k = 40; k >= 1; k--) { c = c * Math.exp(k % 2 ? dailyMove : -dailyMove); daily.push({ timestamp: new Date(Date.parse(`${DAY}T20:00:00Z`) - k * 86400000).toISOString(), close: c }); }
  daily.push({ timestamp: new Date(at(9, 30)).toISOString(), close: 1 });   // today's partial bar: excluded
  const m = { now: 0 };
  m.getBars = async (sym, tf) => {
    if (tf === '1d') return { bars: daily };
    return { bars: (S[sym] || []).filter((b) => b.t <= m.now).map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c })) };
  };
  m.getQuote = async (sym) => { const live = (S[sym] || []).filter((b) => b.t <= m.now); return live.length ? live[live.length - 1].c : null; };
  m.S = S;
  return m;
}
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noise-shadow-')), 'state.json');
function shadow(m, stateFile = tmpState()) {
  const rows = [];
  const s = ts.createNoiseShadow({ pairs: 'SPY:UPRO:SPXS', log: (r) => rows.push(r), stateFile, getBars: m.getBars, getQuote: m.getQuote });
  return { s, rows, stateFile };
}
async function run(s, m, from, to, stepMs = 60000) { for (let t = from; t <= to; t += stepMs) { m.now = t; await s.tick(t); } }

test('the pairs: proxy:long:inverse, malformed entries and repeated proxies dropped', () => {
  assert.deepStrictEqual(ts.parseNoisePairs(' spy:upro:spxs, QQQ:TQQQ ,SPY:SPXL:SPXU,smh:soxl:soxs'),
    [{ proxy: 'SPY', up: 'UPRO', dn: 'SPXS' }, { proxy: 'SMH', up: 'SOXL', dn: 'SOXS' }]);
});

test('the band: 14 prior sessions, the open the 09:30 midpoint, max/min of open and the previous close', () => {
  const raw = market(rallyDay()).S.SPY.map((b) => ({ timestamp: new Date(b.t).toISOString(), high: b.h, low: b.l, close: b.c }));
  const band = ts.noiseBand(raw, DAY);
  assert.ok(Math.abs(band.open - 100) < 1e-9 && Math.abs(band.prevClose - 100.3) < 1e-9);
  const lim = band.at(595);
  assert.ok(Math.abs(lim.sigma - SIGMA) < 1e-12, `sigma ${lim.sigma}`);
  assert.ok(Math.abs(lim.upper - UPPER) < 1e-9 && Math.abs(lim.lower - LOWER) < 1e-9);
  // no band without the history: fewer than 14 prior sessions (here also when sessions are missing: with 15
  // synthetic sessions the count check is the one that refuses), or no 09:30 bar today
  const t13 = raw.filter((b) => b.timestamp >= `${PRIOR[2]}`);
  assert.match(String(ts.noiseBand(t13, DAY).why), /prior sessions/);
  const hole = raw.filter((b) => !b.timestamp.startsWith(PRIOR[12]) && !b.timestamp.startsWith(PRIOR[13]));
  assert.match(String(ts.noiseBand(hole, PRIOR[14]).why), /prior sessions|gap/);
  const noToday = raw.filter((b) => !b.timestamp.startsWith(DAY));
  assert.match(String(ts.noiseBand(noToday, DAY).why), /09:30/);
});

test('the gate reading: 20-session annualized volatility of log returns, today excluded', () => {
  const m = market(rallyDay(), { dailyMove: 0.01 });
  return m.getBars('SPY', '1d').then(({ bars: d }) => {
    const v = ts.realizedVol(d, DAY);
    assert.ok(Math.abs(v - 0.01 * Math.sqrt(20 / 19 * 252)) < 1e-9, `vol ${v}`);
    assert.strictEqual(ts.realizedVol(d.slice(0, 10), DAY), null, 'short history: no reading');
  });
});

test('a rally: the long wrapper at 10:00, the band exit at 14:05, a re-entry at 14:30, the 15:50 sale — once, however often the pass runs', async () => {
  const m = market(rallyDay());
  const { s, rows } = shadow(m);
  await run(s, m, at(9, 30), at(16, 4), 20000);
  const checks = rows.filter((r) => r.event === 'noise_shadow_check');
  assert.deepStrictEqual(checks.map((r) => r.check), ['10:00', '14:30'], 'a row for each decision bar it was flat for, and only those');
  const entries = rows.filter((r) => r.event === 'noise_shadow_entry'), exits = rows.filter((r) => r.event === 'noise_shadow_exit');
  assert.deepStrictEqual(entries.map((r) => [r.symbol, r.check]), [['UPRO', '10:00'], ['UPRO', '14:30']]);
  assert.deepStrictEqual(exits.map((r) => [r.why, r.exit_check]), [['band', '14:05'], ['close', '15:50']]);
  assert.ok(Math.abs(entries[0].entry_px - 50 * (1 + 3 * 0.01)) < 1e-6, 'the live quote at 10:00:20');
  assert.ok(Math.abs(exits[0].ret_pct - 100 * ((50 * (1 + 3 * 0.005)) / (50 * 1.03) - 1)) < 1e-3, 'sold at the 14:05 quote');
  assert.ok(!checks.some((r) => r.check === '14:00' || r.check === '14:05'), 'no decision while held');
  assert.ok(rows.every((r) => r.shadow === true && !['entry', 'exit'].includes(r.event)), 'never a trade row');
});

test('a falling day buys the inverse', async () => {
  const m = market(dropDay());
  const { s, rows } = shadow(m);
  await run(s, m, at(9, 30), at(10, 30));
  const e = rows.find((r) => r.event === 'noise_shadow_entry');
  assert.strictEqual(e.symbol, 'SPXS'); assert.strictEqual(e.side, 'dn'); assert.strictEqual(e.check, '10:00');
  const c = rows.find((r) => r.event === 'noise_shadow_check');
  assert.ok(c.close < c.lower && c.state === 'dn');
});

test('the stop: 8% under the entry on a completed wrapper bar; the pair stays flat until the next decision', async () => {
  const lowBar = (11 * 60 + 0 - 570) / 5;                  // the UPRO bar starting 11:00
  const m = market(rallyDay(), { wrapLows: { UPRO: { [lowBar]: 40 } } });
  const { s, rows } = shadow(m);
  await run(s, m, at(9, 30), at(11, 10));
  const x = rows.find((r) => r.event === 'noise_shadow_exit');
  assert.strictEqual(x.why, 'stop'); assert.strictEqual(x.exit_check, '11:05');
  assert.ok(Math.abs(x.ret_pct + 8) < 1e-6, `at the stop: ${x.ret_pct}`);
  await run(s, m, at(11, 11), at(11, 31));
  assert.deepStrictEqual(rows.filter((r) => r.event === 'noise_shadow_entry').map((r) => r.check), ['10:00', '11:30'], 're-entered at the next decision, still above the band');
});

test('a restart mid-session repeats nothing and still sells at 15:50', async () => {
  const m = market(rallyDay());
  const stateFile = tmpState();
  const a = shadow(m, stateFile);
  await run(a.s, m, at(9, 30), at(12, 0));
  const b = shadow(m, stateFile);                          // a new process, same state file
  await run(b.s, m, at(12, 0), at(15, 55));
  const rows = [...a.rows, ...b.rows];
  assert.strictEqual(rows.filter((r) => r.event === 'noise_shadow_entry').length, 2);
  assert.strictEqual(new Set(rows.filter((r) => r.event === 'noise_shadow_check').map((r) => r.check)).size, rows.filter((r) => r.event === 'noise_shadow_check').length, 'no check row twice');
  assert.deepStrictEqual(b.rows.filter((r) => r.event === 'noise_shadow_exit').map((r) => r.why), ['band', 'close']);
});

test('a process that starts late reads the missed bars from the history and says so', async () => {
  const m = market(rallyDay());
  const { s, rows } = shadow(m);
  await run(s, m, at(11, 0), at(11, 0));
  const e = rows.find((r) => r.event === 'noise_shadow_entry');
  assert.strictEqual(e.check, '10:00'); assert.strictEqual(e.late, true);
  assert.ok(Math.abs(e.entry_px - 50 * 1.03) < 1e-6, 'the 10:00 bar close, not the 11:00 quote');
  assert.ok(rows.filter((r) => r.event === 'noise_shadow_check').every((r) => r.late === true));
});

test('every row carries the gate and breadth labels', async () => {
  const m = market(rallyDay(), { dailyMove: 0.009 });     // 14.7% annualized: under the 16% gate
  const { s, rows } = shadow(m);
  await run(s, m, at(9, 30), at(10, 1));
  const e = rows.find((r) => r.event === 'noise_shadow_entry');
  assert.ok(Math.abs(e.vol20 - 0.009 * Math.sqrt(20 / 19 * 252)) < 1e-4); assert.strictEqual(e.gate, false);
  assert.strictEqual(e.agree, 1, 'one proxy configured: it agrees with itself');
});

test('the brain: off without TRADER_NOISE_SHADOW; on, every row carries the user noise-shadow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-shadow-brain-'));
  const log = path.join(dir, 'trades.jsonl');
  process.env.TRADER_TRADES_LOG = log;
  process.env.TRADER_STATE_FILE = path.join(dir, 'state.json');
  const m = market(rallyDay());
  const mdPath = require.resolve('../lib/market-data-yahoo');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getBars: m.getBars, getQuotes: async (syms) => [{ symbol: syms[0], price: await m.getQuote(syms[0]) }],
    getBarsMulti: async () => ({ bars: {} }), getSessionBars15m: async () => [] } };
  const brain = require('../lib/auto-trader');
  delete process.env.TRADER_NOISE_SHADOW; delete process.env.TRADER_TREND_SHADOW;
  m.now = at(10, 1);
  await brain.runAutoTrade({ signals: [] }, { now: at(10, 1) });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('noise_shadow'), 'off by default');
  process.env.TRADER_NOISE_SHADOW = 'SPY:UPRO:SPXS';
  const res = await brain.runAutoTrade({ signals: [] }, { now: at(10, 1) });
  assert.deepStrictEqual(res.executed, [], 'the pass itself is untouched: it returns as it always did');
  for (let i = 0; i < 40 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('noise_shadow_entry')); i++) await new Promise((r) => setTimeout(r, 25));
  const rows = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.event).startsWith('noise_shadow'));
  assert.ok(rows.length >= 2, `rows: ${rows.map((r) => r.event).join(',')}`);
  assert.ok(rows.every((r) => r.user === 'noise-shadow'), 'kept out of every account view');
  assert.ok(fs.existsSync(path.join(dir, 'noise-shadow-state.json')), 'state beside the journal');
  delete process.env.TRADER_NOISE_SHADOW;
});

// ── the feed's depth (2026-10-01) ────────────────────────────────────────────
// The live 5m feed keeps 2,600 bars including the extended sessions: about 14 sessions, one short of the band's 15.
// On 2026-10-01 QQQ and SMH had no band all day and SPY lost its band from 12:30 ("13 prior sessions (< 14)").
// The older history comes from a settled window (getHistory) and is merged under the recent feed.
test('a feed holding only 13 prior sessions makes no band; the older window restores it', async () => {
  const m = market(rallyDay());
  const short = (sym) => m.S[sym].filter((b) => b.t >= Date.parse(`${PRIOR[2]}T13:30:00Z`));   // the last 13 prior sessions + today
  const feed = async (sym, tf) => (tf === '1d' ? m.getBars(sym, tf) : { bars: short(sym).filter((b) => b.t <= m.now).map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c })) });
  // without the history: the check rows say why, and nothing is bought
  const a = { rows: [] };
  a.s = ts.createNoiseShadow({ pairs: 'SPY:UPRO:SPXS', log: (r) => a.rows.push(r), stateFile: tmpState(), getBars: feed, getQuote: m.getQuote });
  await run(a.s, m, at(9, 30), at(10, 1));
  const c = a.rows.find((r) => r.event === 'noise_shadow_check');
  assert.strictEqual(c.state, 'no band');
  assert.match(String(c.why), /13 prior sessions/);
  assert.ok(!a.rows.some((r) => r.event === 'noise_shadow_entry'));
  // with the history window: the band is back and the 10:00 breakout is bought as before
  const asked = [];
  const getHistory = async (sym, from, to) => { asked.push([sym, from, to]); return { bars: m.S[sym].filter((b) => b.t >= from && b.t <= to).map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c })) }; };
  const b = { rows: [] };
  b.s = ts.createNoiseShadow({ pairs: 'SPY:UPRO:SPXS', log: (r) => b.rows.push(r), stateFile: tmpState(), getBars: feed, getQuote: m.getQuote, getHistory });
  await run(b.s, m, at(9, 30), at(10, 1));
  const e = b.rows.find((r) => r.event === 'noise_shadow_entry');
  assert.ok(e && e.symbol === 'UPRO' && e.check === '10:00', `rows: ${b.rows.map((r) => r.event + ':' + (r.state || r.symbol)).join(',')}`);
  assert.ok(asked.length >= 1 && asked.length <= 2, 'the window is fetched once a day (twice at most: one per pass that needed it before it answered)');
  const [, from, to] = asked[0];
  assert.ok(to < at(9, 30) && from < to, 'a settled window entirely before today');
});
