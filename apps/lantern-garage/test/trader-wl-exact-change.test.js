'use strict';
/**
 * test/trader-wl-exact-change.test.js — the watchlist's CHG column is the change in dollars,
 * exactly, at the price column's decimals (2026-10-11).
 *
 * The page rebuilt it from the percent, which the feed rounds to two places: SPY's could be
 * off by four cents, and under $100 it printed a third decimal of pure rounding ("+0.093"
 * beside 77.97). The feed already had the previous close it measures from; it now sends it.
 * The real getQuotes runs here against a stubbed https.get, and the page's own _wlAbs.
 *
 * Run: node --test apps/lantern-garage/test/trader-wl-exact-change.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('https');
const { EventEmitter } = require('node:events');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const SRC = PAGE.slice(PAGE.indexOf('function _wlAbs(price, pct, prevClose) {'), PAGE.indexOf('\nfunction renderSymbolInfo(ticker){'));
const _wlAbs = new Function(SRC + '\nreturn _wlAbs;')();

function chartReply(meta) {
  return JSON.stringify({ chart: { result: [{ meta, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
}

test('the feed sends the previous close its percent is measured from', async () => {
  const real = https.get;
  https.get = (url, opts, cb) => {
    const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
    process.nextTick(() => {
      cb(res);
      res.emit('data', chartReply({ regularMarketPrice: 77.97, chartPreviousClose: 77.88 }));
      res.emit('end');
    });
    return req;
  };
  try {
    const yahoo = require('../lib/market-data-yahoo');
    const [q] = await yahoo.getQuotes(['TLT'], { fresh: true });
    assert.strictEqual(q.price, 77.97);
    assert.strictEqual(q.prev_close, 77.88);
    assert.strictEqual(q.chg_pct, 0.12, 'the percent is unchanged');
  } finally { https.get = real; }
});

test('the column is the exact change, at the price\'s decimals', () => {
  assert.ok(SRC.length > 200, '_wlAbs found');
  assert.strictEqual(_wlAbs(77.97, 0.12, 77.88), '+0.09', 'was "+0.093", rebuilt from a rounded 0.12%');
  assert.strictEqual(_wlAbs(778.57, 0.6, 773.92), '+4.65', 'rebuilt from 0.6% it read +4.64');
  assert.strictEqual(_wlAbs(23.37, -1.7, 23.774), '-0.40');
  assert.strictEqual(_wlAbs(0.5123, 2.1, 0.5018), '+0.0105', 'under $1, four places, as the price shows');
});

test('a row without a previous close still gets the estimate, without the false third decimal', () => {
  assert.strictEqual(_wlAbs(77.97, 0.12), '+0.09');
  assert.strictEqual(_wlAbs(77.97, 0.12, null), '+0.09');
  assert.strictEqual(_wlAbs(null, 0.12), '—');
  assert.strictEqual(_wlAbs(50, null), '—');
  assert.match(PAGE, /<span class="wl-abs \$\{cl\}">\$\{_wlAbs\(t\.price, t\.chg_pct, t\.prev_close\)\}<\/span>/);
});

test('the percent is always two places, wherever the page prints it', () => {
  const src = PAGE.slice(PAGE.indexOf('function _pct2(v){'), PAGE.indexOf('\n', PAGE.indexOf('function _pct2(v){')));
  const _pct2 = new Function(src + '\nreturn _pct2;')();
  assert.strictEqual(_pct2(0.6), '0.60', 'was "+0.6%" over "+0.51%"');
  assert.strictEqual(_pct2(-1.7), '-1.70');
  assert.strictEqual(_pct2(0.51), '0.51');
  assert.match(PAGE, /<span class="wl-chg \$\{cl\}">\$\{t\.chg_pct>=0\?'\+':''\}\$\{_pct2\(t\.chg_pct\)\}%<\/span>/, 'the watchlist row');
  assert.match(PAGE, /<span class="wl-chg \$\{cl\}">\$\{chg>=0\?'\+':''\}\$\{_pct2\(chg\)\}%<\/span>/, 'the details panel');
  assert.match(PAGE, /el\.textContent = \(chg>0\?'▲ \+':chg<0\?'▼ ':'· '\)\+_pct2\(chg\)\+'%';/, 'the chart card');
  assert.match(PAGE, /\$\{chg>=0\?'\+':''\}\$\{_pct2\(chg\)\}%<\/span>`\}`/, 'the ticket header');
});

test('the chart\'s previous-close line is the feed\'s previous close', () => {
  const block = PAGE.slice(PAGE.indexOf("if(_cs('scales.prevClose') === true"), PAGE.indexOf("// Alerts › alert lines"));
  assert.match(block, /const sent = wl \? Number\(wl\.prev_close\) : NaN;/);
  assert.match(block, /const pc = sent > 0 \? sent : Number\(wl\.price\) \/ \(1 \+ chg\/100\);/);
});
