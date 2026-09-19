'use strict';
// experiments/exthours_study.js — pre/after-market study. Data: a 5m cache WITH pre/post bars — build one from the box's
// lib/bar-archive (data/lantern-garage/trading/bars/<SYM>-5m.jsonl, ISO t) or the collector; rev60cache is regular-hours only.
// usage: node exthours_study.js <cache dir> <dump prefix for the oos_* trade dumps>
const fs = require('fs'), path = require('path');
const [CACHE, DUMP] = process.argv.slice(2);
const SY = ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'TLT', 'SMH', 'XLK', 'SOXL', 'TNA', 'SQQQ', 'SOXS', 'SPXS', 'TZA', 'SPXL', 'TQQQ', 'UPRO'];
const LEV = new Set(['SOXL', 'TNA', 'SQQQ', 'SOXS', 'SPXS', 'TZA', 'SPXL', 'TQQQ', 'UPRO']);
const INV = new Set(['SQQQ', 'SOXS', 'SPXS', 'TZA']);
const ET = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const dayKey = (ms) => { const d = ET(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const minOf = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const pos = (v) => (v.length ? Math.round(100 * v.filter((x) => x > 0).length / v.length) : NaN);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
const f = (x, w = 7, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-').padStart(w);

// ---- load: per symbol, per day, bars keyed by minute ---------------------------------------
const D = {};
for (const s of SY) {
  const a = JSON.parse(fs.readFileSync(path.join(CACHE, s + '.json'), 'utf8'));
  const by = {};
  for (const b of a) { const k = dayKey(b.t); (by[k] = by[k] || []).push({ ...b, m: minOf(b.t) }); }
  for (const k of Object.keys(by)) by[k].sort((x, y) => x.m - y.m);
  D[s] = by;
}
const DAYS = Object.keys(D.SPY).sort();
const at = (s, day, m, dir = 'le') => { const bars = D[s][day] || []; if (dir === 'le') { const r = bars.filter((b) => b.m <= m); return r.length ? r[r.length - 1] : null; } const r = bars.filter((b) => b.m >= m); return r.length ? r[0] : null; };
const first = (s, day, lo, hi) => { const r = (D[s][day] || []).filter((b) => b.m >= lo && b.m <= hi); return r.length ? r[0] : null; };
const last = (s, day, lo, hi) => { const r = (D[s][day] || []).filter((b) => b.m >= lo && b.m <= hi); return r.length ? r[r.length - 1] : null; };

// ---- coverage ------------------------------------------------------------------------------
console.log('COVERAGE (median bars per session): pre 04:00-09:25 has 66 slots, post 16:00-19:55 has 48');
const med = (v) => { const x = v.slice().sort((a, b) => a - b); return x.length ? x[Math.floor(x.length / 2)] : 0; };
console.log('  ' + SY.map((s) => { const pre = med(DAYS.map((d) => (D[s][d] || []).filter((b) => b.m < 570).length)); const post = med(DAYS.map((d) => (D[s][d] || []).filter((b) => b.m >= 960).length)); return s + ':' + pre + '/' + post; }).join('  '));

// ---- A. where the overnight move happens ---------------------------------------------------
console.log('\nA. WHERE THE OVERNIGHT MOVE HAPPENS (close -> next open), mean |move| % and share of variance per segment');
console.log('  post = 16:00 close -> 19:55 | dark = 19:55 -> 04:00 | pre = 04:00 -> 09:25 | open = 09:25 -> 09:30 open print');
console.log('  sym      |post|  |dark|  |pre|  |open|  | var share post dark pre open | mean gap  n');
const segs = {};
for (const s of SY) {
  const rows = [];
  for (let i = 0; i < DAYS.length - 1; i++) {
    const d0 = DAYS[i], d1 = DAYS[i + 1];
    const c = last(s, d0, 570, 960), p = last(s, d0, 960, 1199), a = first(s, d1, 240, 569), q = last(s, d1, 240, 569), o = first(s, d1, 570, 575);
    if (!c || !p || !a || !q || !o) continue;
    rows.push({ post: (p.c / c.c - 1) * 100, dark: (a.c / p.c - 1) * 100, pre: (q.c / a.c - 1) * 100, open: (o.c / q.c - 1) * 100, gap: (o.c / c.c - 1) * 100 });
  }
  segs[s] = rows;
  const v = (k) => rows.map((r) => r[k]);
  const tot = ['post', 'dark', 'pre', 'open'].reduce((acc, k) => acc + v(k).reduce((a, x) => a + x * x, 0), 0);
  const share = (k) => Math.round(100 * v(k).reduce((a, x) => a + x * x, 0) / tot);
  console.log('  ' + s.padEnd(6) + f(mean(v('post').map(Math.abs)), 7) + f(mean(v('dark').map(Math.abs)), 8) + f(mean(v('pre').map(Math.abs)), 7) + f(mean(v('open').map(Math.abs)), 8) + '   |' + String(share('post')).padStart(6) + String(share('dark')).padStart(5) + String(share('pre')).padStart(5) + String(share('open')).padStart(5) + '   |' + f(mean(v('gap')), 8) + String(rows.length).padStart(4));
}

// ---- B. pre-market predictiveness ------------------------------------------------------------
console.log('\nB. PRE-MARKET -> SESSION: liquid pre-market move (08:00 -> 09:25) vs the first 30 min and the full session');
console.log('  sym    corr(pre,first30) corr(pre,o->c) | pre UP: first30 mean/pos  o->c mean/pos | pre DOWN: first30 mean/pos  o->c mean/pos | n');
const corr = (a, b) => { const n = a.length; const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN; };
for (const s of SY) {
  const rows = [];
  for (const d of DAYS) {
    const a = at(s, d, 480, 'ge'), q = last(s, d, 240, 569), o = first(s, d, 570, 575), t = at(s, d, 600), c = last(s, d, 570, 960);
    if (!a || !q || !o || !t || !c || a.m >= 569) continue;
    rows.push({ pre: (q.c / a.c - 1) * 100, f30: (t.c / o.c - 1) * 100, oc: (c.c / o.c - 1) * 100 });
  }
  const up = rows.filter((r) => r.pre > 0.15), dn = rows.filter((r) => r.pre < -0.15);
  console.log('  ' + s.padEnd(6) + f(corr(rows.map((r) => r.pre), rows.map((r) => r.f30)), 10) + f(corr(rows.map((r) => r.pre), rows.map((r) => r.oc)), 14) + '  |' + f(mean(up.map((r) => r.f30)), 9) + '/' + String(pos(up.map((r) => r.f30))).padStart(3) + f(mean(up.map((r) => r.oc)), 8) + '/' + String(pos(up.map((r) => r.oc))).padStart(3) + '  |' + f(mean(dn.map((r) => r.f30)), 9) + '/' + String(pos(dn.map((r) => r.f30))).padStart(3) + f(mean(dn.map((r) => r.oc)), 8) + '/' + String(pos(dn.map((r) => r.oc))).padStart(3) + ' | ' + up.length + '/' + dn.length);
}

// ---- C. after-hours predictiveness -----------------------------------------------------------
console.log('\nC. AFTER-HOURS -> NEXT DAY: 16:00 -> 19:55 move vs the rest of the gap (19:55 -> next open) and the next session');
console.log('  sym    corr(post,restgap) corr(post,next o->c) | post UP: restgap mean/pos | post DOWN: restgap mean/pos | n');
for (const s of SY) {
  const rows = [];
  for (let i = 0; i < DAYS.length - 1; i++) {
    const d0 = DAYS[i], d1 = DAYS[i + 1];
    const c = last(s, d0, 570, 960), p = last(s, d0, 960, 1199), o = first(s, d1, 570, 575), c1 = last(s, d1, 570, 960);
    if (!c || !p || !o || !c1) continue;
    rows.push({ post: (p.c / c.c - 1) * 100, rest: (o.c / p.c - 1) * 100, noc: (c1.c / o.c - 1) * 100 });
  }
  const up = rows.filter((r) => r.post > 0.15), dn = rows.filter((r) => r.post < -0.15);
  console.log('  ' + s.padEnd(6) + f(corr(rows.map((r) => r.post), rows.map((r) => r.rest)), 10) + f(corr(rows.map((r) => r.post), rows.map((r) => r.noc)), 16) + '  |' + f(mean(up.map((r) => r.rest)), 10) + '/' + String(pos(up.map((r) => r.rest))).padStart(3) + '   |' + f(mean(dn.map((r) => r.rest)), 10) + '/' + String(pos(dn.map((r) => r.rest))).padStart(3) + ' | ' + up.length + '/' + dn.length);
}

// ---- D. our replayed stop-throughs at the open ------------------------------------------------
console.log('\nD. OUR STOP-OUTS AT THE OPEN (replay, 73 sessions): what an extended-hours exit would have fetched instead');
for (const [label, name] of [['race (armed)', 'oos_R_grafts14'], ['stable', 'oos_S_full'], ['S-first blend', 'oos_tR_grafts']]) {
  let tr; try { tr = JSON.parse(fs.readFileSync(DUMP + '.' + name + '.json', 'utf8')); } catch (e) { console.log('  ' + label + ': no dump'); continue; }
  const opens = tr.filter((t) => t.why === 'stop' && minOf(t.exit_ms) <= 580 && dayKey(t.entry_ms) !== dayKey(t.exit_ms));
  const rows = [];
  for (const t of opens) {
    const d1 = dayKey(t.exit_ms), i = DAYS.indexOf(d1); if (i < 1) continue; const d0 = DAYS[i - 1];
    const entryBar = at(t.sym, dayKey(t.entry_ms), minOf(t.entry_ms)); if (!entryBar) continue;
    const entry = entryBar.c; const actual = (1 + t.ret) * entry;
    const p = last(t.sym, d0, 960, 1199), q8 = at(t.sym, d1, 510), q9 = last(t.sym, d1, 240, 569);
    if (!p || !q8 || !q9) continue;
    rows.push({ sym: t.sym, actual: t.ret * 100, post: (p.c / entry - 1) * 100, pre830: (q8.c / entry - 1) * 100, pre925: (q9.c / entry - 1) * 100 });
  }
  console.log('  ' + label.padEnd(14) + 'overnight stop-throughs at the open: ' + rows.length + '  | mean exit %: actual ' + f(mean(rows.map((r) => r.actual)), 6) + '  at 19:55 prior ' + f(mean(rows.map((r) => r.post)), 6) + '  at 08:30 pre ' + f(mean(rows.map((r) => r.pre830)), 6) + '  at 09:25 pre ' + f(mean(rows.map((r) => r.pre925)), 6) + '  | pre-market 08:30 beat the fill in ' + rows.filter((r) => r.pre830 > r.actual).length + ' of ' + rows.length);
  for (const r of rows.slice(0, 12)) console.log('      ' + r.sym.padEnd(5) + ' actual ' + f(r.actual, 6) + '  19:55 ' + f(r.post, 6) + '  08:30 ' + f(r.pre830, 6) + '  09:25 ' + f(r.pre925, 6));
}

// ---- E. carries: where the overnight P&L of OUR carried positions came from -------------------
console.log('\nE. OUR CARRIES (race armed replay): overnight P&L of carried positions by segment, % of entry price per carried night');
{
  let tr; try { tr = JSON.parse(fs.readFileSync(DUMP + '.oos_R_grafts14.json', 'utf8')); } catch (e) { tr = []; }
  const acc = { post: [], dark: [], pre: [], open: [], nights: 0 };
  for (const t of tr) {
    const d0i = DAYS.indexOf(dayKey(t.entry_ms)), d1i = DAYS.indexOf(dayKey(t.exit_ms));
    if (d0i < 0 || d1i <= d0i) continue;
    for (let i = d0i; i < d1i; i++) {
      const d0 = DAYS[i], d1 = DAYS[i + 1];
      const c = last(t.sym, d0, 570, 960), p = last(t.sym, d0, 960, 1199), a = first(t.sym, d1, 240, 569), q = last(t.sym, d1, 240, 569), o = first(t.sym, d1, 570, 575);
      if (!c || !p || !a || !q || !o) continue;
      acc.post.push((p.c / c.c - 1) * 100); acc.dark.push((a.c / p.c - 1) * 100); acc.pre.push((q.c / a.c - 1) * 100); acc.open.push((o.c / q.c - 1) * 100); acc.nights++;
    }
  }
  console.log('  carried nights ' + acc.nights + ' | mean move: post ' + f(mean(acc.post), 6) + '  dark ' + f(mean(acc.dark), 6) + '  pre ' + f(mean(acc.pre), 6) + '  open print ' + f(mean(acc.open), 6) + '  | sd: post ' + f(sd(acc.post), 5) + ' dark ' + f(sd(acc.dark), 5) + ' pre ' + f(sd(acc.pre), 5) + ' open ' + f(sd(acc.open), 5));
}
