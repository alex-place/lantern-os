'use strict';
// experiments/team_regimes.js — regime versatility + natural correlation from the DAILY mark-to-market dumps.
// usage: node team_regimes.js <prefix> name1 name2 ...
// (1) per day-type (same classifier as consistency.js / regime_matrix.js): traded-day count, positive-day
//     rate, mean day % — the operator's "consistent in every regime" question, on MTM P&L;
// (2) pairwise correlation of the daily P&L series across the named variants (variants run ALONE give the
//     two ecologies' natural correlation; blends give the in-account one);
// (3) week table side by side.
const fs = require('fs');
const [prefix, ...names] = process.argv.slice(2);
const CACHE = process.env.TEMP + '/rev60cache/';
const ET = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const DAY = (ms) => { const d = ET(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MIN = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };
const spy = JSON.parse(fs.readFileSync(CACHE + 'SPY.json', 'utf8'));
const byDay = {};
for (const b of spy) { const d = DAY(b.t), m = MIN(b.t); if (m < 570 || m > 960) continue; (byDay[d] = byDay[d] || []).push({ ...b, m }); }
const types = {};
for (const [d, a] of Object.entries(byDay)) {
  if (a.length < 30) continue;
  const o = a[0].o ?? a[0].c, c = a[a.length - 1].c;
  const hi = Math.max(...a.map((b) => b.h)), lo = Math.min(...a.map((b) => b.l));
  const oc = (c / o - 1) * 100, range = (hi / lo - 1) * 100;
  const closePos = (c - lo) / Math.max(hi - lo, 1e-9);
  let loBar = a[0]; for (const b of a) if (b.l < loBar.l) loBar = b;
  const recovery = (c / loBar.l - 1) * 100;
  types[d] = (oc >= 0.45 && closePos >= 0.67) ? 'trend-up'
    : (oc <= -0.45 && closePos <= 0.33) ? 'trend-down'
    : (loBar.m <= 750 && closePos >= 0.6 && recovery >= 0.6) ? 'V-day'
    : (Math.abs(oc) < 0.45 && range < 0.9) ? 'quiet' : 'chop';
}
const series = {};
for (const n of names) {
  const d = JSON.parse(fs.readFileSync(`${prefix}.${n}.daily.json`, 'utf8')).daily;
  series[n] = d.map((x, i) => ({ day: x.day, pct: (i ? x.acct - d[i - 1].acct : x.acct - 100000) / 1000, S: (i ? x.S - d[i - 1].S : x.S) / 1000, R: (i ? x.R - d[i - 1].R : x.R) / 1000 }));
}
const TYPES = ['trend-up', 'V-day', 'chop', 'quiet', 'trend-down'];
console.log('REGIME VERSATILITY (daily MTM %, positive-day rate | mean day %)');
console.log('  ' + 'regime'.padEnd(12) + 'days'.padStart(5) + names.map((n) => n.padStart(22)).join(''));
for (const ty of TYPES) {
  const days = Object.keys(types).filter((d) => types[d] === ty && series[names[0]].some((x) => x.day === d));
  if (!days.length) continue;
  let line = '  ' + ty.padEnd(12) + String(days.length).padStart(5);
  for (const n of names) {
    const v = series[n].filter((x) => days.includes(x.day)).map((x) => x.pct);
    const traded = v.filter((x) => Math.abs(x) > 1e-6);
    const pos = traded.filter((x) => x > 0).length;
    line += `${traded.length ? Math.round(100 * pos / traded.length) + '%' : '-'}`.padStart(9) + ` | ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}`.padStart(13);
  }
  console.log(line);
}
const corr = (a, b) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN; };
console.log('\nDAILY P&L CORRELATION (account series)');
console.log('  ' + ''.padEnd(18) + names.map((n) => n.padStart(16)).join(''));
for (const a of names) console.log('  ' + a.padEnd(18) + names.map((b) => corr(series[a].map((x) => x.pct), series[b].map((x) => x.pct)).toFixed(2).padStart(16)).join(''));
const monday = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
console.log('\nWEEKS (account %)');
const weeks = [...new Set(series[names[0]].map((x) => monday(x.day)))].sort();
console.log('  ' + 'week'.padEnd(8) + names.map((n) => n.padStart(16)).join(''));
for (const w of weeks) console.log('  ' + w.slice(5).padEnd(8) + names.map((n) => series[n].filter((x) => monday(x.day) === w).reduce((s, x) => s + x.pct, 0).toFixed(2).padStart(16)).join(''));
console.log('  ' + 'sd(week)'.padEnd(8) + names.map((n) => { const v = weeks.map((w) => series[n].filter((x) => monday(x.day) === w).reduce((s, x) => s + x.pct, 0)); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length).toFixed(2).padStart(16); }).join(''));
