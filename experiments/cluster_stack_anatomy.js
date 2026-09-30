'use strict';
/**
 * cluster_stack_anatomy.js — DOES THE BOOK LOSE WHEN IT STACKS ONE FAMILY?
 * (ledger row metals-stack-anatomy-13-windows, 2026-09-30).
 *
 * The rules judge each name alone: 6 slots, 18% a position, a 130% gross cap and nothing about
 * correlation. On 2026-09-30 stable bought NUGT, GDX and GLD inside 90 seconds and SLV an hour later,
 * and carried 63% of its equity in precious metals overnight. This measures, on the harness dumps,
 * whether a family entry taken while the family is already stacked does worse than the rest.
 *
 *   STACK   the number of family positions open at a trade's entry instant, counting the trade
 *           itself and every family entry of the same instant (a trio bought in one scan is 3, 3, 3)
 *   STACKED stack >= 3        SPARSE  stack <= 2
 *
 * Nothing is replayed. The dumps carry { sym, ret, pnl, entry_ms, exit_ms, why, owner }.
 * Usage: node experiments/cluster_stack_anatomy.js <dumpDir> <prefix> <variant> [--wins a,b,...] [--family A,B,C] [--k 3] [--json out.json]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [DIR, PREFIX, VAR] = positional;
if (!DIR || !PREFIX || !VAR) { console.error('usage: node cluster_stack_anatomy.js <dumpDir> <prefix> <variant> [--wins a,b] [--family A,B] [--k 3] [--json out.json]'); process.exit(2); }
const FAMILY = new Set(String(flag('--family') || 'GLD,GDX,SLV,NUGT,JNUG').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const K = Number(flag('--k') || 3);
const MIN_N = 5, BAND = 50;
const WINS = flag('--wins')
  ? flag('--wins').split(',').map((s) => s.trim()).filter(Boolean)
  : fs.readdirSync(DIR).map((f) => f.match(new RegExp(`^${PREFIX}_([^.]+)\\.${VAR}\\.json$`))).filter(Boolean).map((m) => m[1]).sort();
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');
const pct = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : (100 * x).toFixed(d) + '%');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const fam = [], rest = [];
for (const w of WINS) {
  const f = path.join(DIR, `${PREFIX}_${w}.${VAR}.json`);
  if (!fs.existsSync(f)) { console.error('missing dump', f); process.exit(1); }
  const trades = JSON.parse(fs.readFileSync(f, 'utf8')).filter((t) => t.owner === 'S' && Number.isFinite(Number(t.entry_ms)) && Number.isFinite(Number(t.exit_ms)));
  const famTrades = trades.filter((t) => FAMILY.has(t.sym));
  for (const t of trades) {
    const row = { win: w, sym: t.sym, ret: Number(t.ret), pnl: Number(t.pnl), day: etDay(t.entry_ms), exitDay: etDay(t.exit_ms), entry_ms: t.entry_ms, exit_ms: t.exit_ms, why: t.why };
    if (!FAMILY.has(t.sym)) { rest.push(row); continue; }
    // open at the entry instant: entered at or before it and not yet out
    row.stack = famTrades.filter((u) => u.entry_ms <= t.entry_ms && u.exit_ms > t.entry_ms).length;
    fam.push(row);
  }
}
const stat = (a) => ({ n: a.length, pnl: a.reduce((q, r) => q + r.pnl, 0), mean: mean(a.map((r) => r.ret)), wr: a.length ? a.filter((r) => r.pnl > 0).length / a.length : null });
const S = fam.filter((r) => r.stack >= K), P = fam.filter((r) => r.stack < K);
let lower = 0, decided = 0, sNeg = 0, sWin = 0;
const byWin = [];
for (const w of WINS) {
  const a = stat(S.filter((r) => r.win === w)), b = stat(P.filter((r) => r.win === w));
  const dec = a.n >= MIN_N && b.n >= MIN_N;
  if (dec) { decided++; if (a.mean < b.mean) lower++; }
  if (a.n) { sWin++; if (a.pnl < -BAND) sNeg++; }
  byWin.push({ w, a, b, dec });
}
const all = stat([...fam, ...rest]);
console.log(`${WINS.length} windows | family ${[...FAMILY].join(' ')} | ${fam.length} family trades, ${rest.length} others | the whole book ${usd(all.pnl)}`);
const line = (name, s) => console.log(`${name.padEnd(34)} ${String(s.n).padStart(5)} trades | WR ${pct(s.wr, 0).padStart(4)} | mean ${pct(s.mean).padStart(8)} per trade | ${usd(s.pnl)}`);
line(`STACKED (stack >= ${K})`, stat(S));
line(`SPARSE (stack <= ${K - 1})`, stat(P));
line('every other name', stat(rest));
const dist = {}; for (const r of fam) dist[r.stack] = (dist[r.stack] || 0) + 1;
console.log('family trades by stack at entry: ' + Object.entries(dist).map(([k, n]) => `${k}: ${n}`).join(' | '));
console.log(`STACKED lower than SPARSE in ${lower} of ${decided} decided windows | STACKED net negative in ${sNeg} of ${sWin} windows where it traded`);
console.log('| window | stacked n | mean | $ | sparse n | mean | $ | stacked lower |');
console.log('|---|---|---|---|---|---|---|---|');
for (const x of byWin) console.log(`| ${x.w} | ${x.a.n} | ${pct(x.a.mean)} | ${usd(x.a.pnl)} | ${x.b.n} | ${pct(x.b.mean)} | ${usd(x.b.pnl)} | ${x.dec ? (x.a.mean < x.b.mean ? 'yes' : 'no') : 'n/a'} |`);

// the tail: family P&L per exit session, sessions where a stack of K or more was open against the rest
const sess = new Map();
for (const r of fam) { const k = r.win + ':' + r.exitDay; const e = sess.get(k) || { pnl: 0, stacked: false, n: 0 }; e.pnl += r.pnl; e.n++; if (r.stack >= K) e.stacked = true; sess.set(k, e); }
const sa = [...sess.entries()].filter(([, e]) => e.stacked).map(([k, e]) => ({ k, ...e })).sort((a, b) => a.pnl - b.pnl);
const sb = [...sess.entries()].filter(([, e]) => !e.stacked).map(([k, e]) => ({ k, ...e })).sort((a, b) => a.pnl - b.pnl);
console.log(`\nfamily P&L by exit session: ${sa.length} sessions with a stack >= ${K}, worst ${sa.slice(0, 3).map((e) => e.k + ' ' + usd(e.pnl)).join(', ')} | mean ${usd(mean(sa.map((e) => e.pnl)) || 0)}`);
console.log(`                            ${sb.length} sessions without,          worst ${sb.slice(0, 3).map((e) => e.k + ' ' + usd(e.pnl)).join(', ')} | mean ${usd(mean(sb.map((e) => e.pnl)) || 0)}`);
const out = flag('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ windows: WINS, family: [...FAMILY], k: K, stacked: stat(S), sparse: stat(P), rest: stat(rest), lower, decided, sNeg, sWin, byWin, worstStacked: sa.slice(0, 5), worstSparse: sb.slice(0, 5) }, null, 1));
