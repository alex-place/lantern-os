'use strict';
/**
 * test/trader-session-tz.test.js — the strip's corner (operator, 2026-09-13).
 *
 * The session button opens a menu (Regular / Extended: two rows, which is what the feed
 * can serve); the clock is a button that opens a timezone menu reaching every zone the
 * browser knows; the VIX and the market state stand beside them as readouts; every button
 * says on hover what it is on; the range buttons read "1 day in 1 minute intervals".
 *
 * Run: node --test apps/lantern-garage/test/trader-session-tz.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public', 'stock-trader.html');
const CS = require('../public/js/chart-settings.js');

const slice = (from, to, after) => { const i = PAGE.indexOf(from, after || 0); assert.ok(i !== -1, 'missing: ' + from); const j = PAGE.indexOf(to, i); assert.ok(j !== -1, 'missing end: ' + to); return PAGE.slice(i, j); };
const strip = slice('<div class="range-strip"', '<!-- Footer -->');
const header = slice('<div class="header" role="region"', '<div class="hgroup"');

// The corner's tables and helpers, evaluated as written (they need only Intl).
const corner = new Function('_cs', '_CS', '_ET', 'document',
  slice('const SESSIONS = [', 'function _etTime(d){') + '; return { SESSIONS, TZ_CITIES, _tzOffsetMin, _tzOffsetLabel, _tzName, _session };')(
  () => 'regular', null, 'America/New_York', { getElementById: () => null });

test('the corner holds four things, in order: VIX, market state, the clock button, the session button', () => {
  const order = ['id="stripVix"', 'id="mktClockWrap"', 'id="tzBtn"', 'id="rangeSess"'].map((id) => strip.indexOf(id));
  assert.ok(order.every((i) => i !== -1), 'a corner piece is missing: ' + order);
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  // The VIX moved down from the header; the market-status loader still finds it by id.
  assert.ok(!header.includes('id="hVix"'), 'the VIX is still in the header');
  assert.strictEqual((PAGE.match(/id="hVix"/g) || []).length, 1);
  assert.match(PAGE, /document\.getElementById\('hVix'\)\.textContent = d\.vix/);
  // The market state and the clock are separate elements, not one pill.
  assert.match(strip, /<div class="hstat range-stat" id="mktClockWrap"[^>]*><div class="l" id="mktClockLabel">Closed<\/div><div class="v" id="mktClock">—<\/div><\/div>/);
  assert.match(strip, /<button type="button" class="range-sess range-tz" id="tzBtn" aria-haspopup="menu" aria-expanded="false" onclick="togglePickMenu\('tz', this\)"/);
  assert.match(strip, /<button type="button" class="range-sess" id="rangeSess" aria-haspopup="menu" aria-expanded="false" onclick="togglePickMenu\('sess', this\)"/);
  assert.ok(!strip.includes('aria-pressed'), 'the session button is a menu, not a toggle');
});

test('the session menu has two rows, the same two the setting has, and the badge says which', () => {
  assert.deepStrictEqual(corner.SESSIONS.map((s) => s.id), CS.FIELDS['data.session'].options.map((o) => o.v));
  assert.deepStrictEqual(corner.SESSIONS.map((s) => s.tag), ['RTH', 'ETH']);
  assert.deepStrictEqual(corner.SESSIONS.map((s) => s.name), ['Regular', 'Extended']);
  for (const s of corner.SESSIONS) assert.match(s.hint, /ET/, s.id + ' hint names no clock');
  assert.strictEqual(corner._session().id, 'regular');
  // Hover says the option it is on.
  assert.match(PAGE, /b\.title = s\.name \+ ' — ' \+ s\.hint \+ '\. Click to change the session\.';/);
  assert.match(PAGE, /b\.setAttribute\('data-session', s\.id\);/);
  assert.match(PAGE, /\.range-sess\[data-session="extended"\]\{color:var\(--accent\)/);
  // The menu rows and the setter behind them.
  assert.match(PAGE, /\} else if\(kind === 'sess'\) \{[\s\S]*?for\(const s of SESSIONS\)\{[\s\S]*?onclick="setSession\(\\'' \+ s\.id \+ '\\'\);_closePickMenu\(\\'sess\\'\)"/);
  assert.match(PAGE, /function setSession\(id\)\{ if\(!_CS \|\| !SESSIONS\.some\(s=> s\.id === id\)\) return; _CS\.set\('data\.session', id\); \}/);
  assert.ok(!PAGE.includes('function toggleSession('), 'the old toggle is still there');
  // The 24-hour row is explained away in the code, not silently absent.
  assert.match(PAGE, /A 24-hour row belongs here the day a feed serves the overnight session/);
});

test('the timezone menu: standing choices, the trading cities with offsets, and a search over every zone', () => {
  const ids = corner.TZ_CITIES.map((c) => c[0]);
  assert.strictEqual(new Set(ids).size, ids.length, 'a city is listed twice');
  for (const id of ids) assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: id }), id + ' is not a zone this runtime knows');
  for (const must of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Australia/Sydney']) assert.ok(ids.includes(must), must + ' missing');
  assert.match(PAGE, /h \+= row\('exchange', 'Exchange \(New York\)', _tzOffsetLabel\(_ET, now\), _ET\);/);
  assert.match(PAGE, /h \+= row\('local', 'Your device', _tzOffsetLabel\(undefined, now\), deviceZone\);/);
  assert.match(PAGE, /h \+= row\('UTC', 'UTC', 'UTC', 'UTC'\);/);
  assert.match(PAGE, /_tzAllCache = Intl\.supportedValuesOf\('timeZone'\);/);
  assert.match(PAGE, /<input class="pick-search" type="search" placeholder="Search every timezone…"/);
  assert.match(PAGE, /onclick="setTimezone\(\\'' \+ _esc\(v\) \+ '\\'\);_closePickMenu\(\\'tz\\'\)"/);
  assert.match(PAGE, /function setTimezone\(z\)\{ if\(!_CS\) return; _CS\.set\('data\.timezone', z\); \}/);
  // Hover says "Timezone" and the zone it is on.
  assert.match(PAGE, /b\.title = 'Timezone — ' \+ _tzName\(z\) \+ '\. Click to change\.';/);
  assert.match(strip, /id="tzBtn"[^>]*\n\s*title="Timezone — Exchange \(New York\)\. Click to change\."/);
  // A zone change repaints the button and the clock at once.
  assert.match(PAGE, /if\(keys\.indexOf\('data\.timezone'\) !== -1\)\{ _renderTzBtn\(\); _tickEtClock\(\); \}/);
  assert.match(PAGE, /applyChartCss\(\); _renderSessBadge\(\); _renderTzBtn\(\); \}/);
});

test('offsets come out the way TradingView prints them', () => {
  const summer = new Date('2026-07-01T12:00:00Z'), winter = new Date('2026-01-15T12:00:00Z');
  assert.strictEqual(corner._tzOffsetLabel('America/New_York', summer), 'UTC-4');
  assert.strictEqual(corner._tzOffsetLabel('America/New_York', winter), 'UTC-5');
  assert.strictEqual(corner._tzOffsetLabel('Asia/Kolkata', summer), 'UTC+5:30');
  assert.strictEqual(corner._tzOffsetLabel('Asia/Tokyo', winter), 'UTC+9');
  assert.strictEqual(corner._tzOffsetLabel('UTC', summer), 'UTC');
  assert.strictEqual(corner._tzOffsetMin('Europe/London', summer), 60);
  assert.strictEqual(corner._tzOffsetMin('Mars/Olympus', summer), null, 'an unknown zone is null, not a throw');
  assert.strictEqual(corner._tzOffsetLabel('Mars/Olympus', summer), '');
  assert.strictEqual(corner._tzName('exchange'), 'Exchange (New York)');
  assert.strictEqual(corner._tzName('local'), 'Your device');
  assert.strictEqual(corner._tzName('Asia/Ho_Chi_Minh'), 'Ho Chi Minh');
  assert.strictEqual(corner._tzName('America/Argentina/Ushuaia'), 'Ushuaia', 'an off-list zone reads as its city');
});

test('the settings key behind the corner accepts any zone the runtime knows, and the dialog shows it', () => {
  assert.strictEqual(CS.FIELDS['data.timezone'].open, 'zone');
  assert.strictEqual(CS.normalise({ 'data.timezone': 'Asia/Kolkata' })['data.timezone'], 'Asia/Kolkata');
  assert.strictEqual(CS.normalise({ 'data.timezone': 'Mars/Olympus' })['data.timezone'], 'exchange');
  assert.strictEqual(CS.normalise({ 'data.timezone': 'local' })['data.timezone'], 'local');
  const src = read('public', 'js', 'chart-settings.js');
  assert.match(src, /if \(f\.open && !f\.options\.some\(\(o\) => o\.v === get\(k\)\)\) \{ const op = h\('option', \{ value: get\(k\) \}/);
  // Only the timezone select is open; every other select is still a closed list.
  assert.deepStrictEqual(CS.KEYS.filter((k) => CS.FIELDS[k].open), ['data.timezone']);
});

test('the range buttons read in words: "1 day in 1 minute intervals"', () => {
  const tables = slice('const RANGES = {', '/* Which span the charts are on');
  const intervals = slice('const INTERVALS = [', 'const _ico =');
  const titles = slice('const RANGE_NAMES = {', '\n}\n', PAGE.indexOf('const RANGE_NAMES = {')) + '\n}';
  const title = new Function(tables + '\n' + intervals + '\n' + titles + '; return _rangeTitle;')();
  assert.strictEqual(title('1D'), '1 day in 1 minute intervals');
  assert.strictEqual(title('5D'), '5 days in 5 minute intervals');
  assert.strictEqual(title('1M'), '1 month in 30 minute intervals');
  assert.strictEqual(title('3M'), '3 months in 1 hour intervals');
  assert.strictEqual(title('6M'), '6 months in 2 hour intervals');
  assert.strictEqual(title('YTD'), 'Year to date in 1 day intervals');
  assert.strictEqual(title('1Y'), '1 year in 1 day intervals');
  assert.strictEqual(title('5Y'), '5 years in 1 week intervals');
  assert.strictEqual(title('All'), 'All available history in 1 month intervals');
  assert.match(PAGE, /title="' \+ _rangeTitle\(k\) \+ '"/, 'the buttons no longer carry the title');
});

test('the one menu builder serves all four menus, and the trigger is remembered rather than guessed by id', () => {
  assert.match(PAGE, /const _PICK_LABELS = \{ tf:'Candle intervals', type:'Chart types', sess:'Trading session', tz:'Timezone', acct:'Account menu' \};/);
  assert.match(PAGE, /m\._btn = btn;/);
  assert.match(PAGE, /if\(m\._btn && m\._btn\.contains\(e\.target\)\) return;/);
  assert.match(PAGE, /if\(m\._btn\) m\._btn\.setAttribute\('aria-expanded','false'\);/);
  assert.ok(!PAGE.includes("kind + 'More'"), 'the builder still guesses the trigger by id');
  // The search box takes focus so a reader can type straight away.
  assert.match(PAGE, /const inp = m\.querySelector\('\.pick-search'\); if\(inp\) setTimeout\(\(\)=> inp\.focus\(\), 0\);/);
});
