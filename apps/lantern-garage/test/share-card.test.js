'use strict';
/**
 * test/share-card.test.js — #3562.
 *
 * This is the file that decides what leaves a reader's journal, so these tests are
 * adversarial rather than illustrative: they feed the builder a source stuffed with
 * things that must never be published — notes, tags, a user id, raw ledger rows, dollar
 * figures the reader did not opt into — and then walk the ENTIRE output, at every depth,
 * asserting that every key that came out was named in the spec on purpose.
 *
 * A test that checked a few fields were absent would pass forever while the thing it was
 * protecting quietly grew a new one.
 *
 * Run: node --test apps/lantern-garage/test/share-card.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/share-card');

/* Every key anywhere in a value, at any depth, including inside arrays. */
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  }
  return out;
}

/* Every string anywhere in a value — for proving a note or a tag did not ride along. */
function allStrings(v, out = []) {
  if (typeof v === 'string') { out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) allStrings(x, out); return out; }
  if (v && typeof v === 'object') { for (const x of Object.values(v)) allStrings(x, out); }
  return out;
}

/* A source with EVERYTHING in it, private material included. Nothing here is filtered on
   the way in — the point is that the builder copies only what it was told to. */
const SECRET = 'revenge-traded-after-the-cpi-print';
function source() {
  return {
    rdist: {
      n: 40, withR: 31, coverage: 77.5, width: 0.5, mean: 0.12, median: 0.2,
      best: 3.1, worst: -2.4, wins: 19, losses: 12, avgWinR: 0.9, avgLossR: -1.0, payoff: 0.9,
      buckets: [
        { from: -1, to: -0.5, count: 4, wins: 0, note: SECRET, tradeIds: ['ord-1'] },
        { from: 0.5, to: 1, count: 9, wins: 9 },
      ],
      note: SECRET, generatedAt: '2026-09-13T00:00:00.000Z', rawRows: [{ pnl: 1, user: 'u-private' }],
    },
    bySymbol: {
      SPY: { trades: 12, wins: 7, losses: 5, winRate: 58.33, totalRealized: 412.5,
        avgWin: 90, avgLoss: -60, expectancy: 34.4, profitFactor: 1.4,
        riskExitTrades: 9, riskExitWinRate: 55, estimatedTrades: 1,
        excursions: { nMfe: 12, avgMfePct: 1.2 }, notes: SECRET, tags: ['tilt'] },
      QQQ: { trades: 3, winRate: 33.33, totalRealized: -80, profitFactor: 0.4 },
    },
    days: [
      { date: '2026-09-01', pnl: 120.5, cum: 120.5 },
      { date: '2026-09-02', pnl: -40.25, cum: 80.25 },
      { date: '2026-09-03', pnl: 0, cum: 80.25 },
      { date: '2026-09-04', pnl: 260, cum: 340.25 },
      { date: '2026-08-29', pnl: -900, cum: -900 },
    ],
    monthStats: {
      '2026-09': { trades: 15, winRate: 60, totalRealized: 340.25, avgWin: 70, notes: SECRET },
      '2026-08': { trades: 4, winRate: 25, totalRealized: -900 },
    },
    // Things a future refactor might plausibly hang here. None may survive.
    notes: { 'ord-1': { note: SECRET, tags: ['tilt'], feel: 'frustrated' } },
    user: 'u-private',
    exits: [{ ts: '2026-09-01T18:00:00Z', user: 'u-private', pnl: 120.5, order_id: 'ord-1' }],
  };
}

const OPTS = { month: '2026-09' };

// ── the allow-list, proven exhaustively ──────────────────────────────────────

test('every key in a shared card was named in the spec, at every depth', () => {
  const allowed = {
    rmultiples: new Set(C.SPEC.rmultiples.always.concat(C.SPEC.rmultiples.bucket, ['buckets'])),
    symbols: new Set(C.SPEC.symbols.row.always.concat(C.SPEC.symbols.row.money, ['rows'])),
    month: new Set(C.SPEC.month.always.concat(C.SPEC.month.money)),
  };
  for (const kind of C.KINDS) {
    for (const dollars of [false, true]) {
      const built = C.build(kind, source(), Object.assign({ dollars }, OPTS));
      assert.ok(built, kind + ' built');
      for (const k of allKeys(built.card)) {
        assert.ok(allowed[kind].has(k), kind + (dollars ? ' (dollars)' : '') + ' leaked field: ' + k);
      }
    }
  }
});

test('a note, a tag or a feeling cannot reach a shared card by any route', () => {
  // Not "is filtered out" — there is no option that turns them on, which is the only
  // form of this promise worth making.
  for (const kind of C.KINDS) {
    for (const dollars of [false, true]) {
      const built = C.build(kind, source(), Object.assign({ dollars }, OPTS));
      const text = allStrings(C.envelope(built)).join(' | ');
      assert.ok(!text.includes(SECRET), kind + ' carried a note');
      assert.ok(!/tilt|frustrated|u-private|ord-1/.test(text), kind + ' carried private material: ' + text);
    }
  }
});

test('a field nobody added to the spec does not appear, however it arrives', () => {
  const src = source();
  src.bySymbol.SPY.brandNewUpstreamField = 'surprise';
  src.rdist.brandNewUpstreamField = 'surprise';
  for (const kind of ['symbols', 'rmultiples']) {
    const built = C.build(kind, src, OPTS);
    assert.ok(!allKeys(built.card).has('brandNewUpstreamField'),
      kind + ' copied a field it was never told about');
  }
});

// ── money is opt-in ──────────────────────────────────────────────────────────

test('dollars are withheld by default, and their fields are ABSENT rather than blanked', () => {
  /* Absent, not null: the shared page renders what the payload carries, so withholding
     is enforced by there being nothing to draw rather than by a display rule. */
  const m = C.build('month', source(), { month: '2026-09' }).card;
  for (const k of C.SPEC.month.money) {
    assert.ok(!(k in m), 'month still carries ' + k);
  }
  const s = C.build('symbols', source(), {}).card.rows[0];
  assert.ok(!('realized' in s), 'symbols still carries realized');
  // And what survives is a real answer, not a redaction.
  assert.strictEqual(typeof m.profitFactor, 'number');
  assert.strictEqual(typeof s.winRate, 'number');
});

test('opting in adds exactly the money fields and nothing else', () => {
  const off = C.build('month', source(), { month: '2026-09' }).card;
  const on = C.build('month', source(), { month: '2026-09', dollars: true }).card;
  const added = Object.keys(on).filter((k) => !(k in off));
  assert.deepStrictEqual(added.sort(), C.SPEC.month.money.slice().sort());
});

test('the R card has no money in it at all, so its switch changes nothing', () => {
  const off = C.build('rmultiples', source(), { dollars: false });
  const on = C.build('rmultiples', source(), { dollars: true });
  assert.deepStrictEqual(off.card, on.card);
  assert.strictEqual(on.dollars, false, 'and it does not claim to be showing amounts');
});

test('nothing is converted to a percentage of an invented base', () => {
  // A month's profit as a percent needs account equity we may not hold. A fabricated
  // denominator on a page carrying our name would be worse than an absent number.
  const m = C.build('month', source(), { month: '2026-09' }).card;
  assert.ok(!('pnlPct' in m) && !('returnPct' in m) && !('pnl' in m));
});

// ── the figures themselves ───────────────────────────────────────────────────

test('a month is the days of THAT month, and a flat day is not a losing day', () => {
  const m = C.build('month', source(), { month: '2026-09', dollars: true }).card;
  assert.strictEqual(m.tradingDays, 4, 'August 29 is not September');
  assert.strictEqual(m.pnl, 340.25);
  assert.strictEqual(m.bestDay, 260);
  assert.strictEqual(m.worstDay, -40.25);
  // 2 up, 1 down, 1 flat → 2/3, not 2/4.
  assert.strictEqual(m.dayWinRate, 66.7);
  assert.strictEqual(m.drawdown, 40.25);
});

test('a month takes ITS OWN trade figures, not the whole book\'s', () => {
  /* It did exactly that on the first real run: a September card claiming the 43 trades
     of a book that starts in August. monthStats is keyed by month so the mistake cannot
     be expressed. */
  const sep = C.build('month', source(), { month: '2026-09' }).card;
  const aug = C.build('month', source(), { month: '2026-08' }).card;
  assert.strictEqual(sep.trades, 15);
  assert.strictEqual(aug.trades, 4);
  assert.notStrictEqual(sep.winRate, aug.winRate);
});

test('symbols come out ordered by how much of the book they are', () => {
  const rows = C.build('symbols', source(), {}).card.rows;
  assert.deepStrictEqual(rows.map((r) => r.symbol), ['SPY', 'QQQ']);
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('a card the record cannot support is not created at all', () => {
  assert.strictEqual(C.build('month', source(), { month: '2026-01' }), null, 'a month with no days');
  assert.strictEqual(C.build('month', source(), { month: 'whenever' }), null, 'a month that is not one');
  assert.strictEqual(C.build('month', source(), {}), null, 'no month named');
  assert.strictEqual(C.build('symbols', { bySymbol: {} }, {}), null, 'an empty book');
  assert.strictEqual(C.build('rmultiples', { rdist: { n: 0 } }, {}), null, 'nothing to distribute');
});

test('an unknown kind builds nothing — the list of shareable cards is closed', () => {
  for (const kind of ['trades', 'notes', 'calendar', 'tags', '', null, '__proto__']) {
    assert.strictEqual(C.build(kind, source(), OPTS), null, String(kind) + ' must not be shareable');
  }
});

test('the envelope says what the card is and nothing about who made it', () => {
  const env = C.envelope(C.build('month', source(), { month: '2026-09' }), { sharedAt: '2026-09-13T00:00:00.000Z' });
  assert.deepStrictEqual(Object.keys(env).sort(),
    ['basis', 'card', 'dollars', 'kind', 'label', 'sharedAt', 'v']);
  assert.match(env.basis, /booked ledger/);
  assert.strictEqual(C.envelope(C.build('symbols', source(), {})).basis, 'broker-accepted fills');
});
