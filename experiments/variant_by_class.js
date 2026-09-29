'use strict';
/**
 * variant_by_class.js — where does a variant's gain or loss live? (2026-09-28)
 *
 * Splits the trade dumps of a control and of one or more variants by a class of the traded name
 * and prints, per class, the dollars each makes and the difference, in total and by window.
 * The dumps are the two-sleeve harness's REPLAY_DUMP files: <prefix>_<window>.<variant>.json.
 *
 * Usage: node experiments/variant_by_class.js <dumpDir> <spec> [<spec> ...]
 *   spec = prefix:control:variant[,variant...]:win,win,...
 *   e.g.   reval3:T_armed:T_floor15,T_floor075:q4,q1,aprjul,julsep,25q1,25q2,25q3,24q3,24q4
 * Every spec is pooled into one table (a control may be named differently per spec).
 */
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2];
const SPECS = process.argv.slice(3).filter((a) => !a.startsWith('--'));
if (!DIR || !SPECS.length) { console.error('usage: node variant_by_class.js <dumpDir> <prefix:control:variants:windows> ...'); process.exit(2); }

const LOW = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'GLD', 'TLT', 'XLE']);
const MID = new Set(['SMH', 'GDX', 'SLV', 'USO', 'XOP', 'XME']);
const CLASS = (s) => (LOW.has(s) ? 'LOW' : MID.has(s) ? 'MID' : 'HIGH');
const CLASSES = ['LOW', 'MID', 'HIGH'];
const usd = (x) => (x >= 0 ? '+' : '') + Math.round(x).toLocaleString('en-US');

const load = (prefix, win, variant) => { const f = path.join(DIR, `${prefix}_${win}.${variant}.json`); if (!fs.existsSync(f)) throw new Error('missing ' + f); return JSON.parse(fs.readFileSync(f, 'utf8')); };
const sum = (trades) => { const o = { n: 0, w: 0, pnl: 0, ret: 0 }; for (const t of trades) { o.n++; if (t.pnl > 0) o.w++; o.pnl += t.pnl; o.ret += t.ret; } return o; };

// label -> class -> { control: [...], variant: [...], byWin: Map(win -> {c, v}) }
const table = new Map();
for (const spec of SPECS) {
  const [prefix, control, variants, wins] = spec.split(':');
  for (const variant of variants.split(',')) {
    // the label is the variant name without its leading letter and underscore, so T_floor15 and O_floor15 pool
    const label = variant.replace(/^[A-Za-z]+_/, '');
    if (!table.has(label)) table.set(label, new Map(CLASSES.map((c) => [c, { c: [], v: [], byWin: new Map() }])));
    for (const win of wins.split(',')) {
      const C = load(prefix, win, control), V = load(prefix, win, variant);
      for (const cl of CLASSES) {
        const cell = table.get(label).get(cl);
        const c = C.filter((t) => CLASS(t.sym) === cl), v = V.filter((t) => CLASS(t.sym) === cl);
        cell.c.push(...c); cell.v.push(...v);
        cell.byWin.set(win, { c: sum(c).pnl, v: sum(v).pnl });
      }
    }
  }
}
const out = {};
for (const [label, classes] of table) {
  console.log(`\n### ${label} against the control, by volatility class of the name`);
  console.log('| class | control n | control WR | control $ | variant n | variant WR | variant $ | difference | windows better / worse (by more than $250) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  let tc = 0, tv = 0; out[label] = {};
  for (const cl of CLASSES) {
    const cell = classes.get(cl); const c = sum(cell.c), v = sum(cell.v);
    let better = 0, worse = 0; for (const x of cell.byWin.values()) { if (x.v - x.c > 250) better++; else if (x.v - x.c < -250) worse++; }
    tc += c.pnl; tv += v.pnl;
    out[label][cl] = { control: c, variant: v, diff: v.pnl - c.pnl, better, worse };
    console.log(`| ${cl} | ${c.n} | ${(100 * c.w / c.n).toFixed(0)}% | ${usd(c.pnl)} | ${v.n} | ${(100 * v.w / v.n).toFixed(0)}% | ${usd(v.pnl)} | ${usd(v.pnl - c.pnl)} | ${better} / ${worse} |`);
  }
  console.log(`| ALL | | | ${usd(tc)} | | | ${usd(tv)} | ${usd(tv - tc)} | |`);
  const wins = [...classes.get('LOW').byWin.keys()];
  console.log('\n| window | ' + CLASSES.map((c) => c + ' difference').join(' | ') + ' | book |'); console.log('|---|' + CLASSES.map(() => '---').join('|') + '|---|');
  for (const w of wins) { const d = CLASSES.map((cl) => { const x = classes.get(cl).byWin.get(w); return x.v - x.c; }); console.log(`| ${w} | ${d.map(usd).join(' | ')} | ${usd(d.reduce((a, b) => a + b, 0))} |`); }
}
if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify(out, null, 1));
