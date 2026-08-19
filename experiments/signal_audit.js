'use strict';
/**
 * signal_audit.js — does each signal component carry information?
 *
 * entry_edge_test.js measured the entry STACK (direction -> rileyGate ->
 * convergence) and found the stack has no edge over the base rate, with
 * rileyGate actively destroying it. This audits the INDIVIDUAL components that
 * feed those stages, so each one can be judged on its own evidence rather than
 * inherited belief.
 *
 * METHOD. Walk daily bars with the real production modules, no look-ahead. At
 * every bar where the engine reads BULLISH (the universe the longs-only trader
 * actually acts in), record the forward return AND each component's verdict.
 * Then, per component, split the SAME sample on that verdict and compare.
 *
 * A component earns its place only if its two halves differ: if "structure
 * shifted" and "structure did not shift" have the same forward return, the
 * component is measuring nothing, whatever its intuition says.
 *
 * Reported as a t-statistic on the difference of means. |t| < 2 is noise.
 * A NEGATIVE t means the component is backwards: the case it treats as
 * bullish confirmation is followed by WORSE returns.
 *
 * Usage: node experiments/signal_audit.js [--horizon 5] [--symbols SPY,QQQ,...]
 */

const https = require('https');
const path = require('path');
const LIB = path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib', 'signal-engine');
const { rsi, adaptiveRsiThresholds, macd, priceVsSma, volumeRatio, atr } = require(path.join(LIB, 'indicators'));
const { findSrZones } = require(path.join(LIB, 'sr-zones'));
const { detectCandlePatterns } = require(path.join(LIB, 'candles'));
const { checkMarketStructureShift } = require(path.join(LIB, 'market-structure'));
const scan = require(path.join(LIB, 'scan'));

const args = process.argv.slice(2);
const arg = (k, d) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : d);
const HORIZON = Number(arg('--horizon', 5));
const SYMBOLS = String(arg('--symbols', 'SPY,QQQ,GLD,TLT,SMH')).split(',');
const WINDOW = 120;

function fetchJson(url) {
  return new Promise((res, rej) => {
    const rq = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    rq.on('error', rej);
    rq.setTimeout(30000, () => { rq.destroy(); rej(new Error('timeout')); });
  });
}
async function bars(sym) {
  const p1 = Math.floor(Date.UTC(1999, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${p2}`);
  const r = j.chart.result[0], q = r.indicators.quote[0], out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    out.push({ timestamp: new Date(r.timestamp[i] * 1000).toISOString(), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  }
  return out;
}

// component name -> { yes: [fwd...], no: [fwd...] }
const COMP = {};
function record(name, cond, fwd) {
  if (cond == null) return;
  COMP[name] = COMP[name] || { yes: [], no: [] };
  COMP[name][cond ? 'yes' : 'no'].push(fwd);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tstat(a, b) {
  if (a.length < 30 || b.length < 30) return null;
  const va = a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mean(b)) ** 2, 0) / (b.length - 1);
  return (mean(a) - mean(b)) / Math.sqrt(va / a.length + vb / b.length);
}

(async () => {
  console.log(`SIGNAL COMPONENT AUDIT — ${HORIZON}-bar forward return, daily bars`);
  console.log(`universe: bars where the engine reads BULLISH (what the longs-only trader acts on)\n`);

  for (const sym of SYMBOLS) {
    const b = await bars(sym).catch(() => []);
    if (b.length < 500) { console.log(`${sym}: no data`); continue; }
    for (let i = WINDOW; i < b.length - HORIZON; i++) {
      const win = b.slice(i - WINDOW, i + 1);
      const closes = win.map((x) => x.close);
      const price = b[i].close;
      const fwd = ((b[i + HORIZON].close - price) / price) * 100;

      const sr = findSrZones(sym, price, win);
      const th = adaptiveRsiThresholds(closes);
      const rv = rsi(closes) ?? 50;
      const direction = scan.deriveDirection(sr, rv, th, { closes });
      if (direction !== 'BULLISH') continue;

      const struct = checkMarketStructureShift(win, direction);
      const candle = detectCandlePatterns(win, direction);
      const gate = scan.rileyGate({ sr, rsiVal: rv, thresholds: th, struct, candle, direction, trending: false });
      const m = macd(closes);
      const vr = volumeRatio(win);
      const a = atr(win) || price * 0.005;

      // ── the components the engine actually boosts/filters on ──
      record('rileyGate.actionable', !!gate.actionable, fwd);
      record('rileyGate.approved', !!gate.approved, fwd);
      record('gate.quality=PERFECT', gate.quality === 'PERFECT', fwd);
      record('structureShifted', !!struct.structureShifted, fwd);
      record('struct.exhaustive', !!struct.exhaustive, fwd);
      record('candle confirms', !!(candle.pattern && candle.confirms), fwd);
      record('candle str>=65', !!(candle.pattern && candle.confirms && candle.strength >= 65), fwd);
      record('in_zone', !!sr.in_zone, fwd);
      record('touches>=2', (sr.touches || 0) >= 2, fwd);
      record('touches>=3', (sr.touches || 0) >= 3, fwd);
      record('zone_strength>=70', (sr.zone_strength || 0) >= 70, fwd);
      record('volume_ratio>=1.2 (A+)', vr >= 1.2, fwd);
      record('macd_hist>0', m ? m.histogram > 0 : null, fwd);
      record('price>SMA20', (priceVsSma(closes, 20) || 0) > 0, fwd);
      record('RSI oversold', rv <= th.oversold, fwd);
      record('RSI overbought', rv >= th.overbought, fwd);

      // room to first resistance, in stop units — the A/B tiering criterion
      const res1 = (sr.zones || []).filter((z) => /RESIST/i.test(z.type || '') && z.level > price * 1.001)
        .sort((x, y) => x.level - y.level)[0];
      const stopPct = Math.max((a * 2.2 / price) * 100, 0.8);
      if (res1) record('room>=1.5R (A-tier)', ((res1.level - price) / price) * 100 / stopPct >= 1.5, fwd);
      else record('room>=1.5R (A-tier)', true, fwd);   // no resistance = open room

      // support-entry geometry
      const sup = (sr.zones || []).filter((z) => /SUPPORT/i.test(z.type || '') && (z.top || z.level) <= price * 1.001)
        .sort((x, y) => (y.top || y.level) - (x.top || x.level))[0];
      record('within 0.5 ATR of support', sup ? (price - (sup.top || sup.level)) / a <= 0.5 : false, fwd);
    }
  }

  const rows = [];
  for (const [name, d] of Object.entries(COMP)) {
    const t = tstat(d.yes, d.no);
    if (t == null) { rows.push({ name, note: `too few samples (${d.yes.length}/${d.no.length})` }); continue; }
    rows.push({ name, yn: d.yes.length, nn: d.no.length, my: mean(d.yes), mn: mean(d.no), diff: mean(d.yes) - mean(d.no), t });
  }
  rows.sort((a, b) => (b.t ?? -99) - (a.t ?? -99));

  console.log('component                      n(yes)  mean(yes)  mean(no)     diff       t   verdict');
  console.log('-'.repeat(92));
  for (const r of rows) {
    if (r.note) { console.log(`${r.name.padEnd(30)} ${r.note}`); continue; }
    const v = Math.abs(r.t) < 2 ? 'NOISE — no information'
      : r.t > 0 ? 'informative' : 'BACKWARDS — inverted';
    console.log(
      `${r.name.padEnd(30)} ${String(r.yn).padStart(6)}  ${r.my.toFixed(3).padStart(8)}%  ${r.mn.toFixed(3).padStart(7)}%  `
      + `${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(3)}%  ${r.t.toFixed(2).padStart(6)}   ${v}`,
    );
  }
  console.log('\n|t| < 2 = indistinguishable from noise. Negative t = the "bullish" case does WORSE.');
})();
