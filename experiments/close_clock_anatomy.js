'use strict';
/**
 * close_clock_anatomy.js — THE CLOCK OF THE FORCED CLOSE (ledger row forced-close-clock-13-windows, 2026-09-29).
 *
 * The armed stack sells its 3x equity names at 15:50 ET every day (decarry) and everything at 15:50
 * on Fridays (weekend flat). This asks what the SAME positions would have fetched at another clock.
 * Nothing is replayed: the trades come from the harness dumps, the prices from the same 5m bars.
 *
 * A position counts when the 15:50 rule applies to it (a decarry name on any day, any name on a
 * Friday), it was open at the alternative clock T, and it was closed that same day at or after T by
 * ANY exit. A position that bounced out between T and 15:50 is therefore charged to the alternative:
 * selling at T gives that bounce up. Fill convention = the harness's own: an exit at tick T fills at
 * the close of the 5m bar that starts at T.
 *
 * Usage: node experiments/close_clock_anatomy.js <dumpDir> [prefix=floor] [variant=F_armed] [--wins a,b,c|map]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DIR = process.argv[2];
const PREFIX = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'floor';
const VAR = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 'F_armed';
if (!DIR) { console.error('usage: node close_clock_anatomy.js <dumpDir> [prefix] [variant] [--wins ...]'); process.exit(2); }
const CACHE_ROOT = process.env.CACHE_ROOT || os.tmpdir();
const SCORED13 = ['22q2', '22q3', '23q1', '23q3', '24q3', '24q4', '25q1', '25q2', '25q3', 'q4', 'q1', 'aprjul', 'julsep'];
const WINS_ARG = process.argv.includes('--wins') ? process.argv[process.argv.indexOf('--wins') + 1] : '';
const WINS = !WINS_ARG ? SCORED13
  : WINS_ARG === 'map' ? fs.readdirSync(CACHE_ROOT).filter((d) => /^oos_\d\dq\d$/.test(d)).map((d) => d.slice(4)).filter((w) => !SCORED13.includes(w)).sort()
    : WINS_ARG.split(',');
const DECARRY = new Set(String(process.env.CLOSE_DECARRY || 'TQQQ,SQQQ,SOXL,SOXS,SPXL,SPXS,TNA,TZA,UPRO').split(','));
const CLOCKS = [900, 915, 930, 940, 955];          // 15:00 15:15 15:30 15:40 and the last bar of the session
const ARMED = 950;
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const memo = new Map();
const et = (ms) => { let e = memo.get(ms); if (e) return e; const p = FMT.formatToParts(new Date(ms)); const g = (t) => p.find((x) => x.type === t).value; e = { day: `${g('year')}-${g('month')}-${g('day')}`, wd: g('weekday'), min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) }; memo.set(ms, e); return e; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');

const bars = new Map();   // `${win}:${sym}` -> { byT: Map(t -> close), byDayMin: Map(`${day}:${min}` -> close) }
function load(win, sym) {
  const k = `${win}:${sym}`; if (bars.has(k)) return bars.get(k);
  const f = path.join(CACHE_ROOT, 'oos_' + win, sym + '.json');
  const o = { byT: new Map(), byDayMin: new Map() };
  if (fs.existsSync(f)) for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) { const e = et(b.t); o.byT.set(b.t, Number(b.c)); o.byDayMin.set(`${e.day}:${e.min}`, Number(b.c)); }
  bars.set(k, o); return o;
}

const rows = [];   // one row per position the rule applies to
let skipped = { noEntryBar: 0, flat: 0, noClockBar: 0 };
for (const win of WINS) {
  const f = path.join(DIR, `${PREFIX}_${win}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const x = et(t.exit_ms), e = et(t.entry_ms);
    const ruled = DECARRY.has(t.sym) || x.wd === 'Fri';
    if (!ruled) continue;
    const b = load(win, t.sym);
    const entry = b.byT.get(t.entry_ms);
    if (!(entry > 0)) { skipped.noEntryBar++; continue; }
    if (!(Math.abs(t.ret) > 1e-9)) { skipped.flat++; continue; }
    const notional = t.pnl / t.ret;
    const alt = {};
    for (const T of CLOCKS) {
      // open at T: entered before T on the exit day, or on an earlier day; closed at or after T the same day
      const openAtT = (e.day < x.day) || (e.day === x.day && e.min < T);
      if (!openAtT || x.min < T) { alt[T] = null; continue; }
      const px = b.byDayMin.get(`${x.day}:${T}`);
      if (!(px > 0)) { alt[T] = null; skipped.noClockBar++; continue; }
      alt[T] = notional * (px / entry - 1) - t.pnl;      // dollars the alternative clock would have added
    }
    rows.push({ win, sym: t.sym, day: x.day, fri: x.wd === 'Fri', dec: DECARRY.has(t.sym), exitMin: x.min, why: t.why, pnl: t.pnl, notional, alt });
  }
}
const forced = rows.filter((r) => r.exitMin === ARMED && r.why !== 'stop');
console.log(`${rows.length} positions under the 15:50 rule across ${WINS.length} windows (${forced.length} of them sold by the rule at 15:50, ${usd(forced.reduce((a, r) => a + r.pnl, 0))}); skipped: ${JSON.stringify(skipped)}`);

function table(title, pick) {
  const R = rows.filter(pick);
  console.log(`\n### ${title} (${R.length} positions, actual ${usd(R.reduce((a, r) => a + r.pnl, 0))})`);
  console.log('| clock | positions open at it | dollars against 15:50 | per position | bp of the position | windows better | windows worse |');
  console.log('|---|---|---|---|---|---|---|');
  const out = {};
  for (const T of CLOCKS) {
    const A = R.filter((r) => r.alt[T] != null);
    const sum = A.reduce((a, r) => a + r.alt[T], 0), not = A.reduce((a, r) => a + Math.abs(r.notional), 0);
    let better = 0, worse = 0; const per = [];
    for (const w of WINS) { const s = A.filter((r) => r.win === w).reduce((a, r) => a + r.alt[T], 0); per.push(s); if (s > 50) better++; else if (s < -50) worse++; }
    out[T] = { n: A.length, sum, better, worse, per };
    console.log(`| ${hhmm(T)}${T === 955 ? ' (last print)' : ''} | ${A.length} | ${usd(sum)} | ${A.length ? usd(sum / A.length) : '-'} | ${not ? (10000 * sum / not).toFixed(1) : '-'} | ${better} | ${worse} |`);
  }
  return out;
}
const all = table('every position under the rule', () => true);
table('3x equity names, Monday to Thursday (the daily decarry)', (r) => r.dec && !r.fri);
table('3x equity names, Fridays', (r) => r.dec && r.fri);
table('every other name, Fridays (the weekend flat)', (r) => !r.dec && r.fri);

console.log('\n### by window, every position under the rule: dollars against 15:50');
console.log('| window | ' + CLOCKS.map((T) => hhmm(T)).join(' | ') + ' |'); console.log('|---|' + CLOCKS.map(() => '---').join('|') + '|');
WINS.forEach((w, i) => console.log(`| ${w} | ${CLOCKS.map((T) => usd(all[T].per[i])).join(' | ')} |`));

// the day's direction: is the drift into the close the direction of the day's move?
const dn = rows.filter((r) => r.alt[930] != null && r.pnl < 0), up = rows.filter((r) => r.alt[930] != null && r.pnl >= 0);
const s = (a, T) => a.reduce((q, r) => q + r.alt[T], 0);
console.log(`\npositions under water at their actual exit: ${dn.length}, 15:30 against the actual ${usd(s(dn, 930))}; positions in profit: ${up.length}, 15:30 against the actual ${usd(s(up, 930))}`);
if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify({ made: new Date().toISOString(), wins: WINS, rows: rows.length, forced: forced.length, all }, null, 1));
