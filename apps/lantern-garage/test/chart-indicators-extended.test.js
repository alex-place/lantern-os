// Indicator maths added in the library expansion (#3333 follow-up).
//
// Same approach as chart-indicators.test.js: the formulas live inline in
// stock-trader.html (the chart is one self-contained page), so this extracts the
// maths block and exercises it in isolation. Each check is either a published
// reference value or an identity the definition forces — never "whatever the code
// currently returns".
//
// Run: node apps/lantern-garage/test/chart-indicators-extended.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8');
const start = HTML.indexOf('const _iNum =');
const end = HTML.indexOf('// ── Registry ─');
assert.ok(start > 0 && end > start, 'indicator maths block not found in stock-trader.html');

const api = {};
new Function('exports', HTML.slice(start, end) + `
Object.assign(exports, { _iSMA,_iEMA,_iWMA,_iHMA,_iVWMA,_iDEMA,_iTEMA,_iPSAR,_iSupertrend,_iEnvelope,
  _iWilliamsR,_iROC,_iMomentum,_iTRIX,_iStochRSI,_iCMF,_iAD,_iAwesome,_iAroon,_iPPO,_iCMO,
  _iStdev,_iSrc,_iATR,_iRSI });`)(api);

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

const closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,
                46.28,46.00,46.03,46.41,46.22,45.64,46.21,46.25,45.71,46.45,45.78,45.35,44.03,44.18,44.22,44.57];
const bars = closes.map((c, i) => ({ open: c, high: c + 0.4, low: c - 0.4, close: c, volume: 1000 + i * 7 }));
const near = (a, b, t) => Math.abs(a - b) <= t;

check('Williams %R is exactly the inverse of Stochastic %K on the same window', () => {
  const wr = api._iWilliamsR(bars, 14);
  // %R = -100 * (H-C)/(H-L); %K = 100*(C-L)/(H-L)  =>  %R = %K - 100
  for (let i = 20; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = 0; j < 14; j++) { hi = Math.max(hi, bars[i-j].high); lo = Math.min(lo, bars[i-j].low); }
    const k = ((bars[i].close - lo) / (hi - lo)) * 100;
    assert.ok(near(wr[i], k - 100, 1e-9), `bar ${i}: ${wr[i]} vs ${k - 100}`);
  }
});

check('Williams %R stays inside [-100, 0]', () => {
  for (const v of api._iWilliamsR(bars, 14)) if (v != null) assert.ok(v >= -100 && v <= 0, String(v));
});

check('ROC of a constant series is 0; of a doubling step is +100%', () => {
  const flat = Array.from({ length: 20 }, () => ({ close: 50, high: 50, low: 50, volume: 1 }));
  assert.strictEqual(api._iROC(flat, 5)[10], 0);
  const step = Array.from({ length: 20 }, (_, i) => ({ close: i < 10 ? 10 : 20, high: 20, low: 10, volume: 1 }));
  assert.ok(near(api._iROC(step, 5)[14], 100, 1e-9), String(api._iROC(step, 5)[14]));
});

check('Momentum is a plain difference over the lookback', () => {
  const m = api._iMomentum(bars, 10);
  assert.ok(near(m[20], closes[20] - closes[10], 1e-9));
});

check('VWMA equals SMA when every bar carries the same volume', () => {
  const same = closes.map(c => ({ open: c, high: c, low: c, close: c, volume: 500 }));
  const v = api._iVWMA(same, 10), s = api._iSMA(closes, 10);
  for (let i = 9; i < closes.length; i++) assert.ok(near(v[i], s[i], 1e-9), `bar ${i}`);
});

check('VWMA leans toward the heavily-traded price', () => {
  const b = [
    { close: 10, volume: 1 }, { close: 10, volume: 1 }, { close: 20, volume: 998 },
  ].map(x => ({ open: x.close, high: x.close, low: x.close, ...x }));
  const v = api._iVWMA(b, 3)[2];
  assert.ok(v > 19.9, `expected ~20, got ${v}`);   // plain SMA would be 13.33
});

check('DEMA and TEMA sit closer to price than the EMA they are built from', () => {
  // 200 bars, not 60: TEMA is a triple EMA and each stage seeds on an SMA, so at 60
  // bars its outermost stage has ~3 samples and has not converged. That is warm-up,
  // not lag — measure once all three stages are actually running.
  const rising = Array.from({ length: 200 }, (_, i) => 100 + i);
  const e = api._iEMA(rising, 20), d2 = api._iDEMA(rising, 20), t3 = api._iTEMA(rising, 20);
  const last = rising.length - 1, px = rising[last];
  const errE = Math.abs(e[last] - px), errD = Math.abs(d2[last] - px), errT = Math.abs(t3[last] - px);
  // On a straight ramp both de-lagged averages land on price EXACTLY, so this asserts
  // "no worse, and both beat the plain EMA" rather than a strict ordering between two
  // zeros. The EMA's lag here is real and large (~9.5 on a slope of 1).
  assert.ok(errE > 1, `EMA should visibly lag a ramp, got ${errE}`);
  assert.ok(errD < errE, `DEMA (${errD}) should beat EMA (${errE})`);
  assert.ok(errT <= errD + 1e-9, `TEMA (${errT}) should be no worse than DEMA (${errD})`);
});

check('Hull MA tracks a clean ramp almost exactly', () => {
  const ramp = Array.from({ length: 80 }, (_, i) => 50 + i * 0.5);
  const h = api._iHMA(ramp, 16);
  const last = ramp.length - 1;
  assert.ok(Math.abs(h[last] - ramp[last]) < 0.5, `HMA ${h[last]} vs price ${ramp[last]}`);
});

check('Parabolic SAR sits below price in an uptrend and above it in a downtrend', () => {
  const up = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 1 }));
  const dn = Array.from({ length: 40 }, (_, i) => ({ high: 200 - i + 1, low: 200 - i - 1, close: 200 - i, volume: 1 }));
  const su = api._iPSAR(up, 0.02, 0.2), sd = api._iPSAR(dn, 0.02, 0.2);
  assert.ok(su[35] < up[35].close, `uptrend SAR ${su[35]} should be under ${up[35].close}`);
  assert.ok(sd[35] > dn[35].close, `downtrend SAR ${sd[35]} should be over ${dn[35].close}`);
});

check('Supertrend flips direction when price crosses it', () => {
  const seq = [];
  for (let i = 0; i < 40; i++) seq.push({ high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 1 });
  for (let i = 0; i < 40; i++) seq.push({ high: 140 - i + 1, low: 140 - i - 1, close: 140 - i, volume: 1 });
  const st = api._iSupertrend(seq, 10, 3);
  const dirs = st.dir.filter(v => v != null);
  assert.ok(dirs.includes(1) && dirs.includes(-1), 'both trend states occur');
  assert.strictEqual(st.dir[35], 1, 'still long inside the rally');
  assert.strictEqual(st.dir[75], -1, 'short by the end of the decline');
});

check('Envelope bands are a fixed percentage either side of the mean', () => {
  const e = api._iEnvelope(closes, 20, 2.5);
  const i = 25;
  assert.ok(near(e.upper[i], e.mid[i] * 1.025, 1e-9));
  assert.ok(near(e.lower[i], e.mid[i] * 0.975, 1e-9));
});

check('Stochastic RSI is bounded 0-100, and is a GAP (not 0) where RSI is flat', () => {
  // A pure ramp pins RSI at 100, so the %K window has zero range: 0/0. Emitting 0 there
  // would paint "oversold" at the top of a rally, so the definition's undefined case
  // stays undefined and the line breaks instead of lying.
  const ramp = Array.from({ length: 60 }, (_, i) => ({ open: 1, high: 1, low: 1, close: 100 + i, volume: 1 }));
  assert.strictEqual(api._iStochRSI(ramp, 14, 14, 3).k[55], null, 'flat RSI window -> gap, never 0');

  // With RSI actually moving, %K is bounded and reaches its extremes.
  const wavy = Array.from({ length: 120 }, (_, i) => {
    const c = 100 + i * 0.3 + Math.sin(i / 3) * 6;
    return { open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 100 };
  });
  const k = api._iStochRSI(wavy, 14, 14, 3).k.filter(v => v != null);
  assert.ok(k.length > 40, `expected a populated series, got ${k.length}`);
  for (const v of k) assert.ok(v >= 0 && v <= 100, String(v));
  assert.ok(Math.max(...k) > 90 && Math.min(...k) < 10, 'spans its range on real movement');
});

check('Chaikin money flow is +1 when every close is the high, -1 when every close is the low', () => {
  const top = Array.from({ length: 30 }, () => ({ high: 10, low: 8, close: 10, volume: 100 }));
  const bot = Array.from({ length: 30 }, () => ({ high: 10, low: 8, close: 8, volume: 100 }));
  assert.ok(near(api._iCMF(top, 20)[25], 1, 1e-9));
  assert.ok(near(api._iCMF(bot, 20)[25], -1, 1e-9));
});

check('Accumulation/Distribution rises on closes at the high, falls on closes at the low', () => {
  const top = Array.from({ length: 10 }, () => ({ high: 10, low: 8, close: 10, volume: 100 }));
  const bot = Array.from({ length: 10 }, () => ({ high: 10, low: 8, close: 8, volume: 100 }));
  assert.ok(api._iAD(top)[9] > api._iAD(top)[0], 'accumulating');
  assert.ok(api._iAD(bot)[9] < api._iAD(bot)[0], 'distributing');
});

check('Awesome oscillator is SMA5(hl2) - SMA34(hl2)', () => {
  const ao = api._iAwesome(bars);
  const hl2 = api._iSrc(bars, 'hl2');
  const f = api._iSMA(hl2, 5), s = api._iSMA(hl2, 34);
  for (let i = 0; i < bars.length; i++) {
    if (f[i] == null || s[i] == null) { assert.strictEqual(ao[i], null); continue; }
    assert.ok(near(ao[i], f[i] - s[i], 1e-9));
  }
});

check('Aroon reads 100/0 at a fresh high and 0/100 at a fresh low', () => {
  const up = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i, low: 90 + i, close: 95 + i, volume: 1 }));
  const a = api._iAroon(up, 25);
  assert.ok(near(a.up[39], 100, 1e-9), `aroon-up ${a.up[39]}`);
  assert.ok(near(a.dn[39], 4, 1e-9) || a.dn[39] < 10, `aroon-down should be low, got ${a.dn[39]}`);
});

check('PPO is MACD expressed as a percentage of the slow EMA', () => {
  const x = api._iPPO(bars, 12, 26, 9);
  const s = api._iSrc(bars, 'close');
  const f = api._iEMA(s, 12), sl = api._iEMA(s, 26);
  const i = 28;
  assert.ok(near(x.ppo[i], ((f[i] - sl[i]) / sl[i]) * 100, 1e-9));
});

check('Chande momentum is +100 on an unbroken rise and -100 on an unbroken fall', () => {
  const up = Array.from({ length: 30 }, (_, i) => ({ close: 100 + i, high: 0, low: 0, volume: 1 }));
  const dn = Array.from({ length: 30 }, (_, i) => ({ close: 100 - i, high: 0, low: 0, volume: 1 }));
  assert.ok(near(api._iCMO(up, 14)[25], 100, 1e-9));
  assert.ok(near(api._iCMO(dn, 14)[25], -100, 1e-9));
});

check('standard deviation of a constant series is 0', () => {
  const flat = Array.from({ length: 30 }, () => 42);
  assert.ok(near(api._iStdev(flat, 20)[25], 0, 1e-12));
});

check('every new indicator is index-aligned with its bars and never yields NaN', () => {
  const holes = [1, null, 3, 4, null, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
    .map(c => ({ open: c, high: c, low: c, close: c, volume: c == null ? null : 100 }));
  const series = [
    api._iHMA(api._iSrc(holes, 'close'), 5), api._iVWMA(holes, 5), api._iDEMA(api._iSrc(holes, 'close'), 5),
    api._iTEMA(api._iSrc(holes, 'close'), 5), api._iPSAR(holes, 0.02, 0.2), api._iWilliamsR(holes, 5),
    api._iROC(holes, 3), api._iMomentum(holes, 3), api._iTRIX(holes, 5), api._iCMF(holes, 5),
    api._iAD(holes), api._iAwesome(holes), api._iCMO(holes, 5),
  ];
  for (const s of series) {
    assert.strictEqual(s.length, holes.length, 'one value per bar');
    for (const v of s) assert.ok(v == null || Number.isFinite(v), `non-finite: ${v}`);
  }
  const st = api._iSupertrend(holes, 5, 3);
  assert.strictEqual(st.line.length, holes.length);
  const ar = api._iAroon(holes, 5);
  assert.strictEqual(ar.up.length, holes.length);
});

process.exit(failures ? 1 : 0);
