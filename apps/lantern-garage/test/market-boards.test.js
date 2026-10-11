'use strict';
/**
 * test/market-boards.test.js — the market pages: a hub, one page per asset class, each
 * class's boards, and a symbol page for every instrument on them (founder, 2026-10-11:
 * "market summary > see major indices > see all crypto … have links that lead to their
 * own pages … for US stocks, crypto, futures, forex").
 *
 * What is pinned is what the pages CLAIM and what they COST:
 *   - a board is one batch request to Yahoo, not a chart call per row — this host shares
 *     Yahoo's patience with the armed trader's quote path;
 *   - the module shares no state with that path (lib/market-data-yahoo);
 *   - a symbol not on a board is refused before anything is fetched;
 *   - every figure that can be misread is labelled: corn in cents, a derived cross rate,
 *     sixteen coins that are not "the crypto market", a curated list that is not the exchange.
 *
 * Run: node --test apps/lantern-garage/test/market-boards.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const B = require('../lib/market-boards');
const { UNIVERSE, kindOf, LEVERAGED } = require('../lib/market-universe');

const LIB = read('lib/market-boards.js');
const MARKET = read('routes/trading/market.js');
const SERVER = read('server.js');
const PAGES = read('routes/pages.js');
const REG = read('lib/surface-registry.js');
const HUB = read('public/markets.html');
const CLS = read('public/market.html');
const SYM = read('public/symbol.html');
const UI = read('public/js/market-ui.js');
const HOME = read('public/index.html');

// ── A fake Yahoo, so the cost of a board can be counted ─────────────────────────────
function fakeYahoo(handler) {
  const calls = [];
  const orig = https.get;
  https.get = (url, opts, cb) => {
    const u = String(url);
    calls.push({ url: u, headers: (opts && opts.headers) || {} });
    const { status = 200, body = '', headers = {} } = handler(u) || {};
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = headers;
      res.setEncoding = () => {};
      cb(res);
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    return req;
  };
  return { calls, restore() { https.get = orig; } };
}
function v7Row(sym, price, extra) {
  return { symbol: sym, regularMarketPrice: price, regularMarketChange: 1, regularMarketChangePercent: 0.5,
           fiftyDayAverage: price * 0.9, twoHundredDayAverage: price * 1.1, priceHint: 2, ...(extra || {}) };
}
function yahooHandler(u) {
  if (u.startsWith('https://fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['A3=x; Path=/'] } };
  if (u.includes('/v1/test/getcrumb')) return { body: 'crumb123' };
  if (u.includes('/v7/finance/quote')) {
    const syms = decodeURIComponent(u.match(/symbols=([^&]+)/)[1]).split(',');
    return { body: { quoteResponse: { result: syms.map((s, i) => v7Row(s, 100 + i)) } } };
  }
  if (u.includes('/v8/finance/spark')) {
    const syms = decodeURIComponent(u.match(/symbols=([^&]+)/)[1]).split(',');
    const t0 = Math.floor(Date.now() / 1000) - 700 * 86400;
    const ts = Array.from({ length: 700 }, (_, i) => t0 + i * 86400);
    const body = {};
    for (const sym of syms) body[sym] = { symbol: sym, timestamp: ts, close: ts.map((_, i) => 100 + i * 0.1) };
    return { body };
  }
  if (u.includes('/v8/finance/chart/')) {
    const t0 = Math.floor(Date.now() / 1000) - 400 * 86400;
    const ts = Array.from({ length: 300 }, (_, i) => t0 + i * 86400);
    return { body: { chart: { result: [{ meta: { regularMarketPrice: 120, chartPreviousClose: 100 },
      timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => 100 + i * 0.1) }] } }] } } };
  }
  return { status: 404 };
}

// ── The boards themselves ────────────────────────────────────────────────────────────
test('every instrument is listed once, under one class, in a shape the symbol page admits', () => {
  const C = B._CLASSES;
  const seen = new Map();
  for (const [cid, cls] of Object.entries(C)) {
    assert.ok(cls.title && cls.blurb && cls.lead, cid + ' needs a title, a blurb and a lead');
    assert.ok(B.isListed(cls.lead), cid + ' lead is not on a board');
    for (const s of [].concat(cls.summary || [], cls.hub || [])) assert.ok(B.isListed(s), cid + ': ' + s + ' is not listed');
    for (const g of cls.groups) {
      assert.ok(g.rows.length > 0, cid + '/' + g.id + ' is empty');
      for (const [sym, name, short] of g.rows) {
        assert.ok(name && short, sym + ' needs a name and a code');
        // The symbol page's allowlist: [A-Z0-9.-^=], at most 12 characters.
        assert.match(sym, /^[A-Z0-9.\-^=]{1,12}$/, sym + ' would be refused by the symbol page');
        assert.ok(!seen.has(sym), sym + ' is listed twice (' + seen.get(sym) + ', ' + cid + ')');
        seen.set(sym, cid);
      }
    }
  }
  assert.ok(seen.size >= 60, 'the boards are real lists, not a handful of tiles');
  assert.deepStrictEqual(B.CLASS_IDS.sort(), ['crypto', 'forex', 'futures', 'indices', 'stocks']);
});

test('a future priced in cents says so — corn at "479.75" is not $479.75', () => {
  const fut = B._CLASSES.futures.groups;
  for (const g of fut) for (const [sym, , , unit] of g.rows) assert.ok(unit, sym + ' has no unit');
  const unitOf = new Map([].concat(...fut.map((g) => g.rows)).map((r) => [r[0], r[3]]));
  for (const s of ['ZC=F', 'ZW=F', 'ZS=F', 'KC=F', 'SB=F', 'CT=F', 'LE=F', 'HE=F']) {
    assert.match(unitOf.get(s), /^US¢\//, s + ' is quoted in US cents');
  }
  assert.match(unitOf.get('CL=F'), /^USD\//);
  assert.match(UI, /if \(r\.unit\) p\.appendChild\(el\('span', 'tu', r\.unit\)\)/, 'the tile prints the unit');
});

test('a quote field Yahoo reports as 0 reads as missing, and a row without a price is dropped', () => {
  const r = B._fromV7({ symbol: '^TNX', regularMarketPrice: 5.244, regularMarketDayHigh: 0, regularMarketDayLow: 0,
    fiftyTwoWeekLow: 0, fiftyTwoWeekHigh: 5.364, regularMarketChangePercent: 0.25 });
  assert.strictEqual(r.high, null);
  assert.strictEqual(r.low, null);
  assert.strictEqual(r.w52_low, null, "^TNX's 52-week low of 0 is not a yield of zero");
  assert.strictEqual(r.w52_high, 5.364);
  assert.strictEqual(B._fromV7({ symbol: 'SQ' }), null, 'a symbol Yahoo no longer prices is not a blank row');
  assert.strictEqual(B._fromV7({ symbol: 'X', regularMarketPrice: 0 }), null);
});

test('performance is measured over CALENDAR windows from the last close at or before each start', () => {
  const day = 86400e3;
  const now = Date.UTC(2026, 9, 11, 12);
  // a close of 100 every day for 400 days, except the last six, which are 110 — so the
  // close exactly a week back (at or before now - 7d) is still 100
  const pts = Array.from({ length: 400 }, (_, i) => [now - (400 - i) * day, i >= 394 ? 110 : 100]);
  const p = B._perfFrom(pts, 121, now);
  assert.strictEqual(p.w1, 21, 'a week ago the close was 100');
  assert.strictEqual(p.m1, 21);
  assert.strictEqual(p.ytd, 21, 'YTD runs from the last close of the previous year');
  assert.strictEqual(p.y1, 21);
  // a history that does not reach back a year has no 1Y figure — never a made-up one
  const short = pts.slice(-100);
  assert.strictEqual(B._perfFrom(short, 121, now).y1, null);
  assert.deepStrictEqual(B._perfFrom([], 121, now), { w1: null, m1: null, m3: null, m6: null, ytd: null, y1: null });
});

test('cross rates are derived consistently from each currency against the dollar', () => {
  const q = new Map([['EURUSD=X', { chg_pct: 1 }], ['JPY=X', { chg_pct: 1 }], ['GBPUSD=X', { chg_pct: 0 }],
    ['AUDUSD=X', { chg_pct: 0 }], ['NZDUSD=X', { chg_pct: 0 }], ['CHF=X', { chg_pct: 0 }], ['CAD=X', { chg_pct: 0 }]]);
  const x = B._crossRates(q);
  const cell = (b, c) => x.cells.find((k) => k.base === b && k.quote === c).chg_pct;
  assert.strictEqual(cell('EUR', 'USD'), 1);
  assert.strictEqual(cell('USD', 'JPY'), 1, 'USD/JPY is quoted as yen per dollar, so JPY=X up is the dollar up');
  assert.strictEqual(cell('EUR', 'JPY'), 2.01, 'the euro up 1% and the yen down 1% against the dollar');
  assert.strictEqual(cell('JPY', 'EUR'), -1.97, 'and the reciprocal is the reciprocal, not the negative');
  assert.strictEqual(x.cells.length, 8 * 7);
  // A missing leg leaves its cells empty rather than guessed
  const partial = B._crossRates(new Map([['EURUSD=X', { chg_pct: 1 }]]));
  assert.strictEqual(partial.cells.find((k) => k.base === 'GBP' && k.quote === 'EUR').chg_pct, null);
  assert.match(CLS, /Derived, not quoted/, 'and the page says it is derived');
});

test('breadth counts what it was handed; "most active" ranks by dollars traded', () => {
  const rows = [
    { symbol: 'A', price: 10, chg_pct: 1, volume: 1e6, avg50: 9, avg200: 11 },
    { symbol: 'B', price: 500, chg_pct: -2, volume: 1e5, avg50: 400, avg200: 450 },
    { symbol: 'C', price: 50, chg_pct: 0, volume: 0, avg50: null, avg200: null },
  ];
  const b = B._breadthOf(rows);
  assert.deepStrictEqual([b.n, b.adv, b.dec, b.unch, b.n50, b.above50, b.n200, b.above200], [3, 1, 1, 1, 2, 100, 2, 50]);
  assert.deepStrictEqual(B._rank(rows, 0, 'regular').map((r) => r.symbol), ['B', 'A'], '$50M beats $10M; no volume, no rank');
  const ext = [{ symbol: 'P', chg_pct: 1, pre: { chg_pct: -3 } }, { symbol: 'Q', chg_pct: -1, pre: { chg_pct: 2 } }];
  assert.deepStrictEqual(B._rank(ext, 1, 'pre').map((r) => r.symbol), ['Q'], 'pre-market gainers rank on the pre-market move');
  assert.deepStrictEqual(B._rank(ext, 1, 'regular').map((r) => r.symbol), ['P']);
});

// ── What it costs, and what it shares ───────────────────────────────────────────────
test('a board costs ONE batch request, and a second look within the TTL costs none', async () => {
  B._reset();
  const y = fakeYahoo(yahooHandler);
  try {
    const out = await B.board('futures', 'agricultural', {});
    assert.strictEqual(out.rows.length, 9);
    const quoteCalls = y.calls.filter((c) => c.url.includes('/v7/finance/quote'));
    assert.strictEqual(quoteCalls.length, 1, 'nine rows, one request');
    assert.strictEqual(y.calls.filter((c) => c.url.includes('/v8/finance/chart/')).length, 0, 'no chart call per row');
    const before = y.calls.length;
    await B.board('futures', 'agricultural', {});
    assert.strictEqual(y.calls.length, before, 'cached');
    // The Performance view adds ONE history batch — Yahoo's spark, up to twenty symbols.
    const perf = await B.board('futures', 'agricultural', { view: 'perf' });
    assert.strictEqual(y.calls.filter((c) => c.url.includes('/v8/finance/spark')).length, 1);
    assert.ok(perf.rows.every((r) => r.perf && r.perf.m1 != null), 'every row got its windows');
    // The US-stock boards: 119 names in three requests of at most fifty — the movers route
    // they replaced priced them one chart call at a time.
    B._reset();
    y.calls.length = 0;
    const st = await B.board('stocks', 'all', { view: 'perf' });
    assert.strictEqual(st.universe, UNIVERSE.length);
    assert.strictEqual(y.calls.filter((c) => c.url.includes('/v7/finance/quote')).length, Math.ceil(UNIVERSE.length / 50));
    const sparks = y.calls.filter((c) => c.url.includes('/v8/finance/spark'));
    assert.strictEqual(sparks.length, Math.ceil(UNIVERSE.length / 20), 'six history batches, not 119 chart calls');
    for (const c of sparks) {
      assert.ok(decodeURIComponent(c.url.match(/symbols=([^&]+)/)[1]).split(',').length <= 20, 'Yahoo refuses past twenty');
    }
    assert.strictEqual(y.calls.filter((c) => c.url.includes('/v8/finance/chart/')).length, 0);
  } finally { y.restore(); B._reset(); }
});

test('it names itself to Yahoo as unisona.ai', async () => {
  B._reset();
  const y = fakeYahoo(yahooHandler);
  try {
    await B.board('forex', 'index', {});
    for (const c of y.calls) assert.match(c.headers['User-Agent'], /unisona\.ai/, c.url);
    assert.match(B._UA, /^Mozilla\/5\.0 \(compatible; unisona\.ai\/[\d.]+; \+https:\/\/unisona\.ai\)$/);
  } finally { y.restore(); B._reset(); }
});

test('a 1D chart is measured from the previous close, like every "today" beside it', async () => {
  B._reset();
  const y = fakeYahoo(yahooHandler);
  try {
    const s = await B.series('^GSPC', '1D');
    // The QUOTE's previous close (price 100, change 1), not the chart's own (100): for a
    // coin the two endpoints disagree, and Bitcoin's chart read +0.82% beside +0.69%.
    assert.strictEqual(s.base, 99);
    assert.deepStrictEqual(s.last, { price: 100, chg_pct: 0.5 }, "the quote's own figures ride along");
    assert.ok(s.points.length >= 24);
    const m = await B.series('^GSPC', '1M');
    assert.strictEqual(m.base, null, 'a longer window is measured from its own first point');
    assert.strictEqual(await B.series('^GSPC', '7Y'), null);
  } finally { y.restore(); B._reset(); }
  assert.match(UI, /areaChart\(pts, \{ label: lead\.name, base: d\.base \}\)/, 'the lead chart draws the base');
  assert.match(UI, /r === '1D' && d\.base \? 'today' : r/);
  assert.match(UI, /if \(r === '1D' && d\.last && isNum\(d\.last\.price\)\) \{ b = Number\(d\.last\.price\); ch = d\.last\.chg_pct; \}/,
    "and prints the quote's change, not a recomputed one");
});

test('the module shares no state with the armed trader’s quote path', () => {
  // Its cache is bounded at 200 entries; a hundred board symbols written into it would
  // evict the trader's own bars. The ONE thing borrowed is a pure function, for a link.
  const requires = LIB.match(/require\('\.\/market-data-yahoo'\)[^;]*/g) || [];
  assert.strictEqual(requires.length, 1);
  assert.match(requires[0], /\.isCrypto\(/);
  assert.doesNotMatch(LIB, /getQuotes|getBars|getSymbolStats|cacheSet/);
  assert.match(LIB, /const _quotes = new Map\(\)/, 'its own cache');
});

test('a symbol not on a board is refused before anything is fetched', () => {
  const route = MARKET.slice(MARKET.indexOf("'/api/trading/markets/series'"), MARKET.indexOf("'/api/trading/symbol-stats'"));
  assert.ok(route.indexOf('isListed(s)') > 0 && route.indexOf('isListed(s)') < route.indexOf('boards.series('), 'checked first');
  assert.match(route, /not_listed/);
  assert.strictEqual(B.isListed('AAPL'), false, 'stocks keep their own endpoints');
  assert.strictEqual(B.isListed('../etc/passwd'), false);
  const hub = MARKET.slice(MARKET.indexOf("'/api/trading/markets' && req.method"), MARKET.indexOf("'/api/trading/markets/series'"));
  assert.match(hub, /boards\.CLASS_IDS\.includes\(c\)/, 'an unknown class is a 404, never a fetch');
});

test('the endpoints are PUBLIC reads that publish only market data', () => {
  const reads = SERVER.slice(SERVER.indexOf('const PUBLIC_TRADING_READS'), SERVER.indexOf('function tradeApiGuard'));
  for (const p of ['/api/trading/markets', '/api/trading/markets/series', '/api/trading/markets/instrument']) {
    assert.ok(reads.includes('"' + p + '"'), p + ' must be public: the pages are');
  }
  assert.match(reads, /deliberately absent: \/api\/trading\/track-record/, 'the ledger stays unpublished');
  // The movers route is gone, not left behind as a second way to price the universe.
  assert.ok(!reads.includes('"/api/trading/movers"'));
  assert.doesNotMatch(MARKET, /pathname === '\/api\/trading\/movers'/);
  const present = LIB.slice(LIB.indexOf('function present('), LIB.indexOf('function classOf('));
  for (const leak of ['position', 'equity', 'pnl', 'account', 'ledger']) {
    assert.ok(!new RegExp('\\b' + leak + '\\b').test(present), 'a board row must not carry ' + leak);
  }
});

// ── The pages ───────────────────────────────────────────────────────────────────────
test('the hub leads to a page per class, and each class page to its boards', () => {
  for (const c of ['indices', 'stocks', 'crypto', 'futures', 'forex']) {
    assert.ok(HUB.includes('href="/market.html?c=' + c + '"'), 'the hub links ' + c);
    assert.ok(CLS.includes('data-c="' + c + '"'), 'the class switcher lists ' + c);
  }
  for (const see of ['See all US stocks', 'See all coins', 'See all futures', 'See all major pairs']) assert.ok(HUB.includes(see), see);
  assert.match(HUB, /all\.textContent|'See all indices'/);
  assert.match(CLS, /seeAll\(s\.sec, 'See all ' \+ g\.title/, 'every group of a class has its "See all"');
  assert.match(CLS, /section\(g\.title, href\(C, g\.id\)/, 'and its heading leads to the board');
  assert.match(HOME, /<a href="\/markets\.html">\s*\n\s*<h2 id="mkt-h">Markets<\/h2>/, 'the home page’s Markets heading leads to the hub');
  // Nothing on a market page leads to the trader except a coin the terminal can trade.
  for (const page of [HUB, CLS]) assert.doesNotMatch(page, /href="\/stock-trader\.html/);
});

test('the pages say what their lists are — curated, not the exchange, not the whole crypto market', () => {
  assert.match(CLS, /not the whole exchange/);
  assert.match(CLS, /there is no screener behind this/);
  assert.match(CLS, /That is these coins, not the whole crypto market/);
  assert.match(HUB, /not every index,\s*coin, contract or pair, and not a screener/);
  assert.match(CLS, /grains, softs and livestock are quoted in US cents/);
});

test('a leveraged fund is labelled "leveraged" — not "3x", which UCO, NUGT and JNUG are not', () => {
  for (const s of LEVERAGED) assert.strictEqual(kindOf(s), 'leveraged', s);
  assert.strictEqual(kindOf('GDX'), 'etf', 'the unleveraged gold-miners fund is an ordinary ETF');
  assert.strictEqual(kindOf('AAPL'), 'stock');
  assert.ok(!UNIVERSE.includes('SQ') && UNIVERSE.includes('XYZ'), 'Block trades as XYZ; SQ no longer prices');
  for (const page of [HUB, CLS]) {
    assert.match(page, /el\('span', 'chip', 'leveraged'\)/);
    assert.doesNotMatch(page, /'chip', '3x'/);
  }
});

test('a coin priced in millionths keeps its digits', () => {
  global.window = {};
  try {
    new Function('window', UI)(global.window);   // the browser module, evaluated as-is
    const U = global.window.MarketUI;
    assert.strictEqual(U.price({ price: 0.00000547, hint: 5 }), '0.000005470', 'SHIB printed as 0.00001 with its hint alone');
    assert.strictEqual(U.price({ price: 1.1197, hint: 4 }), '1.1197');
    assert.strictEqual(U.trend({ price: 10, avg50: 9, avg200: 8 }).text, 'Above 50d · 200d');
    assert.strictEqual(U.trend({ price: 10, avg50: null, avg200: 8 }), null, 'no averages, no read');
  } finally { delete global.window; }
});

test('the symbol page serves a board instrument without running the stock half', () => {
  const branch = SYM.indexOf("if (/[\\^=]/.test(T) || /-USD$/.test(T) || /\\.SS$/.test(T))");
  assert.ok(branch > 0, 'recognised by shape');
  assert.ok(branch < SYM.indexOf("document.title = T + ' — Unisona';\n  byId('sTicker')"), 'and decided before the stock code');
  assert.match(SYM.slice(branch, branch + 200), /renderInstrument\(\);\s*\n\s*return;/);
  assert.match(SYM, /\/api\/trading\/markets\/instrument\?s=/);
  // style.display, because .cta sets display:inline-flex and beats the [hidden] attribute.
  assert.match(SYM, /trade\.style\.display = 'none'/);
  assert.doesNotMatch(SYM.slice(branch), /\.hidden = true/);
  assert.match(SYM, /id="sBack" href="\/markets\.html"/, 'its back link leads to the markets, as it says');
});

test('both pages are registered public and classified', () => {
  assert.match(PAGES, /"\/markets\.html":\s*"markets\.html"/);
  assert.match(PAGES, /"\/market\.html":\s*"market\.html"/);
  assert.match(REG, /"markets\.html":\s*"Observe"/);
  assert.match(REG, /"market\.html":\s*"Observe"/);
  for (const page of [HUB, CLS]) {
    assert.match(page, /<meta name="loop-stage" content="observe">/);
    assert.match(page, /<script src="\/js\/market-ui\.js"><\/script>/);
  }
});

test('nothing reaches the DOM as markup', () => {
  for (const [name, src] of [['markets.html', HUB], ['market.html', CLS], ['market-ui.js', UI]]) {
    const writes = src.match(/innerHTML\s*=\s*[^;]+/g) || [];
    for (const w of writes) assert.match(w, /innerHTML\s*=\s*''\s*$/, name + ' computed innerHTML: ' + w);
  }
});
