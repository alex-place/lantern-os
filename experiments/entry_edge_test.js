'use strict';
/**
 * entry_edge_test.js — does the FULL entry stack predict anything?
 *
 * Every improvement shipped 2026-08-05 (zone ladder, target separation, room
 * tiering, risk sizing) is downstream of an entry trigger whose first stage —
 * deriveDirection — measured as mildly INVERTED on 15m bars: BULLISH reads
 * followed by -0.003% vs BEARISH by +0.009%/+0.029% over 2,338 samples.
 *
 * That test covered the primitive ALONE. A live entry must also clear
 * rileyGate.actionable AND convergenceVerdict === ENTER, so the full stack
 * could still have edge the primitive lacks. This measures that, over 26 years
 * of daily bars instead of 30 days of 15m, using the REAL production modules.
 *
 * Method: walk each symbol bar-by-bar on a trailing window (no look-ahead).
 * At every bar compute the full stack. Compare forward returns after an ENTER
 * signal against the UNCONDITIONAL base rate over the same bars — because a
 * signal that fires in a bull market and returns +0.4% has no edge if every
 * random bar also returns +0.4%. Edge is the DIFFERENCE, not the level.
 *
 * Usage: node experiments/entry_edge_test.js [--horizon 5] [--symbols SPY,QQQ]
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

const stats = (a) => {
  if (!a.length) return { n: 0 };
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
  return { n: a.length, mean: m, up: (a.filter((x) => x > 0).length / a.length) * 100, se: sd / Math.sqrt(a.length) };
};
const fmt = (s) => s.n
  ? `n=${String(s.n).padStart(6)}  mean ${(s.mean >= 0 ? '+' : '') + s.mean.toFixed(4)}%  up ${s.up.toFixed(1)}%  se ${s.se.toFixed(4)}`
  : 'n=0';

(async () => {
  console.log(`ENTRY-STACK EDGE TEST — ${HORIZON}-bar forward return, daily bars\n`);
  const all = { base: [], dir: [], gate: [], enter: [] };

  for (const sym of SYMBOLS) {
    const b = await bars(sym).catch(() => []);
    if (b.length < 500) { console.log(`${sym}: no data`); continue; }
    const per = { base: [], dir: [], gate: [], enter: [] };

    for (let i = WINDOW; i < b.length - HORIZON; i++) {
      const win = b.slice(i - WINDOW, i + 1);
      const closes = win.map((x) => x.close);
      const price = b[i].close;
      const fwd = ((b[i + HORIZON].close - price) / price) * 100;
      per.base.push(fwd);                                  // unconditional base rate

      const sr = findSrZones(sym, price, win);
      const th = adaptiveRsiThresholds(closes);
      const rv = rsi(closes) ?? 50;
      const direction = scan.deriveDirection(sr, rv, th, { closes });
      if (direction !== 'BULLISH') continue;
      per.dir.push(fwd);                                   // stage 1: direction only

      const struct = checkMarketStructureShift(win, direction);
      const candle = detectCandlePatterns(win, direction);
      const gate = scan.rileyGate({ sr, rsiVal: rv, thresholds: th, struct, candle, direction, trending: false });
      if (!gate.actionable) continue;
      per.gate.push(fwd);                                  // stage 2: + rileyGate

      const m = macd(closes);
      const cv = scan.convergenceVerdict({
        t: sym, direction, sr, struct, candle, marketStatus: { market: 'NEUTRAL' },
        news_sentiment: 0, volume_ratio: volumeRatio(win), macd_hist: m ? m.histogram : 0,
        ma_signal: priceVsSma(closes, 20), earnings_surprise: null, sector_trend: null,
      });
      if (!cv || cv.decision !== 'ENTER') continue;
      per.enter.push(fwd);                                 // stage 3: FULL stack — what actually trades
    }

    const bs = stats(per.base), es = stats(per.enter);
    console.log(`${sym}`);
    console.log(`  base   ${fmt(bs)}`);
    console.log(`  dir    ${fmt(stats(per.dir))}`);
    console.log(`  gate   ${fmt(stats(per.gate))}`);
    console.log(`  ENTER  ${fmt(es)}`);
    if (bs.n && es.n) {
      const edge = es.mean - bs.mean;
      console.log(`  EDGE vs base: ${(edge >= 0 ? '+' : '') + edge.toFixed(4)}%  (${(edge / es.se).toFixed(2)} se)\n`);
    }
    for (const k of Object.keys(all)) all[k].push(...per[k]);
  }

  console.log('='.repeat(64));
  console.log('POOLED');
  const bs = stats(all.base);
  for (const k of ['base', 'dir', 'gate', 'enter']) console.log(`  ${k.padEnd(6)} ${fmt(stats(all[k]))}`);
  const es = stats(all.enter);
  if (bs.n && es.n) {
    const edge = es.mean - bs.mean;
    const t = edge / es.se;
    console.log(`\n  EDGE vs base: ${(edge >= 0 ? '+' : '') + edge.toFixed(4)}% over ${HORIZON} bars  (t=${t.toFixed(2)})`);
    console.log(`  VERDICT: ${Math.abs(t) < 2 ? 'NO significant edge — the entry stack does not beat picking a random bar'
      : t > 0 ? 'real positive edge' : 'SIGNIFICANTLY NEGATIVE — the stack is anti-predictive'}`);
  }
})();
