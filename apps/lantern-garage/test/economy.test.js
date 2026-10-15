'use strict';
/**
 * test/economy.test.js — the US economy page: FRED's official figures, each dated
 * (founder, 2026-10-11: the markets pages for "US stocks, crypto, futures, forex and
 * general economy").
 *
 * Pinned: what FRED needs to answer at all (a User-Agent; one native frequency per
 * request, or it sends a ZIP), that every figure carries the date it is as of, that a
 * change is shown without a verdict, and that the page says what it is not (US only, no
 * release calendar).
 *
 * Run: node --test apps/lantern-garage/test/economy.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const fred = require('../lib/fred');
const E = require('../lib/economy');
const CLS = read('public/market.html');
const HUB = read('public/markets.html');
const UI = read('public/js/market-ui.js');
const MARKET = read('routes/trading/market.js');

function fakeFred(handler) {
  const calls = [];
  const orig = https.get;
  https.get = (url, opts, cb) => {
    const u = new URL(String(url));
    calls.push({ url: u, headers: (opts && opts.headers) || {} });
    const { status = 200, body = '' } = handler(u) || {};
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = {};
      res.setEncoding = () => {};
      cb(res);
      res.emit('data', body);
      res.emit('end');
    });
    return req;
  };
  return { calls, restore() { https.get = orig; } };
}
function csv(ids, rows) { return 'observation_date,' + ids.join(',') + '\n' + rows.map((r) => r.join(',')).join('\n') + '\n'; }

// ── lib/fred ──────────────────────────────────────────────────────────────────────
test('the CSV is read by position, blanks are "no observation", and a wrong shape is refused', () => {
  const out = fred._parseCsv(csv(['CPIAUCSL_PC1', 'UNRATE'], [['2026-07-01', '3.3', '4.1'], ['2026-08-01', '3.35', ''], ['2026-09-01', '.', '4.2']]),
    ['CPIAUCSL', 'UNRATE']);
  assert.deepStrictEqual(out.CPIAUCSL, [['2026-07-01', 3.3], ['2026-08-01', 3.35]], 'a transformed header still maps to its id');
  assert.deepStrictEqual(out.UNRATE, [['2026-07-01', 4.1], ['2026-09-01', 4.2]]);
  assert.strictEqual(fred._parseCsv(csv(['A'], [['2026-01-01', '1']]), ['A', 'B']), null, 'a column short is refused, not misaligned');
  assert.strictEqual(fred._parseCsv('<html>busy</html>', ['A']), null);
  assert.ok(fred._isZip('PK\u0003\u0004README.txt'));
});

test('FRED is asked with a User-Agent — it never answers a request without one', async () => {
  fred._reset();
  const f = fakeFred((u) => ({ body: csv([u.searchParams.get('id')], [['2026-10-08', '3.88']]) }));
  try {
    const out = await fred.series(['DFF'], { since: '2026-09-01' });
    assert.deepStrictEqual(out.DFF, [['2026-10-08', 3.88]]);
    assert.match(f.calls[0].headers['User-Agent'], /^Mozilla\/5\.0 \(compatible; unisona\.ai\/[\d.]+; \+https:\/\/unisona\.ai\)$/);
    assert.strictEqual(f.calls[0].url.hostname, 'fred.stlouisfed.org');
    assert.strictEqual(f.calls[0].url.searchParams.get('cosd'), '2026-09-01');
    await fred.series(['DFF'], { since: '2026-09-01' });
    assert.strictEqual(f.calls.length, 1, 'cached');
  } finally { f.restore(); fred._reset(); }
});

test('a ZIP answer (series of different frequencies) falls back to one request per series', async () => {
  fred._reset();
  const f = fakeFred((u) => {
    const ids = u.searchParams.get('id').split(',');
    if (ids.length > 1) return { body: 'PK\u0003\u0004 README.txt …' };
    return { body: csv(ids, [['2026-10-01', ids[0] === 'ICSA' ? '197000' : '7.28']]) };
  });
  try {
    const out = await fred.series(['ICSA', 'MORTGAGE30US'], { since: '2026-01-01', transforms: ['lin', 'lin'] });
    assert.deepStrictEqual(out, { ICSA: [['2026-10-01', 197000]], MORTGAGE30US: [['2026-10-01', 7.28]] });
    assert.strictEqual(f.calls.length, 3, 'the joint request, then each series');
    assert.strictEqual(f.calls[2].url.searchParams.get('transformation'), 'lin', 'each keeps its transformation');
  } finally { f.restore(); fred._reset(); }
});

// ── lib/economy ───────────────────────────────────────────────────────────────────
test('one request per native frequency, so FRED answers with a CSV and not a ZIP', () => {
  const b = E._batches(Date.UTC(2026, 9, 11));
  const IND = new Map(E._INDICATORS.map((i) => [i.series, i]));
  assert.strictEqual(b.length, 6);
  for (const batch of b) {
    const kinds = new Set(batch.ids.filter((id) => IND.has(id)).map((id) => IND.get(id).freq + (IND.get(id).days7 ? '7' : '')));
    assert.ok(kinds.size <= 1, 'mixed frequencies in one request: ' + batch.ids.join(','));
    if (batch.transforms) assert.strictEqual(batch.transforms.length, batch.ids.length);
  }
  const weekly = b.filter((x) => x.ids.length === 1 && IND.get(x.ids[0]) && IND.get(x.ids[0]).freq === 'w');
  assert.strictEqual(weekly.length, 2, 'claims weeks end on a Saturday, the mortgage survey on a Thursday');
  const fed = b.find((x) => x.ids.includes('DFF'));
  assert.ok(fed.ids.includes('DFEDTARU') && fed.ids.includes('DFEDTARL') && !fed.ids.includes('DGS10'), 'the seven-day Fed series apart');
  const treasury = b.find((x) => x.ids.includes('DGS10'));
  for (const [id] of E._CURVE) assert.ok(treasury.ids.includes(id), 'the curve rides with the Treasury series: ' + id);
});

test('a figure carries its date, the reading it is compared with, and the one a year earlier', () => {
  const months = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 3 + i, 1));
    return [d.toISOString().slice(0, 10), 2 + i / 10];
  });
  const cpi = E._shape(E._INDICATORS.find((i) => i.id === 'cpi'), { CPIAUCSL: months });
  assert.strictEqual(cpi.latest.date, '2026-09-01');
  assert.strictEqual(cpi.prior.date, '2026-08-01', 'a monthly figure is compared with the month before');
  assert.strictEqual(cpi.yearAgo.date, '2025-09-01');
  assert.strictEqual(cpi.href, 'https://fred.stlouisfed.org/series/CPIAUCSL');
  assert.strictEqual(cpi.source, 'Bureau of Labor Statistics');
  // claims arrive in units and are shown in thousands
  const claims = E._shape(E._INDICATORS.find((i) => i.id === 'claims'), { ICSA: [['2026-09-26', 199000], ['2026-10-03', 197000]] });
  assert.strictEqual(claims.latest.value, 197);
  // a daily rate is compared with a month earlier: yesterday's fed funds target is today's
  const days = Array.from({ length: 60 }, (_, i) => [new Date(Date.UTC(2026, 7, 13 + i)).toISOString().slice(0, 10), i < 30 ? 3.75 : 4]);   // raised on Sep 12
  const lower = days.map(([d, v]) => [d, v - 0.25]);
  const t = E._shape(E._INDICATORS.find((i) => i.id === 'fed-target'), { DFEDTARU: days, DFEDTARL: lower });
  assert.deepStrictEqual([t.latest.lower, t.latest.value], [3.75, 4], 'a range keeps both bounds');
  assert.strictEqual(t.prior.date, '2026-09-11');
  assert.deepStrictEqual([t.prior.lower, t.prior.value], [3.5, 3.75], 'and so does the reading it is compared with');
  assert.ok(t.history.length < days.length && t.history[t.history.length - 1][0] === days[days.length - 1][0],
    'a daily series is thinned for its chart, keeping the latest point');
  // nothing returned is shown as nothing — never as a zero
  const none = E._shape(E._INDICATORS.find((i) => i.id === 'gdp'), {});
  assert.strictEqual(none.latest, null);
});

test('the yield curve is drawn on real trading days of the 10-year', () => {
  const data = {};
  const dates = ['2025-10-08', '2026-09-08', '2026-10-07', '2026-10-08'];
  for (const [id] of E._CURVE) data[id] = dates.map((d, i) => [d, 4 + i / 10]);
  const c = E._curveOf(data);
  assert.deepStrictEqual(c.tenors, ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']);
  assert.deepStrictEqual(c.lines.map((l) => [l.label, l.date]),
    [['Latest', '2026-10-08'], ['A month earlier', '2026-09-08'], ['A year earlier', '2025-10-08']]);
  assert.ok(c.lines.every((l) => l.values.length === 11 && l.values.every((v) => typeof v === 'number')));
  assert.strictEqual(E._curveOf({}), null);
});

test('the route serves the economy before the quote boards, and an unknown group is a 404', async () => {
  const hub = MARKET.slice(MARKET.indexOf("'/api/trading/markets' && req.method"), MARKET.indexOf("'/api/trading/markets/series'"));
  assert.ok(hub.indexOf("c === 'economy'") > 0 && hub.indexOf("c === 'economy'") < hub.indexOf('boards.CLASS_IDS.includes(c)'));
  assert.match(hub, /economy\.board\(g\) : await economy\.overview\(\)/);
  assert.strictEqual(await E.board('calendar'), null);
  assert.deepStrictEqual(E.GROUP_IDS, ['inflation', 'jobs', 'growth', 'rates']);
});

// ── The pages ─────────────────────────────────────────────────────────────────────
test('the economy has its place in both navs and a section on the hub', () => {
  assert.ok(CLS.includes('<a href="/market.html?c=economy" data-c="economy">Economy</a>'));
  assert.match(CLS, /var CLASSES = \[[^\]]*'economy'\]/);
  assert.ok(HUB.includes('<a href="/market.html?c=economy">Economy</a>'));
  assert.ok(HUB.includes('See the US economy'));
  assert.match(HUB, /U\.get\('\/api\/trading\/markets\?c=economy'\)/);
});

test('every figure is dated, sourced, and its change is shown without a verdict', () => {
  assert.match(CLS, /'as of ' \+ U\.econDate\(ind, ind\.latest\.date\)/);
  assert.match(CLS, /src\.href = ind\.href;\s*\n\s*src\.target = '_blank';\s*\n\s*src\.rel = 'noopener noreferrer';/);
  // a rise in unemployment is not "green": the arrow is neutral, the tile's class is flat
  assert.match(UI, /el\('div', 'tm flat', econArrow\(ind\)/);
  assert.doesNotMatch(UI.slice(UI.indexOf('Economy figures'), UI.indexOf('global.MarketUI')), /dirCls\(/);
});

test('the page says what it is not: the United States only, and no release calendar', () => {
  assert.match(CLS, /The United States only, and no release calendar/);
  assert.match(CLS, /a calendar of guessed dates would be worse than none/);
  assert.match(CLS, /official US statistics as FRED republishes them/);
});

test('figures read the way their units call for', () => {
  global.window = {};
  try {
    new Function('window', UI)(global.window);
    const U = global.window.MarketUI;
    const ind = (id, unit, dec, freq) => ({ id, unit, dec, freq });
    assert.strictEqual(U.econVal(ind('payrolls', 'K', 0), { value: 29 }), '+29K');
    assert.strictEqual(U.econVal(ind('trade', '$B', 1), { value: -105.572 }), '−$105.6B');
    assert.strictEqual(U.econVal(ind('fed-target', '%', 2), { value: 4, lower: 3.75 }), '3.75–4.00%');
    assert.strictEqual(U.econVal(ind('spread', 'pp', 2), { value: 0.44 }), '+0.44 pp');
    assert.strictEqual(U.econVal(ind('cpi', '% y/y', 1), { value: 3.353 }), '3.4%');
    assert.deepStrictEqual(U.econUnit(ind('cpi', '% y/y', 1)), ['%', 'y/y']);
    assert.strictEqual(U.econDate({ freq: 'q' }, '2026-04-01'), 'Q2 2026');
    assert.strictEqual(U.econDate({ freq: 'm' }, '2026-08-01'), 'Aug 2026');
    assert.strictEqual(U.econDate({ freq: 'd' }, '2026-10-08'), 'Oct 8, 2026');
    // 3.008 against 2.983 both read "3.0%": the comparison carries one more decimal
    const pce = { id: 'core-pce', unit: '% y/y', dec: 1, latest: { value: 3.008 }, prior: { value: 2.983 } };
    assert.strictEqual(U.econCmpDec(pce), 1);
    assert.strictEqual(U.econVal(pce, pce.prior, U.econCmpDec(pce)), '2.98%');
    assert.strictEqual(U.econArrow(pce), '▲');
  } finally { delete global.window; }
});
