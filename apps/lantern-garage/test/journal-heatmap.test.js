'use strict';
/**
 * test/journal-heatmap.test.js — #3549.
 *
 * Weekday × hour. The thing worth pinning is that the grid only claims what the buckets
 * support: expectancy rather than totals (so one big winner cannot light up an hour it
 * traded once), colour that is decoration over a figure rather than the figure itself,
 * and no row or column for a weekday or hour that never traded.
 *
 * Run: node --test apps/lantern-garage/test/journal-heatmap.test.js
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
const grabDecl = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const CODE = [
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpUsdShort'), grabDecl('jpPct'), grabDecl('jpSign'),
  grabDecl('JP_THIN_TRADES'), grabDecl('JP_WEEK_ORDER'),
  grabFn('jpHeatGrid'), grabFn('jpHeatCaveat'), grabFn('jpHeatmap'),
].join('\n');
const P = new Function(CODE + '\nreturn { JP_WEEK_ORDER, jpHeatGrid, jpHeatCaveat, jpHeatmap };')();

// The shape breakdown('weekday-hour') returns: keys are "Mon 10:00 ET".
const stat = (o) => Object.assign({ trades: 10, wins: 6, losses: 4, winRate: 60, totalRealized: 300,
  avgWin: 90, avgLoss: -45, expectancy: 30, profitFactor: 2 }, o);
const slice = (confirmed) => ({ by: 'weekday-hour', confirmed });

const WEEK = slice({
  'Mon 10:00 ET': stat({ expectancy: 50, trades: 12 }),
  'Mon 15:00 ET': stat({ expectancy: -80, trades: 9, winRate: 22.2, totalRealized: -720 }),
  'Wed 10:00 ET': stat({ expectancy: 20, trades: 7 }),
  'Fri 09:00 ET': stat({ expectancy: 5, trades: 2 }),
});

test('the grid has a row and a column only for a weekday and hour that traded', () => {
  const g = P.jpHeatGrid(WEEK);
  assert.deepStrictEqual(g.weekdays, ['Mon', 'Wed', 'Fri'], 'in week order, and no Tue or Thu');
  assert.deepStrictEqual(g.hours, ['09', '10', '15'], 'ascending, and no hour that never traded');
});

test('a cell is found by its weekday and hour', () => {
  const g = P.jpHeatGrid(WEEK);
  assert.strictEqual(g.cells['Mon10'].expectancy, 50);
  assert.strictEqual(g.cells['Mon15'].expectancy, -80);
  assert.strictEqual(g.cells['Wed15'], undefined, 'a pairing that never happened has no cell');
});

test('the colour scale is set by the strongest cell either way', () => {
  assert.strictEqual(P.jpHeatGrid(WEEK).max, 80, 'the worst hour is the biggest magnitude here');
});

test('a malformed key is skipped rather than drawn as a phantom row', () => {
  const g = P.jpHeatGrid(slice({
    'Mon 10:00 ET': stat({}),
    'Funday 10:00 ET': stat({}),
    'Mon': stat({}),
    '': stat({}),
    'Tue xx:00 ET': stat({}),
  }));
  assert.deepStrictEqual(g.weekdays, ['Mon']);
  assert.deepStrictEqual(g.hours, ['10']);
});

test('an empty or missing slice says so instead of drawing an empty week', () => {
  assert.match(P.jpHeatmap(slice({})), /No closed trades to place on a week yet/);
  assert.doesNotMatch(P.jpHeatmap(slice({})), /<table/);
  assert.match(P.jpHeatmap(undefined), /aria-busy/, 'a slice still in flight is busy, not empty');
});

test('a request that FAILED is not reported as a book with no trades', () => {
  // A server that does not know this slice yet -- an older box, a trader running behind
  // the site -- returns 400, and jpEnsureHeatmap caches null. Telling someone who has
  // traded all week that they have never traded is the one thing this card must not do.
  const failed = P.jpHeatmap(null);
  assert.match(failed, /could not be loaded/);
  assert.doesNotMatch(failed, /No closed trades/);
  assert.match(failed, /Every other figure on this page is unaffected/, 'and it does not overstate the damage');
});

test('every cell carries its figure, so the grid does not live in the colours alone', () => {
  const html = P.jpHeatmap(WEEK);
  assert.match(html, /\+\$50/, 'a good hour states its expectancy');
  assert.match(html, /-\$80/, 'and so does a bad one');
  assert.match(html, /\+\$20/);
});

test('the figure is expectancy, not the total — one big winner cannot light up an hour', () => {
  const oneLucky = slice({ 'Mon 10:00 ET': stat({ trades: 1, expectancy: 40, totalRealized: 40 }) });
  const grind = slice({ 'Mon 10:00 ET': stat({ trades: 40, expectancy: 40, totalRealized: 1600 }) });
  const strength = (html) => Number((html.match(/srgb, var\(--\w+\) (\d+)%/) || [])[1]);
  assert.strictEqual(strength(P.jpHeatmap(oneLucky)), strength(P.jpHeatmap(grind)),
    'the same expectancy is the same colour whatever the total behind it');
});

test('a thin cell is faded and says why, and the note only appears when there is one', () => {
  const html = P.jpHeatmap(WEEK);                      // Fri 09:00 has 2 trades
  assert.match(html, /class="jp-heat-c few"/);
  assert.match(html, /too few to measure/, 'the cell says it in its own label');
  assert.match(html, /Faded cells have fewer than 5 trades/);
  const solid = slice({ 'Mon 10:00 ET': stat({ trades: 30 }) });
  assert.doesNotMatch(P.jpHeatmap(solid), /Faded cells/);
  assert.doesNotMatch(P.jpHeatmap(solid), /few"/);
});

test('a grid where EVERY cell is thin does not describe itself as having faded cells', () => {
  // Naming "faded cells" when all of them are points at a contrast the reader cannot see,
  // and quietly implies the rest is solid. A young book is exactly this case.
  const young = slice({ 'Mon 10:00 ET': stat({ trades: 3 }), 'Tue 12:00 ET': stat({ trades: 2 }) });
  const html = P.jpHeatmap(young);
  assert.match(html, /Every cell here has fewer than 5 trades/);
  assert.doesNotMatch(html, /Faded cells/);
  assert.strictEqual(P.jpHeatCaveat(4, 0), '', 'nothing thin, nothing to say');
  assert.match(P.jpHeatCaveat(4, 1), /Faded cells/);
  assert.match(P.jpHeatCaveat(4, 4), /Every cell/);
});

test('the hour headers are not right-aligned away from the columns they label', () => {
  // .jp-table .num right-aligns, which in a 58px cell puts "10" over the column's edge.
  const html = P.jpHeatmap(WEEK);
  assert.doesNotMatch(html, /<th class="num" scope="col">/);
  assert.match(html, /<th scope="col">09<\/th>/);
});

test('an hour that never traded on a given day is empty, not zero', () => {
  const html = P.jpHeatmap(WEEK);                      // Wed 15:00 never happened
  assert.match(html, /jp-heat-0/);
  assert.match(html, />no trades</, 'and a screen reader is told so rather than reading a blank');
});

test('every cell states its numbers for a reader who cannot see the colour', () => {
  const html = P.jpHeatmap(WEEK);
  assert.match(html, /Mon 15:00 ET — 9 trades, 22\.2% win, -\$80\.00 per trade, -\$720\.00 in total/);
  const titles = (html.match(/title="/g) || []).length;
  assert.strictEqual(titles, 4, 'one per cell that traded');
});

test('the week reads Monday first, whatever order the buckets arrive in', () => {
  const g = P.jpHeatGrid(slice({
    'Fri 10:00 ET': stat({}), 'Mon 10:00 ET': stat({}), 'Wed 10:00 ET': stat({}), 'Sun 10:00 ET': stat({}),
  }));
  assert.deepStrictEqual(g.weekdays, ['Mon', 'Wed', 'Fri', 'Sun'], 'a weekend session sorts after the week, not before it');
});

test('a hostile bucket key cannot smuggle markup into the grid', () => {
  const html = P.jpHeatmap(slice({ 'Mon 10:00 ET': stat({ winRate: '<img src=x onerror=alert(1)>' }) }));
  assert.doesNotMatch(html, /<img/);
});

test('the card asks for its own slice once, and is in the arrangement registry', () => {
  const ensure = grabFn('jpEnsureHeatmap');
  assert.match(ensure, /by=weekday-hour/);
  assert.match(ensure, /jpSliceCache\['weekday-hour'\] !== undefined/, 'cached, so a repaint does not refetch');
  assert.match(ensure, /jpHeatCard/);
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  assert.match(reg.slice(0, reg.indexOf(']')), /id: 'heatmap'/);
  assert.match(grabFn('jpCardBody'), /id === 'heatmap'/);
});
