'use strict';
/**
 * test/journal-share-ui.test.js — #3562.
 *
 * The panel is the last thing standing between a reader and publishing their own money,
 * so what it must NOT do is as much of the contract as what it does:
 *
 *   - it never posts figures (the server computes the card);
 *   - previewing is a GET and publishing is a POST, so looking cannot publish;
 *   - amounts are off until asked for, per share;
 *   - the preview is drawn from the payload, so a withheld figure is missing here for the
 *     same reason it will be missing on the public page.
 *
 * Run: node --test apps/lantern-garage/test/journal-share-ui.test.js
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
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpR'),
  'let jpShare = null;',
  grabDecl('jpShareMoneyless'), grabFn('jpSharePreviewBody'),
].join('\n') + '\nreturn { body: jpSharePreviewBody, set: (s) => { jpShare = s; } };')();

const withState = (s) => { P.set(s); return P.body(); };

const PAYLOAD = (over) => Object.assign({
  v: 1, kind: 'month', label: 'Monthly report', dollars: false,
  card: { month: '2026-08', tradingDays: 7, dayWinRate: 28.6, profitFactor: 0.38, trades: 31, winRate: 51.6 },
  basis: 'booked ledger, exchange days', sharedAt: '2026-09-13T00:00:00.000Z',
}, over);

// ── what the panel promises ──────────────────────────────────────────────────

test('the panel never posts figures — it names a kind and its options', () => {
  /* A shared page carries our name, so it must carry the reader's record rather than
     whatever their browser claimed was in it. */
  const pub = grabFn('jpSharePublish');
  assert.match(pub, /method: 'POST'/);
  assert.match(pub, /JSON\.stringify\(\{ kind: jpShare\.kind, month: jpShare\.month, dollars: jpShare\.dollars \}\)/);
  assert.doesNotMatch(pub, /card:/, 'the body must carry no card');
  assert.doesNotMatch(pub, /payload:/);
});

test('looking cannot publish: the preview is a GET to its own endpoint', () => {
  const prev = grabFn('jpSharePreview');
  assert.match(prev, /\/api\/journal\/share\/preview\?/);
  assert.doesNotMatch(prev, /method: 'POST'/, 'previewing through the publish path would go live');
  assert.doesNotMatch(prev, /method: 'DELETE'/);
});

test('publishing is its own explicit press, not a side effect of choosing', () => {
  for (const fn of ['jpShareOpen', 'jpShareSet', 'jpSharePreview']) {
    assert.doesNotMatch(grabFn(fn), /jpSharePublish\(/, fn + ' must not publish');
  }
  assert.match(src, /onclick="jpSharePublish\(\)"/);
  assert.match(src, />Publish this card</);
});

test('amounts are off until a reader asks, on every new share', () => {
  const open = grabFn('jpShareOpen');
  assert.match(open, /dollars: false/, 'the panel opens withholding');
  // And a card with nothing to withhold cannot be switched on at all.
  const set = grabFn('jpShareSet');
  assert.match(set, /if \(jpShareMoneyless\(\)\) jpShare\.dollars = false;/);
});

test('the trade log, the notes and the tags are not offered', () => {
  const kinds = grabDecl('JP_SHARE_KINDS');
  for (const forbidden of ['trades', 'notes', 'tags', 'calendar', 'placements', 'coach']) {
    assert.ok(!new RegExp('\\b' + forbidden + ':').test(kinds), forbidden + ' is offered for sharing');
  }
  assert.match(kinds, /month:/);
  assert.match(kinds, /symbols:/);
  assert.match(kinds, /rmultiples:/);
});

test('the reader is told, in the panel, what is never shareable', () => {
  // The sentence is split across two source lines, so match its halves rather than
  // pinning where the string concatenation happens to break.
  assert.match(src, /your trade log, notes and/);
  assert.match(src, /tags are never shareable/);
  assert.match(grabFn('jpSharePreviewBody'), /notes and tags are never shared/);
});

// ── the preview body ─────────────────────────────────────────────────────────

test('the preview shows exactly what the payload carries, and no more', () => {
  const quiet = withState({ opts: { moneyless: ['rmultiples'] }, kind: 'month', preview: PAYLOAD() });
  assert.ok(!quiet.includes('$'), 'an amount appeared in a withheld preview: ' + quiet);
  assert.match(quiet, /Amounts are withheld/);

  const loud = withState({ opts: { moneyless: ['rmultiples'] }, kind: 'month',
    preview: PAYLOAD({ dollars: true, card: Object.assign({}, PAYLOAD().card, { pnl: -866.28, bestDay: 377.01, worstDay: -593.42 }) }) });
  assert.match(loud, /-\$866\.28/);
  assert.match(loud, /Amounts are included/);
});

test('a card with no money in it says so rather than claiming to withhold anything', () => {
  const r = withState({ opts: { moneyless: ['rmultiples'] }, kind: 'rmultiples',
    preview: PAYLOAD({ kind: 'rmultiples', label: 'R multiples',
      card: { n: 43, withR: 29, mean: -0.06, median: 0.16, best: 1.02, worst: -2.78 } }) });
  assert.match(r, /no amounts in it to withhold/);
  assert.ok(!/Amounts are withheld/.test(r), 'there is nothing being withheld');
});

test('while the preview is in flight the panel says so, and an empty one is honest', () => {
  assert.match(withState({ kind: 'month', preview: undefined }), /Working out what that would show/);
  assert.match(withState({ kind: 'month', preview: null }), /nothing in your record to share/);
});

test('a symbol is escaped on its way into the preview', () => {
  const html = withState({ opts: {}, kind: 'symbols',
    preview: PAYLOAD({ kind: 'symbols', label: 'Symbol statistics',
      card: { rows: [{ symbol: '<b>X</b>', trades: 2, winRate: 50, profitFactor: 1 }] } }) });
  assert.ok(!html.includes('<b>X</b>'), html);
});

// ── the dialog itself ────────────────────────────────────────────────────────

test('it is a dialog, escapable, and announced as one', () => {
  const paint = grabFn('jpSharePaint');
  assert.match(paint, /role="dialog" aria-modal="true" aria-label="Share a card"/);
  assert.match(paint, /e\.key === 'Escape'/, 'a dialog about publishing must be trivially escapable');
});

test('every live share can be taken down from the panel', () => {
  const paint = grabFn('jpSharePaint');
  assert.match(paint, /jpShareRevoke\(/);
  assert.match(paint, />Take down</);
  const revoke = grabFn('jpShareRevoke');
  assert.match(revoke, /method: 'DELETE'/);
  assert.match(revoke, /jpShare\.shares\.filter/, 'and the row goes with it');
});

test('with nothing shared, the panel says so plainly', () => {
  assert.match(grabFn('jpSharePaint'), /Nothing of yours is public/);
});

test('the share button does not publish — it opens the panel', () => {
  assert.match(src, /id="jpShareBtn" onclick="jpShareOpen\(\)"/);
});
