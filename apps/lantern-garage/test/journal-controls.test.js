'use strict';
/**
 * test/journal-controls.test.js — #3541, #3542.
 *
 * The journal must sit still. It used to refetch on focus, on visibilitychange and on a
 * two-minute timer, and every control repainted the whole page — switching tabs or
 * clicking a chip threw the reader's place away. Now: it loads when opened or asked, and
 * a control repaints only its own card. Declined and the Exit reason slice are gone.
 *
 * The page's REAL functions are extracted and driven against a fake document, so this
 * fails if the page regresses, rather than mirroring it.
 * Run: node --test apps/lantern-garage/test/journal-controls.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');
const code = src.slice(src.indexOf('<script>'));      // the page's own script, not its prose

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
  assert.ok(i >= 0, 'function not found: ' + name);
  let depth = 0, started = false;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};

test('the page never reloads itself: no focus, visibility or timer refresh', () => {
  assert.doesNotMatch(code, /addEventListener\('visibilitychange'/, 'no visibility refresh');
  assert.doesNotMatch(code, /window\.addEventListener\('focus'/, 'no focus refresh');
  assert.doesNotMatch(code, /setInterval\(/, 'no background timer');
  assert.strictEqual((code.match(/addEventListener\('DOMContentLoaded'/g) || []).length, 1, 'one load, when the page opens');
  assert.match(code, /document\.addEventListener\('DOMContentLoaded', \(\) => jpLoad\(\)\);/);
  assert.match(code, /id="jpLoadedAt"/, 'the header says when it last read the record');
});

test('Declined and Exit reason are gone, and Symbol is what opens', () => {
  for (const gone of ['jpSkips', 'jpSetView', '/api/trading/skips', 'jpViewSkips']) {
    assert.strictEqual(code.includes(gone), false, gone + ' is gone');
  }
  assert.match(code, /const JP_LABELS = \{ symbol:'Symbol', hour:'Hour' \};/);
  assert.match(code, /let jpSlice = 'symbol'/);
  assert.match(code, /const SLICES = \['symbol', 'hour'\];/);
});

test('jpRender marks the cards its controls repaint, and keeps what they need', () => {
  const render = grabFn('jpRender');
  assert.match(render, /jpLast = \{ s, book, daily, liveToday, acct \};/);
  assert.match(render, /id="jpKpis"/);
  assert.match(render, /id="jpCalCard"/);
  assert.match(render, /id="jpBreakdownCard"/);
  assert.doesNotMatch(render, /jpSkips/);
});

// A fake page: every getElementById hands back an element that records what was written.
function harness({ sliceBody = { confirmed: { SPY: { trades: 2, winRate: 50, totalRealized: 10 } } }, ok = true, demo = false } = {}) {
  const writes = [];
  const fetches = [];
  const el = (id) => ({
    set innerHTML(v) { writes.push(id); },
    get innerHTML() { return ''; },
    setAttribute() {}, removeAttribute() {},
  });
  const document = { getElementById: (id) => el(id) };
  const fetchStub = async (url) => { fetches.push(url); return { ok, json: async () => sliceBody }; };
  const preamble = `
    let jpSlice = 'symbol';
    let jpData = { demo: ${demo}, slice: null };
    let jpLast = { s: {}, book: {}, daily: [], liveToday: null, acct: {} };
    const JP_LABELS = { symbol:'Symbol', hour:'Hour' };
    const jpSliceCache = {};
    const jpBreakdown = (x) => 'BREAKDOWN:' + (x ? 'data' : 'none');
    const jpCalendarCard = () => 'CALENDAR';
    const jpDaySeries = () => ({ days: [], mode: 'account' });
    const jpDayStats = () => ({ streak: 0 });
    const jpKpis = () => 'KPIS';
  `;
  const api = new Function('document', 'fetch', preamble + grabFn('jpSetSlice') + '\n' + grabFn('jpPaintCalendar')
    + '\nreturn { jpSetSlice, jpPaintCalendar, slice: () => jpSlice, cache: () => jpSliceCache };')(document, fetchStub);
  return { api, writes, fetches };
}

test('switching the breakdown repaints only that card, and asks once per slice', async () => {
  const { api, writes, fetches } = harness();
  await api.jpSetSlice('hour');
  assert.deepStrictEqual(writes, ['jpBreakdownCard'], 'nothing else on the page was written');
  assert.strictEqual(fetches.length, 1);
  assert.match(fetches[0], /^\/api\/trading\/scorecard\?by=hour$/, 'one slice, not the whole page');
  assert.strictEqual(api.slice(), 'hour');

  await api.jpSetSlice('symbol');
  await api.jpSetSlice('hour');
  assert.strictEqual(fetches.length, 2, 'each slice is fetched once, then cached');
  assert.deepStrictEqual(writes, ['jpBreakdownCard', 'jpBreakdownCard', 'jpBreakdownCard']);
});

test('an unknown slice does nothing at all', async () => {
  const { api, fetches, writes } = harness();
  await api.jpSetSlice('nope');
  assert.deepStrictEqual([fetches.length, writes.length], [0, 0]);
});

test('the demo book asks the demo endpoint', async () => {
  const { api, fetches } = harness({ demo: true });
  await api.jpSetSlice('hour');
  assert.deepStrictEqual(fetches, ['/api/trading/scorecard?demo=champion&by=hour']);
});

test('the calendar toggle repaints the calendar and its two tiles, nothing else', () => {
  const { api, writes, fetches } = harness();
  api.jpPaintCalendar();
  assert.deepStrictEqual(writes, ['jpCalCard', 'jpKpis']);
  assert.strictEqual(fetches.length, 0, 'switching the measure never hits the network');
});

test('a failed slice request leaves the page standing', async () => {
  const { api, writes } = harness({ ok: false });
  await api.jpSetSlice('hour');
  assert.deepStrictEqual(writes, ['jpBreakdownCard'], 'the card says so; the page does not reload');
  assert.strictEqual(api.cache().hour, null);
});
