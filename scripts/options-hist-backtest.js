#!/usr/bin/env node
'use strict';
/**
 * options-hist-backtest.js — the overnight OTM-ladder + PENNY strategy against REAL
 * historical option prices (Alpaca free historical option BARS, Feb-2024 → now).
 *
 * Replaces the synthetic-pricing model: for every GATED night (SPY trend-aligned +
 * vol-not-flat, Mon–Thu — the exact live gates in lib/options-shadow.js), reconstruct
 * the next-day-expiry call ladder from real traded prices:
 *   entry  ≈ the option's day-T CLOSE (last trade of entry day — near the 15:45 window)
 *   exit   ≈ expiry-day OPEN (the shadow's sell-at-open), and for PENNY the
 *            expiry-day HIGH ≥ 2¢ counts as the sell-at-2¢ target (a real trade printed).
 * Strikes are generated on SPY's $1 grid and fetched as multi-symbol bar requests —
 * no chain-discovery API needed, works on expired contracts.
 *
 * HONEST SCOPE: entries are last-trade closes, not asks (tight for near strikes,
 * looser for deep ones); penny fills assume you sell where a trade printed; sample
 * starts 2024-02 (Alpaca's options history floor). Results cached under
 * data/options-hist/ so reruns are free.
 *
 * Usage: node scripts/options-hist-backtest.js            (defaults: SPY, ladder+penny)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const ROOT = path.join(__dirname, '..');
const yahoo = require(path.join(ROOT, 'apps', 'lantern-garage', 'lib', 'market-data-yahoo'));
const CACHE_DIR = path.join(ROOT, 'data', 'options-hist');
const DEPTHS = [0.25, 0.5, 1.0, 1.5, 2.0];
const PENNY_MAX = 0.011, PENNY_EXIT = 0.02, DATA_FLOOR = '2024-02-09';

function keys() {
  const id = process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
  const sec = process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '';
  if (!id || !sec) { console.error('need ALPACA_API_KEY_ID/_SECRET_KEY in env'); process.exit(1); }
  return { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
}
function get(pathq, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host: 'data.alpaca.markets', path: pathq, method: 'GET', headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_e) { } resolve({ ok: res.statusCode === 200, json: j, status: res.statusCode }); });
    });
    req.on('error', () => resolve({ ok: false })); req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false }); }); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── gates (identical math to lib/options-shadow.js) ─────────────────────────
function smaAt(a, n, end) { if (end < n - 1) return null; let s = 0; for (let i = end - n + 1; i <= end; i++) s += a[i]; return s / n; }
function emaAll(a, n) { if (a.length < n) return null; const k = 2 / (n + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function macdLine(c) { if (c.length < 35) return 0; const t = c.slice(-35); return emaAll(t, 12) - emaAll(t, 26); }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function occ(sym, expiry, strike) {
  const [y, m, d] = expiry.split('-');
  return `${sym}${y.slice(2)}${m}${d}C${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}
function fmtDate(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }

async function main() {
  const H = keys();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // SPY dailies from Yahoo (10y) → gated Mon–Thu nights since the Alpaca data floor.
  const r = await yahoo.getBars('SPY', '1d');
  const bars = (r && r.bars) || [];
  const closes = bars.map((b) => b.close);
  const dret = []; for (let i = 1; i < closes.length; i++) dret.push(closes[i] / closes[i - 1] - 1);
  const rvAt = (e) => { if (e < 10) return null; const w = dret.slice(e - 10, e); const m = w.reduce((s, x) => s + x, 0) / w.length; return Math.sqrt(w.reduce((s, x) => s + (x - m) * (x - m), 0) / w.length); };
  const nights = [];
  for (let i = 70; i < bars.length - 1; i++) {
    const t = bars[i].timestamp; if (!t) continue;
    const dt = new Date(t); const dow = dt.getUTCDay(); if (dow < 1 || dow > 4) continue;
    const date = fmtDate(dt); if (date < DATA_FLOOR) continue;
    const s50 = smaAt(closes, 50, i); const mh = macdLine(closes.slice(0, i + 1));
    if (!((s50 == null || closes[i] > s50) && mh > 0)) continue;
    const v = rvAt(i); if (v == null) continue;
    const hist = []; for (let e = Math.max(10, i - 60); e < i; e++) hist.push(rvAt(e));
    const vm = median(hist.filter((x) => x != null)); if (!(vm != null && v > vm)) continue;
    nights.push({ i, date, expiry: fmtDate(new Date(bars[i + 1].timestamp)), spot: closes[i], rv10: v });
  }
  console.log(`gated nights with next-day data since ${DATA_FLOOR}: ${nights.length}`);

  const legs = { penny: [] }; for (const K of DEPTHS) legs[K] = [];
  let fetched = 0, cached = 0;
  for (const n of nights) {
    const cacheFile = path.join(CACHE_DIR, `spy-${n.date}.json`);
    let byStrike = null;
    if (fs.existsSync(cacheFile)) { byStrike = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cached++; }
    else {
      // $1 strike grid from ATM to +3.5% OTM, one multi-symbol bars call per night.
      const strikes = []; for (let k = Math.ceil(n.spot); k <= Math.ceil(n.spot * 1.035); k++) strikes.push(k);
      const syms = strikes.map((k) => occ('SPY', n.expiry, k));
      const q = `symbols=${syms.join(',')}&timeframe=1Day&start=${n.date}&end=${n.expiry}T23:59:00Z&limit=1000`;
      const resp = await get(`/v1beta1/options/bars?${q}`, H);
      if (!resp.ok || !resp.json || !resp.json.bars) { await sleep(400); continue; }
      byStrike = {};
      for (const [s, arr] of Object.entries(resp.json.bars)) {
        const strike = parseInt(s.slice(-8), 10) / 1000;
        const tBar = arr.find((b) => b.t.slice(0, 10) === n.date);
        const eBar = arr.find((b) => b.t.slice(0, 10) === n.expiry);
        byStrike[strike] = { entryClose: tBar ? tBar.c : null, exitOpen: eBar ? eBar.o : null, exitHigh: eBar ? eBar.h : null };
      }
      fs.writeFileSync(cacheFile, JSON.stringify(byStrike));
      fetched++; await sleep(350);   // free-tier courtesy throttle
    }
    const strikes = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
    // ladder legs: nearest listed strike ≥ spot×(1+K%), entry=day-T close, exit=expiry open
    for (const K of DEPTHS) {
      const target = n.spot * (1 + K / 100);
      const k = strikes.find((s) => s >= target && byStrike[s].entryClose > 0);
      if (k == null) continue;
      const e = byStrike[k];
      if (!(e.entryClose > 0)) continue;
      const exitV = e.exitOpen != null ? e.exitOpen : 0;    // no expiry-day trade → ≈ worthless open
      legs[K].push({ date: n.date, pl: (exitV - e.entryClose) / e.entryClose * 100 });
    }
    // penny leg: first strike whose day-T close ≤ 1¢ (traded at a penny), σ-selective ≤3σ
    const pk = strikes.find((s) => byStrike[s].entryClose != null && byStrike[s].entryClose > 0 && byStrike[s].entryClose <= PENNY_MAX);
    if (pk != null) {
      const dist = pk / n.spot - 1; const sigma = dist / n.rv10;
      if (sigma <= 3) {
        const e = byStrike[pk];
        const hit = (e.exitHigh || 0) >= PENNY_EXIT;
        legs.penny.push({ date: n.date, strike: pk, sigma: +sigma.toFixed(2), pl: hit ? ((PENNY_EXIT - e.entryClose) / e.entryClose) * 100 : -100 });
      }
    }
  }
  console.log(`fetched ${fetched} nights live, ${cached} from cache\n`);
  const stat = (rows) => {
    const n = rows.length; if (!n) return { n: 0 };
    const wins = rows.filter((x) => x.pl > 0).length; const avg = rows.reduce((s, x) => s + x.pl, 0) / n;
    return { n, win_pct: +(wins / n * 100).toFixed(1), avg_pl_pct: +avg.toFixed(1), total_pl_pct: +(rows.reduce((s, x) => s + x.pl, 0)).toFixed(0) };
  };
  console.log('REAL-CHAIN overnight results (entry=day-T close, exit=open / penny target=high≥2¢):');
  for (const K of DEPTHS) console.log(`  ${String(K).padEnd(5)}% OTM `, JSON.stringify(stat(legs[K])));
  console.log('  penny(≤1¢,≤3σ)', JSON.stringify(stat(legs.penny)));
  const hits = legs.penny.filter((x) => x.pl > 0);
  if (legs.penny.length) console.log(`  penny detail: ${legs.penny.length} tickets, ${hits.length} hit 2¢ target — dates: ${hits.map((h) => h.date).join(', ') || 'none'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
