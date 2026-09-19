'use strict';
// team_score.js — the TEAMWORK scorecard for replay_team.js dumps.
// usage: node team_score.js <dump prefix> name1 name2 ...   (reads <prefix>.<name>.json + .daily.json)
// Per variant: return, maxDD, pos-days, pos-weeks, worst week, return/DD — all from the DAILY
// mark-to-market account series (not closed-trade sums); per-sleeve return; in-blend correlation of
// the sleeves' daily $ P&L; coverage = of the weeks where one sleeve lost, how many the account still
// won; collisions = entries refused under symbol ownership (and who won them).
const fs = require('fs');
const [prefix, ...names] = process.argv.slice(2);
const monday = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const corr = (a, b) => { const n = a.length; if (n < 3) return NaN; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN; };
const f2 = (x, w = 7) => (Number.isFinite(x) ? x.toFixed(2) : '-').padStart(w);
const pct = (x, w = 6) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '-').padStart(w);
console.log(`  ${'variant'.padEnd(18)}${'return'.padStart(8)}${'maxDD'.padStart(7)}${'ret/DD'.padStart(7)}${'posD'.padStart(6)}${'posW'.padStart(6)}${'worstW'.padStart(8)}${'S ret'.padStart(8)}${'R ret'.padStart(8)}${'corr'.padStart(7)}${'cover'.padStart(7)}${'collide'.padStart(10)}${'trades'.padStart(8)}${'WR'.padStart(5)}   h1/h2 (acct %)`);
for (const name of names) {
  let tr, d;
  try { tr = JSON.parse(fs.readFileSync(`${prefix}.${name}.json`, 'utf8')); d = JSON.parse(fs.readFileSync(`${prefix}.${name}.daily.json`, 'utf8')); } catch (e) { console.log(`  ${name.padEnd(18)} (missing: ${e.message.split(',')[0]})`); continue; }
  const days = d.daily;
  const acct = days.map((x) => x.acct), base = 100000;
  const ret = (acct[acct.length - 1] / base - 1) * 100;
  let pk = -Infinity, dd = 0; for (const e of acct) { pk = Math.max(pk, e); dd = Math.max(dd, (pk - e) / pk * 100); }
  const dAcct = acct.map((v, i) => (i ? v - acct[i - 1] : v - base));
  const dS = days.map((x, i) => (i ? x.S - days[i - 1].S : x.S));
  const dR = days.map((x, i) => (i ? x.R - days[i - 1].R : x.R));
  const dM = days.map((x, i) => (i ? (x.M || 0) - (days[i - 1].M || 0) : (x.M || 0)));
  const posD = dAcct.filter((x) => x > 0).length / dAcct.filter((x) => Math.abs(x) > 1e-9).length;
  const wk = {}; days.forEach((x, i) => { const w = monday(x.day); wk[w] = wk[w] || { a: 0, S: 0, R: 0 }; wk[w].a += dAcct[i]; wk[w].S += dS[i]; wk[w].R += dR[i]; });
  const weeks = Object.entries(wk).sort();
  const posW = weeks.filter(([, v]) => v.a > 0).length / weeks.length;
  const worstW = Math.min(...weeks.map(([, v]) => v.a)) / base * 100;
  const both = d.active.length >= 2;
  const has = (id) => d.active.includes(id);
  const c = has("S") && has("R") ? corr(dS, dR) : (has("S") && has("M") ? corr(dS, dM) : (has("R") && has("M") ? corr(dR, dM) : NaN));
  const mRet = tr.filter((t) => t.owner === "M").reduce((s, t) => s + t.pnl, 0) / base * 100;
  const extra = d.active.length === 3 ? `  M ${f2(mRet, 5)}%  corr S-M ${f2(corr(dS, dM), 5)} R-M ${f2(corr(dR, dM), 5)}` : (has("M") && d.active.length === 1 ? `  M ${f2(mRet, 5)}%` : "");
  const lossWeeks = weeks.filter(([, v]) => Math.min(v.S, v.R) < 0);
  // (coverage stays S/R-based; M shows in the extra column)
  const cover = both && lossWeeks.length ? lossWeeks.filter(([, v]) => v.a > 0).length / lossWeeks.length : NaN;
  const sRet = tr.filter((t) => t.owner === 'S').reduce((s, t) => s + t.pnl, 0) / base * 100;
  const rRet = tr.filter((t) => t.owner === 'R').reduce((s, t) => s + t.pnl, 0) / base * 100;
  const wonBy = { S: 0, R: 0 }; for (const k of (d.collisions || [])) wonBy[k.winner]++;
  const collide = both ? `S${wonBy.S}/R${wonBy.R}` : '-';
  const wr = tr.length ? tr.filter((t) => t.ret > 0).length / tr.length : NaN;
  const half = Math.floor(days.length / 2);
  const h1 = dAcct.slice(0, half).reduce((s, x) => s + x, 0) / base * 100, h2 = dAcct.slice(half).reduce((s, x) => s + x, 0) / base * 100;
  console.log(`  ${name.padEnd(18)}${f2(ret, 7)}%${f2(dd, 6)}%${f2(dd ? ret / dd : NaN, 7)}${pct(posD)}${pct(posW)}${f2(worstW, 7)}%${f2(sRet, 7)}%${f2(rRet, 7)}%${f2(c, 7)}${pct(cover, 7)}${collide.padStart(10)}${String(tr.length).padStart(8)}${pct(wr, 5)}   ${f2(h1, 6)} / ${f2(h2, 6)}${extra}`);
  if (process.env.WEEKS) console.log('      weeks: ' + weeks.map(([w, v]) => `${w.slice(5)}:${(v.a / base * 100).toFixed(1)}(${both ? (v.S / base * 100).toFixed(1) + '|' + (v.R / base * 100).toFixed(1) : ''})`).join(' '));
}
