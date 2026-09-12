'use strict';
/**
 * test/journal-coach.test.js — #3560.
 *
 * This is the part of the product that tells someone something about their own money, so
 * what is pinned is mostly what it must REFUSE to say: nothing at all on a thin record,
 * nothing about a group too small to be a pattern, and — the one that matters most —
 * no sentence containing a number nobody computed.
 *
 * Run: node --test apps/lantern-garage/test/journal-coach.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const coach = require('../lib/journal-coach');

const book = (o = {}) => Object.assign({
  scorecard: { confirmed: { trades: 60, winRate: 50, avgWin: 100, avgLoss: -100, totalRealized: 500, expectancy: 8.3 } },
  bySymbol: { confirmed: {} },
  byWeekdayHour: { confirmed: {} },
  rdist: { confirmed: { withR: 0 } },
  tags: { tags: [] },
  maxDrawdown: { amount: 0 },
}, o);

const ids = (list) => list.map((f) => f.id);

test('a thin record says so, and says nothing else at all', () => {
  // The bar for SHOWING a figure is five trades. Asserting a conclusion about how
  // somebody trades is a stronger act, so it takes a stronger sample.
  const list = coach.findings(book({ scorecard: { confirmed: { trades: 7, winRate: 100, avgWin: 50, avgLoss: -10 } } }));
  assert.strictEqual(list.length, 1, 'one finding, and it is the refusal');
  assert.strictEqual(list[0].kind, 'refusal');
  assert.match(list[0].claim, /Not enough closed trades/);
  assert.match(list[0].claim, /7 of the 20/);
});

test('an empty record is a refusal too, not a crash', () => {
  assert.strictEqual(coach.findings({})[0].kind, 'refusal');
  assert.strictEqual(coach.findings()[0].kind, 'refusal');
});

test('being right often and paid badly is the finding a win rate hides', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 64, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
  }));
  const f = list.find((x) => x.id === 'payoff');
  assert.ok(f, 'expected the payoff finding, got ' + ids(list).join(','));
  assert.match(f.claim, /right more often than you are paid for it/);
  assert.match(f.claim, /64\.0%/);
  assert.match(f.claim, /\$82\.00/);
  assert.match(f.claim, /-\$140\.00/);
});

test('the inverse shape is reported as working, not as a problem', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 38, avgWin: 300, avgLoss: -100, totalRealized: 400 } },
  }));
  const f = list.find((x) => x.id === 'payoff-inverse');
  assert.ok(f);
  assert.match(f.claim, /and it still works/);
});

test('a healthy book produces neither payoff finding', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 52, avgWin: 150, avgLoss: -100, totalRealized: 900 } },
  }));
  assert.ok(!list.some((f) => f.id.startsWith('payoff')));
});

test('the reader\'s own tags come first, because they chose the grouping', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 64, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
    bySymbol: { confirmed: { TSLA: { trades: 20, winRate: 20, expectancy: -40 } } },
    tags: { tags: [{ key: 'chased', trades: 9, winRate: 11, expectancy: -52.5 }] },
  }));
  assert.strictEqual(list[0].id, 'tag-chased', 'ahead of the structural and symbol findings');
  assert.match(list[0].claim, /"chased"/);
  assert.match(list[0].claim, /-\$52\.50/);
});

test('a tag with too few trades is not a pattern', () => {
  const list = coach.findings(book({ tags: { tags: [{ key: 'rare', trades: 3, winRate: 0, expectancy: -80 } ] } }));
  assert.ok(!ids(list).some((id) => id.includes('rare')), 'three trades is not a finding');
});

test('a good tag is reported too, not only the damning one', () => {
  const list = coach.findings(book({ tags: { tags: [{ key: 'planned', trades: 12, winRate: 75, expectancy: 40 }] } }));
  const f = list.find((x) => x.id === 'tag-good-planned');
  assert.ok(f);
  assert.match(f.claim, /your best ones/);
});

test('the worst symbol and the worst hour are named, once each', () => {
  const list = coach.findings(book({
    bySymbol: { confirmed: {
      TSLA: { trades: 14, winRate: 21, expectancy: -60 },
      NVDA: { trades: 10, winRate: 30, expectancy: -20 },
      AAPL: { trades: 30, winRate: 70, expectancy: 55 },
    } },
    byWeekdayHour: { confirmed: {
      'Mon 09:00 ET': { trades: 11, winRate: 18, expectancy: -75 },
      'Wed 14:00 ET': { trades: 12, winRate: 66, expectancy: 30 },
    } },
  }));
  const sym = list.filter((f) => f.kind === 'where');
  assert.strictEqual(sym.length, 1, 'the worst one, not a list of every loser');
  assert.match(sym[0].claim, /^TSLA is the one that costs you/);
  const when = list.filter((f) => f.kind === 'when');
  assert.strictEqual(when.length, 1);
  assert.match(when[0].claim, /Mon 09:00 ET is your worst hour/);
});

test('a group below the threshold is never named, however bad it looks', () => {
  const list = coach.findings(book({
    bySymbol: { confirmed: { GME: { trades: 4, winRate: 0, expectancy: -900 } } },
    byWeekdayHour: { confirmed: { 'Fri 15:00 ET': { trades: 3, winRate: 0, expectancy: -500 } } },
  }));
  assert.ok(!list.some((f) => f.kind === 'where' || f.kind === 'when'),
    'four trades is a number to show, not a conclusion to draw');
});

test('a book with nothing wrong produces no findings, and says that plainly', () => {
  const list = coach.findings(book());
  assert.deepStrictEqual(list, []);
  assert.match(coach.plainText(list), /Nothing in your record stands out yet/);
});

test('R findings need a real distribution behind them', () => {
  const thin = coach.findings(book({ rdist: { confirmed: { withR: 4, avgWinR: 0.16, avgLossR: -0.25 } } }));
  assert.ok(!thin.some((f) => f.id === 'r-skew'), 'four measured trades is not a distribution');
  const real = coach.findings(book({ rdist: { confirmed: { withR: 40, avgWinR: 0.16, avgLossR: -0.25 } } }));
  const f = real.find((x) => x.id === 'r-skew');
  assert.ok(f);
  assert.match(f.claim, /\+0\.16R/);
  assert.match(f.claim, /-0\.25R/);
});

test('giving back more than you kept is a fact about the path, not the total', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 50, avgWin: 100, avgLoss: -100, totalRealized: 400 } },
    maxDrawdown: { amount: 900 },
  }));
  const f = list.find((x) => x.id === 'drawdown');
  assert.ok(f);
  assert.match(f.claim, /The total hides the ride/);
  assert.ok(!coach.findings(book({ maxDrawdown: { amount: 100 } })).some((x) => x.id === 'drawdown'),
    'a drawdown smaller than the profit is not remarkable');
});

test('every finding carries the figures it was derived from', () => {
  const list = coach.findings(book({
    scorecard: { confirmed: { trades: 60, winRate: 64, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
    tags: { tags: [{ key: 'chased', trades: 9, winRate: 11, expectancy: -52.5 }] },
    bySymbol: { confirmed: { TSLA: { trades: 14, winRate: 21, expectancy: -60 } } },
  }));
  assert.ok(list.length >= 3);
  for (const f of list) {
    assert.ok(Array.isArray(f.evidence) && f.evidence.length, f.id + ' has evidence');
    for (const e of f.evidence) {
      assert.ok(e.label && typeof e.value === 'string', f.id + ' evidence is labelled');
    }
    assert.ok(Number.isFinite(f.n) && f.n > 0, f.id + ' says how many trades it rests on');
  }
});

// ── the guard on a model's phrasing ────────────────────────────────────────────
const withFigures = () => coach.findings(book({
  scorecard: { confirmed: { trades: 60, winRate: 64, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
  tags: { tags: [{ key: 'chased', trades: 9, winRate: 11, expectancy: -52.5 }] },
}));

test('a rephrasing that keeps to the figures is accepted', () => {
  const list = withFigures();
  const text = 'You win 64.0% of the time, but your average winner is $82.00 against an '
    + 'average loser of -$140.00. The 9 trades you tagged chased cost -$52.50 each.';
  assert.deepStrictEqual(coach.verifyText(text, list), { ok: true, unvouched: [] });
});

test('a number nobody computed is rejected, however plausible it reads', () => {
  // This is the whole point. A model that invents "$1,240" in the reader's own voice is
  // indistinguishable from one that did not, unless something checks.
  const list = withFigures();
  const bad = coach.verifyText('You are down $1,240 on the month and your win rate is 71.4%.', list);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.unvouched.some((t) => t.includes('1,240')));
  assert.ok(bad.unvouched.some((t) => t.includes('71.4')));
});

test('arithmetic the model did itself is still a number nobody computed', () => {
  const list = withFigures();
  // 82 - 140 = -58 is "derived from" the figures, and is exactly the kind of quiet
  // invention that has to be caught: nothing on the page says -58.
  assert.strictEqual(coach.verifyText('Your edge is -$58.00 a trade.', list).ok, false);
});

test('small counting words are not claims about the record', () => {
  const list = withFigures();
  assert.strictEqual(coach.verifyText('There are two things worth noticing, and one of them is costly.', list).ok, true);
});

test('the same figure written another way is still the same figure', () => {
  const list = withFigures();
  assert.strictEqual(coach.verifyText('You win 64% of the time at $82 a winner.', list).ok, true,
    'a model dropping a trailing zero has not invented anything');
});

test('the prompt forbids inventing figures and forbids advice', () => {
  const p = coach.buildPrompt(withFigures());
  assert.match(p, /Use ONLY the numbers given below/);
  assert.match(p, /Do not give advice/);
  assert.match(p, /not what to do next/);
  assert.match(p, /chased/, 'and it carries the findings themselves');
  assert.match(p, /Win rate: 64\.0%/, 'with their evidence attached');
});

test('a finding has to be material, not merely the worst of something (#3560)', () => {
  /* The worst hour of somebody's week is always SOME hour. Reporting "your worst hour
     costs you $1.25 a trade" as though it were a discovery trains a reader to ignore the
     card, which is worse than saying nothing. Found on a preview, not by a test. */
  const trivial = coach.findings(book({
    scorecard: { confirmed: { trades: 50, winRate: 72, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
    byWeekdayHour: { confirmed: { 'Wed 13:00 ET': { trades: 8, winRate: 50, expectancy: -1.25 } } },
    bySymbol: { confirmed: { SPY: { trades: 20, winRate: 50, expectancy: -0.9 } } },
  }));
  assert.ok(!trivial.some((f) => f.kind === 'when'), '-$1.25 a trade is not a finding');
  assert.ok(!trivial.some((f) => f.kind === 'where'), 'nor is -$0.90');

  const real = coach.findings(book({
    scorecard: { confirmed: { trades: 50, winRate: 72, avgWin: 82, avgLoss: -140, totalRealized: 400 } },
    byWeekdayHour: { confirmed: { 'Wed 13:00 ET': { trades: 8, winRate: 12, expectancy: -66 } } },
  }));
  assert.ok(real.some((f) => f.kind === 'when'), '-$66 a trade is');
});

test('the materiality floor scales with the book, rather than being a fixed dollar figure', () => {
  // A $2 loss per trade is noise in one book and the whole story in another.
  const small = { confirmed: { trades: 50, winRate: 50, avgWin: 4, avgLoss: -4, totalRealized: 20 } };
  const big = { confirmed: { trades: 50, winRate: 50, avgWin: 400, avgLoss: -400, totalRealized: 2000 } };
  const cell = { confirmed: { 'Mon 10:00 ET': { trades: 10, winRate: 30, expectancy: -2 } } };
  assert.ok(coach.findings(book({ scorecard: small, byWeekdayHour: cell })).some((f) => f.kind === 'when'),
    'half a trade\'s worth matters in a small book');
  assert.ok(!coach.findings(book({ scorecard: big, byWeekdayHour: cell })).some((f) => f.kind === 'when'),
    'and is nothing in a big one');
});
