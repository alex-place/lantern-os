'use strict';
/**
 * test/journal-symbols.test.js — #3547.
 *
 * The symbol statistics card: the reader's question is "which symbols is this thing good
 * at", and the table must not answer it with numbers it cannot support. Two things matter
 * enough to pin — the ordering rules (including where an unpriced symbol goes), and the
 * fact that sorting is done in rows the page already holds rather than by reloading.
 *
 * Run: node --test apps/lantern-garage/test/journal-symbols.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

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
const grabDecl = (name, kw) => {
  const i = src.indexOf('\n' + (kw || 'const') + ' ' + name + ' =');
  assert.ok(i >= 0, 'declaration not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |async function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

// The page's own formatters, so the rendered strings under test are the rendered strings.
const CODE = [
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpSign'),
  grabDecl('JP_THIN_TRADES'), grabDecl('JP_SYM_COLS'), grabDecl('jpSymSort', 'let'),
  grabFn('jpProfitFactor'), grabFn('jpSymbolRows'), grabFn('jpLabelValue'), grabFn('jpSymbols'),
].join('\n');
const P = new Function(CODE
  + '\nreturn { JP_SYM_COLS, JP_THIN_TRADES, jpProfitFactor, jpSymbolRows, jpSymbols,'
  + ' setSort: (s) => { jpSymSort = s; } };')();

const slice = (confirmed) => ({ by: 'symbol', confirmed });
const sym = (o) => Object.assign({ trades: 10, wins: 6, losses: 4, winRate: 60, totalRealized: 100,
  avgWin: 50, avgLoss: -25, expectancy: 10, profitFactor: 2 }, o);

const BOOK = slice({
  TQQQ: sym({ totalRealized: 900, trades: 20, winRate: 65, expectancy: 45 }),
  SOXL: sym({ totalRealized: -300, trades: 12, winRate: 33.3, expectancy: -25 }),
  SPY: sym({ totalRealized: 150, trades: 3, winRate: 100, expectancy: 50, losses: 0, wins: 3, profitFactor: null }),
  AAPL: sym({ totalRealized: 0, trades: 8, winRate: 50, expectancy: 0 }),
});

test('the columns are sound and every one of them can render a row', () => {
  const keys = P.JP_SYM_COLS.map((c) => c.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'column keys are unique');
  assert.strictEqual(keys[0], 'key', 'the symbol itself leads the table');
  for (const c of P.JP_SYM_COLS) {
    assert.ok(c.label && c.label.length > 1, c.key + ' has a header');
    if (c.key !== 'key') assert.strictEqual(typeof c.fmt(sym({})), 'string', c.key + ' renders a string');
  }
});

test('the default order puts the biggest earner first and the biggest loser last', () => {
  const rows = P.jpSymbolRows(BOOK, { key: 'totalRealized', dir: -1 });
  assert.deepStrictEqual(rows.map((r) => r.key), ['TQQQ', 'SPY', 'AAPL', 'SOXL']);
  assert.deepStrictEqual(P.jpSymbolRows(BOOK, { key: 'totalRealized', dir: 1 }).map((r) => r.key),
    ['SOXL', 'AAPL', 'SPY', 'TQQQ'], 'and reversing means reversing');
});

test('sorting by name is alphabetical, not numeric', () => {
  assert.deepStrictEqual(P.jpSymbolRows(BOOK, { key: 'key', dir: 1 }).map((r) => r.key),
    ['AAPL', 'SOXL', 'SPY', 'TQQQ']);
});

test('a symbol with no value for the column sorts last in BOTH directions', () => {
  const withGap = slice(Object.assign({}, BOOK.confirmed, {
    NEW: sym({ expectancy: null, totalRealized: 5, trades: 1 }),
  }));
  for (const dir of [1, -1]) {
    const rows = P.jpSymbolRows(withGap, { key: 'expectancy', dir });
    assert.strictEqual(rows[rows.length - 1].key, 'NEW', 'dir ' + dir + ': an unpriced symbol never heads the table');
  }
});

test('ties break on the symbol name, so the order never jitters between paints', () => {
  const tied = slice({ BBB: sym({ totalRealized: 10 }), AAA: sym({ totalRealized: 10 }), CCC: sym({ totalRealized: 10 }) });
  const once = P.jpSymbolRows(tied, { key: 'totalRealized', dir: -1 }).map((r) => r.key);
  assert.deepStrictEqual(once, ['AAA', 'BBB', 'CCC']);
  assert.deepStrictEqual(P.jpSymbolRows(tied, { key: 'totalRealized', dir: -1 }).map((r) => r.key), once, 'stable');
});

test('a symbol that has never lost reads as an infinite profit factor, not a missing one', () => {
  // JSON has no Infinity: the scorecard's Infinity arrives as null, exactly like "not computed".
  assert.strictEqual(P.jpProfitFactor({ profitFactor: null, wins: 3, losses: 0 }), '∞');
  assert.strictEqual(P.jpProfitFactor({ profitFactor: null, wins: 0, losses: 0 }), '—', 'no trades is not infinity');
  assert.strictEqual(P.jpProfitFactor({ profitFactor: 2.345 }), '2.35');
});

test('and it sorts where its ∞ says it belongs — top of the column, not bottom', () => {
  // The bug this pins: null-over-the-wire made the biggest number in the column sort as
  // "no value", so a descending sort put ∞ last, directly under the reader's eyes.
  const book = {
    confirmed: {
      NEVERLOST: sym({ profitFactor: null, wins: 4, losses: 0 }),
      GOOD: sym({ profitFactor: 3 }),
      POOR: sym({ profitFactor: 0.5 }),
      UNPRICED: sym({ profitFactor: null, wins: 0, losses: 0, trades: 0 }),
    },
  };
  assert.deepStrictEqual(P.jpSymbolRows(book, { key: 'profitFactor', dir: -1 }).map((r) => r.key),
    ['NEVERLOST', 'GOOD', 'POOR', 'UNPRICED'], 'infinite first, genuinely unpriced last');
  assert.deepStrictEqual(P.jpSymbolRows(book, { key: 'profitFactor', dir: 1 }).map((r) => r.key),
    ['POOR', 'GOOD', 'NEVERLOST', 'UNPRICED'], 'ascending flips the priced ones and still parks the unpriced');
});

test('thin data is marked as thin, and says so under the table', () => {
  const html = P.jpSymbols(BOOK);                       // SPY has 3 trades
  assert.match(html, /†/, 'the thin row carries a mark');
  assert.match(html, /fewer than 5 closed trades/, 'and the note explains it');
  const thick = slice({ TQQQ: sym({ trades: 20 }) });
  assert.doesNotMatch(P.jpSymbols(thick), /fewer than 5 closed trades/, 'no note when nothing is thin');
});

test('an empty book says so instead of drawing an empty table', () => {
  assert.match(P.jpSymbols(slice({})), /No closed trades/);
  assert.doesNotMatch(P.jpSymbols(slice({})), /<table/);
  assert.match(P.jpSymbols(undefined), /aria-busy/, 'and a slice still in flight is busy, not empty');
});

test('the table reports broker-accepted fills only, like every other figure on the page', () => {
  const html = P.jpSymbols(BOOK);
  assert.match(html, /Broker-accepted fills only/);
  const all = slice({ GHOST: sym({ totalRealized: 9999 }) });
  all.all = { NEVER_FILLED: sym({ totalRealized: -99999 }) };
  assert.doesNotMatch(P.jpSymbols(all), /NEVER_FILLED/, 'the unconfirmed view is not what this card shows');
});

test('the sorted column is announced, and the headers are buttons', () => {
  P.setSort({ key: 'winRate', dir: 1 });
  const html = P.jpSymbols(BOOK);
  assert.match(html, /aria-sort="ascending"/);
  assert.strictEqual((html.match(/aria-sort=/g) || []).length, 1, 'exactly one column is the sorted one');
  assert.strictEqual((html.match(/<button type="button" class="jp-sort"/g) || []).length, P.JP_SYM_COLS.length);
  P.setSort({ key: 'totalRealized', dir: -1 });
});

test('a symbol name cannot smuggle markup into the table', () => {
  const nasty = slice({ '<img src=x onerror=alert(1)>': sym({}) });
  const html = P.jpSymbols(nasty);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('re-sorting repaints one card and never reloads the record', () => {
  const setter = grabFn('jpSetSymSort');
  assert.match(setter, /getElementById\('jpSymbolsCard'\)/, 'it touches its own card');
  assert.match(setter, /jpSliceCache\.symbol/, 'from the slice already in hand');
  assert.doesNotMatch(setter, /fetch\(/, 'sorting fetches nothing');
  assert.doesNotMatch(setter, /jpLoad\(/, 'and reloads nothing');
});

test('the card is in the arrangement registry, so it can be moved and hidden like the rest', () => {
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  const entry = reg.slice(0, reg.indexOf(']'));
  assert.match(entry, /id: 'symbols'/);
  assert.match(entry, /name: 'Symbol statistics'/);
  assert.match(grabFn('jpCardBody'), /id === 'symbols'/, 'and the page knows how to draw it');
});
