'use strict';

/**
 * journal-coach.js — what the record says about the reader, with the receipts (#3560).
 *
 * THE FINDINGS ARE COMPUTED, NOT GENERATED. A model let loose on somebody's P&L will
 * produce fluent sentences containing numbers that are not in the record, and a trader
 * cannot tell the difference by reading. So every claim here is derived deterministically
 * from figures already on the page, carries the figures it was derived from, and is
 * testable. `phrase()` may hand those findings to a model to read more like a person —
 * but `verifyText` rejects any sentence containing a number the findings do not contain,
 * and the deterministic wording stands instead. The model can change the words. It cannot
 * change what is claimed.
 *
 * A CLAIM NEEDS MORE SUPPORT THAN A FIGURE. The cards mark a slice "thin" below five
 * trades; that is the bar for SHOWING a number. Asserting a conclusion about someone's
 * trading is a stronger act, so it takes a stronger sample — and where there is not one,
 * the honest output is "not enough trades to say", not a hedged version of the claim.
 *
 * IT IS NOT ADVICE. Every finding is a statement about what already happened in this
 * reader's own record. Nothing here recommends a trade, a position size, or a security.
 */

const MIN_BOOK = 20;      // below this, the record cannot support any claim at all
const MIN_GROUP = 8;      // a symbol or an hour needs this many before it is a pattern
const MIN_TAG = 6;        // the reader's own words need fewer: they chose the grouping
const MIN_R = 15;         // R claims need a real distribution behind them
/* A finding has to be MATERIAL, not merely negative. The worst hour of somebody's week
   is always some hour, and reporting "your worst hour costs you $1.25 a trade" as though
   it were a discovery trains a reader to ignore the card. A group has to be losing a
   meaningful share of what a trade is worth in this book before it is worth saying. */
const MATERIAL = 0.15;

const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (v) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2);
const pct = (v) => v.toFixed(1) + '%';
const rr = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + 'R';

/** A finding carries its own evidence, because a claim without it is just an opinion. */
function _finding(id, kind, claim, evidence, n, priority) {
  return { id, kind, claim, evidence, n, priority };
}

/**
 * Every claim the record supports, best-supported and most actionable first.
 *
 * `data` is what the journal already computes: the scorecard, the per-symbol and
 * weekday-hour slices, the R distribution, and the reader's own tag statistics.
 */
function findings(data = {}) {
  const s = (data.scorecard && (data.scorecard.confirmed || data.scorecard)) || {};
  const trades = _n(s.trades) || 0;

  // Below the floor there is exactly one honest thing to say.
  if (trades < MIN_BOOK) {
    return [_finding('thin-book', 'refusal',
      'Not enough closed trades yet to say anything about how you trade. '
      + trades + ' of the ' + MIN_BOOK + ' this needs.',
      [{ label: 'Closed trades', value: String(trades) }], trades, 0)];
  }

  const out = [];
  /* What a trade is worth in this book, either way -- the yardstick a finding has to
     clear to be worth a reader's attention. */
  const _wr = (_n(s.winRate) || 0) / 100;
  const typical = Math.abs((_n(s.avgWin) || 0) * _wr) + Math.abs((_n(s.avgLoss) || 0) * (1 - _wr));
  const material = (exp) => typical <= 0 || Math.abs(exp) >= typical * MATERIAL;

  /* The reader's own words first: they chose the grouping, so a pattern in it is a
     pattern in how they think, which is the part no statistic can reach on its own. */
  for (const tag of (data.tags && data.tags.tags) || []) {
    const n = _n(tag.trades) || 0;
    const exp = _n(tag.expectancy);
    if (n < MIN_TAG || exp == null || !material(exp)) continue;
    if (exp < 0) {
      out.push(_finding('tag-' + tag.key, 'tag',
        'Every time you tag a trade "' + tag.key + '" it costs you on average. '
        + n + ' of them, ' + pct(_n(tag.winRate) || 0) + ' of them winners, ' + money(exp) + ' a trade.',
        [{ label: 'Trades tagged ' + tag.key, value: String(n) },
         { label: 'Win rate', value: pct(_n(tag.winRate) || 0) },
         { label: 'Per trade', value: money(exp) }], n, 10));
    } else if (exp > 0 && n >= MIN_TAG) {
      out.push(_finding('tag-good-' + tag.key, 'tag',
        'Trades you tag "' + tag.key + '" are your best ones: ' + n + ' of them at ' + money(exp) + ' a trade.',
        [{ label: 'Trades tagged ' + tag.key, value: String(n) },
         { label: 'Per trade', value: money(exp) }], n, 30));
    }
  }

  /* Being right often and paid badly is the failure mode a win rate hides, and the one
     a trader is least likely to see in their own record. */
  const winRate = _n(s.winRate);
  const avgWin = _n(s.avgWin);
  const avgLoss = _n(s.avgLoss);
  if (winRate != null && avgWin != null && avgLoss != null && Math.abs(avgLoss) > 0) {
    const payoff = avgWin / Math.abs(avgLoss);
    if (winRate >= 55 && payoff < 1) {
      out.push(_finding('payoff', 'structure',
        'You are right more often than you are paid for it: ' + pct(winRate) + ' of your trades win, '
        + 'but the average winner (' + money(avgWin) + ') is smaller than the average loser ('
        + money(avgLoss) + ').',
        [{ label: 'Win rate', value: pct(winRate) },
         { label: 'Average win', value: money(avgWin) },
         { label: 'Average loss', value: money(avgLoss) }], trades, 20));
    } else if (winRate < 45 && payoff > 1.5) {
      out.push(_finding('payoff-inverse', 'structure',
        'You lose more often than you win — ' + pct(winRate) + ' — and it still works, because the '
        + 'average winner (' + money(avgWin) + ') is far bigger than the average loser (' + money(avgLoss) + ').',
        [{ label: 'Win rate', value: pct(winRate) },
         { label: 'Average win', value: money(avgWin) },
         { label: 'Average loss', value: money(avgLoss) }], trades, 25));
    }
  }

  /* The same asymmetry measured against the risk actually taken, where it is recorded. */
  const r = (data.rdist && (data.rdist.confirmed || data.rdist)) || {};
  if ((_n(r.withR) || 0) >= MIN_R && _n(r.avgWinR) != null && _n(r.avgLossR) != null) {
    const winR = _n(r.avgWinR), lossR = _n(r.avgLossR);
    if (Math.abs(lossR) > winR) {
      out.push(_finding('r-skew', 'structure',
        'Measured against the risk you opened with, your losers are bigger than your winners: '
        + rr(winR) + ' against ' + rr(lossR) + ' over ' + r.withR + ' trades.',
        [{ label: 'Average win', value: rr(winR) },
         { label: 'Average loss', value: rr(lossR) },
         { label: 'Trades with a recorded stop', value: String(r.withR) }], r.withR, 22));
    }
  }

  /* One symbol quietly paying for the rest. */
  const symbols = Object.entries((data.bySymbol && data.bySymbol.confirmed) || {})
    .map(([key, v]) => ({ key, ...v }))
    .filter((x) => (_n(x.trades) || 0) >= MIN_GROUP && _n(x.expectancy) != null)
    .sort((a, b) => a.expectancy - b.expectancy);
  if (symbols.length && symbols[0].expectancy < 0 && material(symbols[0].expectancy)) {
    const w = symbols[0];
    out.push(_finding('symbol-' + w.key, 'where',
      w.key + ' is the one that costs you: ' + w.trades + ' trades, ' + pct(_n(w.winRate) || 0)
      + ' winners, ' + money(w.expectancy) + ' a trade.',
      [{ label: 'Symbol', value: w.key },
       { label: 'Trades', value: String(w.trades) },
       { label: 'Win rate', value: pct(_n(w.winRate) || 0) },
       { label: 'Per trade', value: money(w.expectancy) }], w.trades, 40));
  }

  /* A weekday and hour together, because either alone can hide it. */
  const cells = Object.entries((data.byWeekdayHour && data.byWeekdayHour.confirmed) || {})
    .map(([key, v]) => ({ key, ...v }))
    .filter((x) => (_n(x.trades) || 0) >= MIN_GROUP && _n(x.expectancy) != null)
    .sort((a, b) => a.expectancy - b.expectancy);
  if (cells.length && cells[0].expectancy < 0 && material(cells[0].expectancy)) {
    const w = cells[0];
    out.push(_finding('when-' + w.key.replace(/[^A-Za-z0-9]/g, '-'), 'when',
      w.key + ' is your worst hour of the week: ' + w.trades + ' trades at ' + money(w.expectancy) + ' each.',
      [{ label: 'When', value: w.key },
       { label: 'Trades', value: String(w.trades) },
       { label: 'Per trade', value: money(w.expectancy) }], w.trades, 45));
  }

  /* Having given back more than you kept is a fact about the path, not the total, and
     the total is the only part most people look at. */
  const net = _n(s.totalRealized);
  const dd = _n(data.maxDrawdown && data.maxDrawdown.amount);
  if (net != null && dd != null && dd > 0 && net > 0 && dd >= net) {
    out.push(_finding('drawdown', 'path',
      'At your worst point you were down ' + money(-dd) + ', which is more than the '
      + money(net) + ' the whole record has made. The total hides the ride.',
      [{ label: 'Worst drawdown', value: money(-dd) },
       { label: 'Net', value: money(net) }], trades, 35));
  }

  out.sort((a, b) => a.priority - b.priority || b.n - a.n);
  return out;
}

/** The deterministic reading — always available, and the fallback when a model is not. */
function plainText(list) {
  if (!list.length) return 'Nothing in your record stands out yet. That is not a complaint.';
  return list.map((f) => f.claim).join(' ');
}

/**
 * Every number a finding vouches for, as the strings a reader would see.
 * Used to check a model's phrasing rather than trusting it.
 */
function vouchedNumbers(list) {
  const ok = new Set();
  for (const f of list) {
    for (const e of f.evidence) {
      const v = String(e.value);
      ok.add(v);
      // The same figure written the ways prose writes it: $1,234.50, 1234.5, 55%, 55.
      for (const m of v.matchAll(/-?\d[\d,]*\.?\d*/g)) {
        const raw = m[0].replace(/,/g, '');
        ok.add(raw);
        ok.add(raw.replace(/^-/, ''));
        const num = Number(raw);
        if (Number.isFinite(num)) {
          ok.add(String(num));
          ok.add(String(Math.abs(num)));
          ok.add(num.toFixed(0));
          ok.add(Math.abs(num).toFixed(0));
          ok.add(num.toFixed(1));
          ok.add(Math.abs(num).toFixed(1));
          ok.add(num.toFixed(2));
          ok.add(Math.abs(num).toFixed(2));
        }
      }
    }
  }
  return ok;
}

/**
 * Does this text only contain figures the findings vouch for?
 *
 * The point is narrow and deliberate: a model may rewrite the sentences, but the moment
 * it produces a number nobody computed, the text is discarded. That is the difference
 * between a coach that reads your record back to you and one that makes things up in your
 * own voice, and a reader cannot tell those apart by looking.
 */
function verifyText(text, list) {
  const vouched = vouchedNumbers(list);
  const bad = [];
  for (const m of String(text || '').matchAll(/-?\$?\d[\d,]*\.?\d*%?/g)) {
    const token = m[0];
    const bare = token.replace(/[$,%]/g, '');
    if (!bare || vouched.has(bare) || vouched.has(token)) continue;
    const num = Number(bare);
    // Small counting words ("one of them", "3 trades") are not claims about the record.
    if (Number.isFinite(num) && Number.isInteger(num) && Math.abs(num) <= 2) continue;
    bad.push(token);
  }
  return { ok: bad.length === 0, unvouched: bad };
}

/** The prompt: findings in, prose out, and nothing else permitted in. */
function buildPrompt(list) {
  const lines = list.map((f, i) => {
    const ev = f.evidence.map((e) => e.label + ': ' + e.value).join(', ');
    return (i + 1) + '. ' + f.claim + '  [' + ev + ']';
  }).join('\n');
  return [
    'You are reading a trader\'s own journal back to them. Below are findings that have',
    'already been computed from their record. Rewrite them as a short, plain paragraph —',
    'at most four sentences — in the second person.',
    '',
    'Rules, and they are absolute:',
    '- Use ONLY the numbers given below. Do not calculate, round differently, or introduce',
    '  any figure that is not written here.',
    '- Do not give advice, and do not recommend any trade, size or security. You are',
    '  describing what already happened, not what to do next.',
    '- Do not add encouragement, and do not soften a finding.',
    '- No preamble, no heading, no list. One paragraph.',
    '',
    'Findings:',
    lines,
  ].join('\n');
}

module.exports = {
  findings, plainText, buildPrompt, verifyText, vouchedNumbers,
  MIN_BOOK, MIN_GROUP, MIN_TAG, MIN_R, MATERIAL,
};
