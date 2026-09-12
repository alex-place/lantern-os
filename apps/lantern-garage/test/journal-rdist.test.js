'use strict';
/**
 * test/journal-rdist.test.js — #3550.
 *
 * The card's job is to stay honest about a distribution the record can only partly
 * support: the bars show what is known, the note says how much of the book that is, and
 * "nothing measurable" is never dressed up as "no trades".
 *
 * Run: node --test apps/lantern-garage/test/journal-rdist.test.js
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

const P = new Function([
  grabDecl('jpEsc'), grabDecl('jpSign'), grabDecl('jpR'),
  grabFn('jpRStat'), grabFn('jpRDist'),
].join('\n') + '\nreturn { jpR, jpRDist };')();

// The shape breakdownFromRows('r') returns.
const dist = (o) => ({
  by: 'r',
  basis: 'protective-stop distance at entry',
  confirmed: Object.assign({
    n: 10, withR: 10, coverage: 100, width: 0.2,
    buckets: [
      { from: -1, to: -0.8, count: 1, wins: 0 },
      { from: -0.8, to: -0.6, count: 0, wins: 0 },
      { from: -0.6, to: -0.4, count: 2, wins: 0 },
      { from: -0.4, to: -0.2, count: 0, wins: 0 },
      { from: -0.2, to: 0, count: 1, wins: 0 },
      { from: 0, to: 0.2, count: 5, wins: 5 },
      { from: 0.2, to: 0.4, count: 1, wins: 1 },
    ],
    mean: 0.01, median: 0.03, best: 0.32, worst: -0.95,
    wins: 6, losses: 4, avgWinR: 0.16, avgLossR: -0.23, payoff: 0.7,
  }, o),
});

test('an R reads as an R, with its sign', () => {
  assert.strictEqual(P.jpR(1), '+1.00R');
  assert.strictEqual(P.jpR(-0.5), '-0.50R');
  assert.strictEqual(P.jpR(0), '0.00R');
  assert.strictEqual(P.jpR(null), '—');
  assert.strictEqual(P.jpR(Infinity), '—');
});

test('the four figures say what the shape means', () => {
  const html = P.jpRDist(dist());
  assert.match(html, /Average/);
  assert.match(html, /\+0\.01R/);
  assert.match(html, /Median/);
  assert.match(html, /Payoff/);
  assert.match(html, /0\.70/, 'the payoff ratio itself');
  assert.match(html, /\+0\.16R win · -0\.23R loss/, 'and the two averages behind it');
  assert.match(html, /-0\.95R → \+0\.32R/, 'the range the record actually covers');
  assert.match(html, /6W \/ 4L/);
});

test('a payoff under 1 is not dressed up as a good number', () => {
  // Above 1.00 the average winner outruns the average loser; below it, it does not.
  // Colouring by the raw value would paint 0.70 green for being positive.
  const poor = P.jpRDist(dist({ payoff: 0.7 }));
  const good = P.jpRDist(dist({ payoff: 1.8 }));
  const payoffClass = (html) => (html.match(/Payoff<\/div>\s*<div class="v ([a-z-]*)"/) || [])[1];
  assert.strictEqual(payoffClass(poor), 'jp-neg');
  assert.strictEqual(payoffClass(good), 'jp-pos');
});

test('every bucket becomes a bar, and an empty bucket keeps its place on the axis', () => {
  const html = P.jpRDist(dist());
  assert.strictEqual((html.match(/class="jp-rcol/g) || []).length, 7, 'including the two empty ones');
  assert.match(html, /height:0%/, 'an empty bucket has no bar');
  assert.match(html, /height:100%/, 'and the fullest one is full height');
});

test('losing buckets and winning buckets are told apart, and zero is the line', () => {
  const html = P.jpRDist(dist());
  assert.strictEqual((html.match(/jp-rcol loss/g) || []).length, 5);
  assert.strictEqual((html.match(/jp-rcol win/g) || []).length, 2);
  assert.strictEqual((html.match(/zero/g) || []).length, 1, 'exactly one bucket starts at zero');
});

test('partial coverage is stated, in the record\'s own terms', () => {
  const html = P.jpRDist(dist({ n: 273, withR: 127, coverage: 46.5 }));
  assert.match(html, /Measured on 127 of 273 closed trades \(46\.5%\)/);
  assert.match(html, /before the stop distance was recorded/, 'and says why the rest are missing');
  assert.doesNotMatch(P.jpRDist(dist()), /Measured on/, 'full coverage needs no caveat');
});

test('trades with no recorded risk are "not measurable", never "no trades"', () => {
  // The trades exist. Their risk was not written down. Those are different sentences,
  // and only one of them tells the reader what is actually going on.
  const html = P.jpRDist(dist({ n: 40, withR: 0, coverage: 0, buckets: [], mean: null, median: null, payoff: null }));
  assert.match(html, /None of the 40 closed trades recorded the stop distance/);
  assert.match(html, /Trades from here on do record it/, 'and that it fixes itself');
  assert.doesNotMatch(html, /No closed trades yet/);
  assert.doesNotMatch(html, /jp-rhist/, 'no axis is drawn for nothing');
});

test('an genuinely empty book says so', () => {
  const html = P.jpRDist(dist({ n: 0, withR: 0, coverage: 0, buckets: [] }));
  assert.match(html, /No closed trades yet/);
});

test('a failed request is not reported as an empty book', () => {
  const html = P.jpRDist(null);
  assert.match(html, /could not be loaded/);
  assert.doesNotMatch(html, /No closed trades/);
  assert.match(P.jpRDist(undefined), /aria-busy/, 'and one in flight is busy');
});

test('the histogram is described for a reader who cannot see it', () => {
  const html = P.jpRDist(dist());
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Distribution of 10 trades by R multiple, from -0\.95R to \+0\.32R"/);
  assert.strictEqual((html.match(/visually-hidden/g) || []).length, 7, 'each bar states its own range and count');
});

test('the note names the bucket width, because a histogram without one says nothing', () => {
  assert.match(P.jpRDist(dist()), /low edge of each 0\.20R bucket/);
  assert.match(P.jpRDist(dist({ width: 0.5 })), /each 0\.50R bucket/);
});

test('the card asks for its own slice once, and is in the arrangement registry', () => {
  const ensure = grabFn('jpEnsureRDist');
  assert.match(ensure, /by=r\b/);
  assert.match(ensure, /jpSliceCache\.r !== undefined/, 'cached, so a repaint does not refetch');
  const reg = src.slice(src.indexOf('const JP_WIDGETS = ['));
  assert.match(reg.slice(0, reg.indexOf(']')), /id: 'rdist'/);
  assert.match(grabFn('jpCardBody'), /id === 'rdist'/);
});
