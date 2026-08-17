// #3333 — chart indicator maths.
//
// The formulas live inline in public/stock-trader.html (the chart renderer is a
// single self-contained page), so this test EXTRACTS the pure block between the
// `_iNum` helper and the registry comment and evaluates it in isolation. That is
// deliberate: the alternative is trusting a dozen indicators nobody ever checked
// against a reference, which is how a chart quietly lies to a trader.
//
// Reference values are the standard published ones — notably RSI(14) on Wilder's
// own worked example, which must come out at 70.46 / 66.25.
//
// Run: node apps/lantern-garage/test/chart-indicators.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'public', 'stock-trader.html');
const src = fs.readFileSync(PAGE, 'utf8');
const start = src.indexOf('const _iNum =');
const end = src.indexOf('// ── Registry ───');
assert.ok(start > 0 && end > start, 'indicator maths block not found — did the markers move?');

const I = {};
new Function('exports', src.slice(start, end) +
  '\nObject.assign(exports,{_iSMA,_iEMA,_iWMA,_iRSI,_iMACD,_iATR,_iStoch,_iBB,_iOBV,_iCCI,_iMFI,_iADX,_iDonchian,_iKeltner,_iSrc,_iStdev});')(I);

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};
const near = (a, b, tol = 0.01) => assert.ok(a != null && Math.abs(a - b) <= tol, `${a} !~= ${b}`);

// Wilder's published RSI series.
const CLOSE = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,
               46.28,46.00,46.03,46.41,46.22,45.64,46.21,46.25,45.71,46.45,45.78,45.35,44.03,44.18,44.22,44.57];
const BARS = CLOSE.map((c) => ({ open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }));

check('SMA is the plain mean, and the warm-up is null (not zero)', () => {
  const s = I._iSMA(CLOSE, 5);
  near(s[29], CLOSE.slice(25).reduce((a, b) => a + b, 0) / 5, 1e-9);
  assert.strictEqual(s[3], null, 'before the window fills, there is no value');
});

check('RSI(14) matches Wilder\'s published worked example', () => {
  const r = I._iRSI(BARS, 14);
  near(r[14], 70.46, 0.05);
  near(r[15], 66.25, 0.05);
});

check('EMA seeds on the SMA of its first period', () => {
  near(I._iEMA(CLOSE, 10)[9], I._iSMA(CLOSE, 10)[9], 1e-9);
});

check('Bollinger: mid is the SMA and the bands are exactly mult x stdev', () => {
  const bb = I._iBB(BARS, 20, 2), sma = I._iSMA(CLOSE, 20), sd = I._iStdev(CLOSE, 20);
  near(bb.mid[25], sma[25], 1e-9);
  near(bb.upper[25], sma[25] + 2 * sd[25], 1e-9);
  near(bb.lower[25], sma[25] - 2 * sd[25], 1e-9);
});

check('MACD is EMA(fast) - EMA(slow), and the histogram is macd - signal', () => {
  const m = I._iMACD(BARS, 12, 26, 9);
  near(m.macd[28], I._iEMA(CLOSE, 12)[28] - I._iEMA(CLOSE, 26)[28], 1e-9);
  // The histogram needs the SIGNAL line, which is a 9-period EMA *of the MACD* —
  // so it only exists ~34 bars in, past the end of Wilder's 30-bar series. Assert
  // the identity on a series long enough for it to be defined at all.
  const long = Array.from({ length: 80 }, (_, i) => {
    const c = 100 + Math.sin(i / 4) * 5 + i * 0.1;
    return { open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
  });
  const lm = I._iMACD(long, 12, 26, 9);
  assert.ok(lm.hist[70] != null, 'histogram should be defined 70 bars in');
  near(lm.hist[70], lm.macd[70] - lm.signal[70], 1e-9);
  assert.strictEqual(lm.hist[28], null, 'and undefined before the signal line warms up');
});

check('ATR of a constant true range is that range', () => {
  const flat = Array.from({ length: 30 }, () => ({ open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 }));
  near(I._iATR(flat, 14)[20], 1.0, 1e-9);
});

check('Stochastic %K is 100 at the top of its lookback range', () => {
  const rising = Array.from({ length: 20 }, (_, i) => ({ open: i, high: i + 1, low: i - 1, close: i + 1, volume: 1 }));
  near(I._iStoch(rising, 14, 3).k[19], 100, 1e-6);
});

check('OBV accumulates volume signed by the close-to-close direction', () => {
  const b = [{ close: 10, volume: 0 }, { close: 11, volume: 100 }, { close: 10, volume: 40 }, { close: 12, volume: 25 }];
  near(I._iOBV(b)[3], 100 - 40 + 25, 1e-9);
});

check('Donchian channel is the running high/low of the window', () => {
  const d = I._iDonchian(BARS, 5);
  const hi = Math.max(...CLOSE.slice(25).map((c) => c + 0.5));
  const lo = Math.min(...CLOSE.slice(25).map((c) => c - 0.5));
  near(d.upper[29], hi, 1e-9);
  near(d.lower[29], lo, 1e-9);
});

check('bounded oscillators stay inside their band', () => {
  for (const vals of [I._iRSI(BARS, 14), I._iMFI(BARS, 14), I._iADX(BARS, 14).adx, I._iStoch(BARS, 14, 3).k]) {
    for (const v of vals) if (v != null) assert.ok(v >= -0.001 && v <= 100.001, `out of band: ${v}`);
  }
});

check('gaps and junk never produce NaN or throw', () => {
  const holes = [1, null, 3, 4, null, 6, 7, 8, 9, 10, 11, 12]
    .map((c) => ({ open: c, high: c, low: c, close: c, volume: 1 }));
  const every = [
    I._iRSI(holes, 3), I._iATR(holes, 3), I._iCCI(holes, 3), I._iMFI(holes, 3),
    I._iSMA(I._iSrc(holes, 'close'), 3), I._iEMA(I._iSrc(holes, 'close'), 3),
    I._iWMA(I._iSrc(holes, 'close'), 3), I._iADX(holes, 3).adx,
  ];
  for (const series of every) {
    for (const v of series) assert.ok(v == null || Number.isFinite(v), `non-finite value: ${v}`);
  }
  // and an empty series must not explode
  assert.deepStrictEqual(I._iSMA([], 5), []);
});

check('every series is index-aligned with its bars', () => {
  for (const s of [I._iRSI(BARS, 14), I._iATR(BARS, 14), I._iCCI(BARS, 20), I._iSMA(CLOSE, 5)]) {
    assert.strictEqual(s.length, BARS.length, 'one value per bar, so bars[i] pairs with series[i]');
  }
});

process.exit(failures ? 1 : 0);
