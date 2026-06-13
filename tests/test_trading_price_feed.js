'use strict';

const assert = require('assert');
const path   = require('path');

const { TradingPriceFeed, simulateBars } =
  require(path.join(__dirname, '../apps/lantern-garage/lib/trader-price-feed'));

let passed = 0;
let failed = 0;
const asyncTests = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function asyncTest(name, fn) {
  asyncTests.push({ name, fn });
}

// ── simulateBars ──────────────────────────────────────────────────────────────
console.log('\nsimulatesBars');

test('returns array for 1D', () => {
  const bars = simulateBars('AAPL', '1D');
  assert.ok(Array.isArray(bars) && bars.length > 0);
});

test('each bar has required OHLCV keys', () => {
  const b = simulateBars('SPY', '1D')[0];
  ['ts','open','high','low','close','volume'].forEach(k => {
    assert.ok(typeof b[k] === 'number', `${k} should be number`);
  });
});

test('OHLCV integrity: high >= max(open,close)', () => {
  for (const b of simulateBars('TSLA', '5D')) {
    assert.ok(b.high >= Math.max(b.open, b.close) - 0.01);
    assert.ok(b.low  <= Math.min(b.open, b.close) + 0.01);
  }
});

test('prices and volumes are positive', () => {
  for (const b of simulateBars('NVDA', '1M')) {
    assert.ok(b.close > 0 && b.volume > 0);
  }
});

test('timestamps are ascending', () => {
  const bars = simulateBars('MSFT', '1D');
  for (let i = 1; i < bars.length; i++)
    assert.ok(bars[i].ts > bars[i-1].ts);
});

test('deterministic within same day', () => {
  const a = simulateBars('AAPL', '1D');
  const b = simulateBars('AAPL', '1D');
  assert.strictEqual(a[0].close, b[0].close);
});

test('different symbols produce different prices', () => {
  assert.notStrictEqual(simulateBars('AAPL','1D')[0].close,
                        simulateBars('TSLA','1D')[0].close);
});

test('unknown symbol gets positive fallback price', () => {
  const bars = simulateBars('ZZZZ', '1D');
  assert.ok(bars.length > 0 && bars[0].open > 0);
});

// ── TradingPriceFeed ──────────────────────────────────────────────────────────
console.log('\nTradingPriceFeed.getTicks');

asyncTest('returns expected shape for AAPL 1D', async () => {
  const feed = new TradingPriceFeed();
  const data = await feed.getTicks('AAPL', '1D');
  assert.strictEqual(data.symbol, 'AAPL');
  assert.strictEqual(data.range, '1D');
  assert.ok(Array.isArray(data.ticks) && data.ticks.length > 0);
  assert.ok(typeof data.current_price === 'number');
  assert.ok(typeof data.open_price    === 'number');
  assert.ok(typeof data.generated_at  === 'string');
});

asyncTest('source is simulated when no traderAgent', async () => {
  const data = await new TradingPriceFeed(null).getTicks('SPY', '1D');
  assert.strictEqual(data.source, 'simulated');
});

asyncTest('symbol is uppercased', async () => {
  const data = await new TradingPriceFeed().getTicks('aapl', '1D');
  assert.strictEqual(data.symbol, 'AAPL');
});

asyncTest('caching: second call returns same object', async () => {
  const feed = new TradingPriceFeed();
  const a = await feed.getTicks('TSLA', '1D');
  const b = await feed.getTicks('TSLA', '1D');
  assert.strictEqual(a, b);
});

asyncTest('clearCache forces fresh generation', async () => {
  const feed = new TradingPriceFeed();
  const a = await feed.getTicks('MSFT', '1D');
  feed.clearCache();
  const b = await feed.getTicks('MSFT', '1D');
  assert.notStrictEqual(a, b);
});

asyncTest('different ranges produce different tick counts', async () => {
  const feed = new TradingPriceFeed();
  const [d1, d5, dm] = await Promise.all([
    feed.getTicks('SPY', '1D'),
    feed.getTicks('SPY', '5D'),
    feed.getTicks('SPY', '1M'),
  ]);
  assert.notStrictEqual(d1.ticks.length, d5.ticks.length);
  assert.notStrictEqual(d5.ticks.length, dm.ticks.length);
});

// ── getWatchlistTicks ─────────────────────────────────────────────────────────
console.log('\nTradingPriceFeed.getWatchlistTicks');

asyncTest('returns one entry per symbol', async () => {
  const res = await new TradingPriceFeed().getWatchlistTicks(['SPY','AAPL','TSLA'], '1D');
  assert.strictEqual(res.length, 3);
  const syms = res.map(d => d.symbol);
  assert.ok(syms.includes('SPY') && syms.includes('AAPL') && syms.includes('TSLA'));
});

asyncTest('empty watchlist returns empty array', async () => {
  const res = await new TradingPriceFeed().getWatchlistTicks([], '1D');
  assert.deepStrictEqual(res, []);
});

asyncTest('each result has required keys', async () => {
  const [d] = await new TradingPriceFeed().getWatchlistTicks(['NVDA'], '5D');
  assert.ok(d.symbol && d.range && d.ticks && d.source && d.generated_at);
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
