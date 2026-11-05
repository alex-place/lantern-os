'use strict';
/**
 * trader-day-split.test.js — the trader page shows the day's banked / marks / after-hours split beside the
 * Day P&L figure (lib/day-pnl-split), and says unknown where the server could not tell.
 *
 * Runs the page's own code in a sandbox, as test/trader-positions-panel.test.js does.
 * Run: node --test apps/lantern-garage/test/trader-day-split.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = process.env.TRADER_PAGE || path.join(__dirname, '..', 'public', 'stock-trader.html');
const src = fs.readFileSync(PAGE, 'utf8').split('\r\n').join('\n');

const fnText = (name) => {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  assert.ok(a > 0, name + ' is on the page');
  const firstLine = src.slice(a, src.indexOf('\n', a));
  if (/\}\s*$/.test(firstLine) && (firstLine.match(/\{/g) || []).length === (firstLine.match(/\}/g) || []).length) return firstLine;
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
};
const start = src.indexOf('/* ── Positions panel (#');
const end = src.indexOf('\n}\n', src.indexOf('function renderPositionsTable(', start)) + 2;
const code = [fnText('fmt'), fnText('_realizedTip'), fnText('_dayPnlTip'), src.slice(start, end)].join('\n');

function load() {
  const els = {}, store = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '' });
  const sb = {
    document: { getElementById: el, addEventListener() {}, createElement: () => ({ setAttribute() {}, style: {}, hidden: true }), body: { appendChild() {} } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console, innerHeight: 900, innerWidth: 1600,
  };
  vm.createContext(sb);
  vm.runInContext(code + '\n;globalThis.__tp = { renderTpSummary, _tpDaySplit };', sb);
  return { tp: sb.__tp, els, store };
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// What the server sends for Wednesday 2026-11-04 at 20:00 ET.
const journal = (name, pnl, exits, status = 'ok') => ({ name, pnl, exits, status });
const WED = {
  session_date: '2026-11-04', is_today: true, phase: 'after_close', day_pnl: -329,
  realized: { total: -154, journals: [journal('Trader', 0, 0), journal('S', 0, 0), journal('M', -608, 8), journal('C', 315, 2), journal('O', 139, 2)] },
  marks: 121, marks_include_after_hours: false, after_hours: -296, after_hours_applies: true,
  close_equity: 98963.84, close_source: 'broker history', notes: [],
};
const ACCT = (day_split) => ({ equity: 98667.84, cash: 39000, buying_power: 90000, unrealized: -45, realized_today: -300, pnl_today: -329, pnl_today_source: 'broker_equity', ...(day_split ? { day_split } : {}) });

test('Wednesday at 20:00: three figures, by sleeve, and the Day P&L figure stays', () => {
  const { tp, els } = load();
  tp.renderTpSummary(ACCT(WED), []);
  const html = els.tpSummary.innerHTML;
  assert.match(html, /<div class="l">Day P&L<\/div><div class="v neg">-\$329\.00<\/div>/, 'the figure itself');
  const split = text(html.slice(html.indexOf('class="tp-split"') - 5));
  assert.match(split, /Banked today -\$154\.00 M -\$608\.00 · C \+\$315\.00 · O \+\$139\.00/);
  assert.match(split, /Marks at close \+\$121\.00/);
  assert.match(split, /After hours -\$296\.00/);
  assert.ok(html.indexOf('tp-split') > html.indexOf('Day P&amp;L') || html.indexOf('tp-split') > html.indexOf('Day P&L'), 'beside the figure, after it');
  assert.doesNotMatch(split, /\bS \+?\$0|Trader/, 'sleeves that closed nothing stay out of the row');
  assert.match(html, /No closed trades: Trader, S\./, 'and are named in its tooltip');
});

test('the figures printed add up to the figure printed', () => {
  const { tp } = load();
  const html = tp._tpDaySplit(ACCT({ ...WED,
    realized: { total: -154.34, journals: [journal('M', -607.99, 8), journal('C', 314.96, 2), journal('O', 138.69, 2)] },
    marks: 121.81, after_hours: -296.37, day_pnl: -328.9 }));
  const numbers = [...html.matchAll(/<span class="n [^"]*">([-+])\$([\d,.]+)<\/span>/g)].map((m) => Number(m[1] + m[2].replace(/,/g, '')));
  assert.deepStrictEqual(numbers, [-154.34, 121.81, -296.37]);
  assert.strictEqual(Math.round(numbers.reduce((a, b) => a + b, 0) * 100) / 100, -328.9);
});

test('before the close there is no after-hours line, and marks are marks on what is open', () => {
  const { tp } = load();
  const html = tp._tpDaySplit(ACCT({ ...WED, phase: 'session', after_hours: null, after_hours_applies: false, marks: 548, close_equity: null, close_source: null }));
  assert.doesNotMatch(html, /After hours/);
  assert.match(text(html), /Open marks \+\$548\.00/);
});

test('a journal the server could not count takes the Realized P&L tile with it, and the Day tooltip\'s sum', () => {
  const { tp, els } = load();
  const missing = { ...WED, realized: { total: null, journals: [journal('M', null, 0, 'missing'), journal('C', 315, 2), journal('O', 139, 2)] }, marks: null };
  tp.renderTpSummary({ ...ACCT(missing), realized_today: 426.24, unrealized_today: -100, pnl_carry_adjustment: 27.41 }, []);
  assert.match(els.tpSummary.innerHTML, /<div class="l">Realized P&L<\/div><div class="v ">unknown<\/div>/, 'not +$426.24 from the journals that were left');
  assert.doesNotMatch(els.tpSummary.innerHTML, /\+\$426\.24/);
  assert.doesNotMatch(els.tpSummary.innerHTML, /\$27\.41/, 'nor a carry figure worked out from them');
  assert.match(els.tpSummary.innerHTML, /<div class="l">Day P&L<\/div><div class="v neg">-\$329\.00<\/div>/, 'the figure itself needs no journal');
  tp.renderTpSummary({ ...ACCT(WED), realized_today: -181.75, unrealized_today: -195.23 }, []);
  assert.match(els.tpSummary.innerHTML, /<div class="l">Realized P&L<\/div><div class="v neg">-\$181\.75<\/div>/, 'all journals counted: the tile as ever');
  assert.match(els.tpSummary.innerHTML, /Today = Realized -\$181\.75/);
});

test('a missing journal shows as unknown, never as $0.00', () => {
  const { tp } = load();
  const html = tp._tpDaySplit(ACCT({ ...WED,
    realized: { total: null, journals: [journal('S', 0, 0), journal('M', null, 0, 'missing'), journal('C', 315, 2), journal('O', 139, 2)] },
    marks: null, notes: ['The M journal could not be read, so its closed trades are unknown.'] }));
  const shown = text(html);
  assert.match(shown, /Banked today unknown M unknown · C \+\$315\.00 · O \+\$139\.00/);
  assert.match(shown, /Marks at close unknown/);
  assert.match(shown, /After hours -\$296\.00/, 'the move since the close needs no journal');
  assert.doesNotMatch(shown, /\$0\.00/);
  assert.match(html, /The M journal could not be read/, 'the tooltip says why');
});

test('a single-journal box shows the total alone, and names the journal when it is the unknown one', () => {
  const { tp } = load();
  assert.match(text(tp._tpDaySplit(ACCT({ ...WED, realized: { total: 500, journals: [journal('Trader', 500, 3)] } }))), /Banked today \+\$500\.00 Marks/);
  assert.match(text(tp._tpDaySplit(ACCT({ ...WED, realized: { total: null, journals: [journal('Trader', null, 0, 'missing')] }, marks: null }))), /Banked today unknown Trader unknown/);
  assert.match(text(tp._tpDaySplit(ACCT({ ...WED, realized: { total: 17069.3, journals: [journal('Trader', 15648.68, 3), journal('O', 1420.62, 2)] } }))),
    /Banked today \+\$17,069\.30 Trader \+\$15,648\.68 · O \+\$1,420\.62/, 'stable on a day its overnight book sold');
});

test('the after-hours figure unknown: the line stays and says so, and marks say what they hold', () => {
  const { tp } = load();
  const shown = text(tp._tpDaySplit(ACCT({ ...WED, marks: -175, marks_include_after_hours: true, after_hours: null, close_equity: null, close_source: null })));
  assert.match(shown, /Marks \+ after hrs -\$175\.00/);
  assert.match(shown, /After hours unknown/);
});

test('after midnight the banked figure names its session', () => {
  const { tp } = load();
  assert.match(text(tp._tpDaySplit(ACCT({ ...WED, is_today: false }))), /Banked 11-04 -\$154\.00/);
  assert.match(text(tp._tpDaySplit(ACCT({ ...WED, is_today: false, phase: 'pre_open', after_hours_applies: false, session_date: '2026-11-09', realized: { total: 0, journals: [journal('M', 0, 0)] }, marks: 12 }))), /Banked today \+\$0\.00/);
});

test('no day_split from the server: the figure alone, exactly as before', () => {
  const { tp, els } = load();
  tp.renderTpSummary(ACCT(null), []);
  assert.doesNotMatch(els.tpSummary.innerHTML, /tp-split/);
  assert.match(els.tpSummary.innerHTML, /-\$329\.00/);
  assert.strictEqual(tp._tpDaySplit(null), '');
});

test('it travels with the Day P&L tile, so saved Columns choices cannot hide it', () => {
  const { tp, els, store } = load();
  store['tp-panel-v1'] = JSON.stringify({ cols: ['qty'], tiles: ['equity', 'day'] });
  tp.renderTpSummary(ACCT(WED), []);
  assert.match(els.tpSummary.innerHTML, /class="tp-split"/, 'saved before this existed');
  store['tp-panel-v1'] = JSON.stringify({ cols: ['qty'], tiles: ['equity'] });
  tp.renderTpSummary(ACCT(WED), []);
  assert.doesNotMatch(els.tpSummary.innerHTML, /tp-split/, 'hide the tile, hide its split');
});

test('what the server sends is text, never markup', () => {
  const { tp } = load();
  const html = tp._tpDaySplit(ACCT({ ...WED,
    realized: { total: null, journals: [journal('<img src=x onerror=alert(1)>', null, 0, 'missing')] },
    notes: ['"><script>alert(1)</script>'], close_source: '"><b>x</b>' }));
  assert.doesNotMatch(html, /<img|<script|<b>/i);
  assert.match(html, /&lt;img src=x/);
});

test('the styles use the page tokens', () => {
  const css = src.slice(src.indexOf('.tp-split{'), src.indexOf('.tp-tabs{'));
  assert.match(css, /var\(--green\)/);
  assert.match(css, /var\(--red\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'no hard-coded colour');
});
