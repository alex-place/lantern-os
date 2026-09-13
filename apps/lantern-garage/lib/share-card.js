'use strict';
/**
 * share-card.js — the only thing that decides what leaves a reader's journal (#3562).
 *
 * Sharing is the one feature in this set that PUBLISHES A READER'S MONEY TO THE INTERNET,
 * so it gets the smallest surface of the lot and this file is where that smallness lives.
 *
 * AN ALLOW-LIST, NOT A FILTER. A shared card is built by naming every field that may
 * appear and copying only those. The alternative — take the card and strip what is
 * private — fails the moment anything upstream gains a field, and it fails silently, in
 * the direction of publishing more. Here a new field is invisible until somebody adds it
 * to a list on purpose. Nested shapes (histogram buckets, symbol rows) are allow-listed
 * the same way, because an object copied whole is not an allow-list.
 *
 * THE SERVER RECOMPUTES. The client asks for "my September" and names its options; it
 * does not post figures. A shared card is therefore the reader's actual record rather
 * than whatever a browser sent, which matters because the page carries our name.
 *
 * DOLLARS ARE WITHHELD BY DEFAULT. Every figure denominated in money is opt-in. What is
 * left is ratios, counts and percentages — real answers, not redactions. Nothing is
 * converted to a percentage of an invented base: a month's profit as a percent needs
 * account equity we may not hold, and a fabricated denominator would be worse than an
 * absent number. The R distribution has no money in it at all, which is why it is the
 * card a reader can share with nothing withheld.
 *
 * NOTES AND TAGS ARE NOT SHAREABLE AT ALL. They are private writing about the reader's
 * own money and no option turns them on — they are not in any list here, which is the
 * only way to be sure.
 */

const KINDS = ['rmultiples', 'symbols', 'month'];

/* Per card: the fields that always appear, and the ones that appear only when the reader
   opted into money. A field in NEITHER list cannot reach a shared page. */
const SPEC = {
  rmultiples: {
    label: 'R multiples',
    always: ['n', 'withR', 'coverage', 'width', 'mean', 'median', 'best', 'worst',
      'wins', 'losses', 'avgWinR', 'avgLossR', 'payoff'],
    money: [],
    bucket: ['from', 'to', 'count', 'wins'],
  },
  symbols: {
    label: 'Symbol statistics',
    row: { always: ['symbol', 'trades', 'winRate', 'profitFactor'], money: ['realized'] },
  },
  month: {
    label: 'Monthly report',
    always: ['month', 'tradingDays', 'dayWinRate', 'profitFactor', 'trades', 'winRate'],
    money: ['pnl', 'bestDay', 'worstDay', 'drawdown'],
  },
};

const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Copy exactly the named fields. Anything absent is null, never dropped and never zero. */
function pick(src, names) {
  const out = {};
  for (const k of names) {
    const v = src == null ? undefined : src[k];
    out[k] = (typeof v === 'number') ? _n(v) : (v == null ? null : v);
  }
  return out;
}

const fieldsFor = (spec, dollars) => (spec.always || []).concat(dollars ? (spec.money || []) : []);

/** The R distribution. Dimensionless throughout, so `dollars` changes nothing. */
function shareR(dist) {
  const spec = SPEC.rmultiples;
  const out = pick(dist || {}, spec.always);
  out.buckets = ((dist && dist.buckets) || []).map((b) => pick(b, spec.bucket));
  return out;
}

/**
 * Symbol statistics. The reader's whole tradelist is the card, and they preview it —
 * what they trade is theirs to publish, and a one-symbol version would be contentless.
 */
function shareSymbols(bySymbol, dollars) {
  const spec = SPEC.symbols.row;
  const names = fieldsFor(spec, dollars);
  const rows = [];
  for (const [symbol, s] of Object.entries(bySymbol || {})) {
    // The card's own column is `totalRealized`; the shared name says what it is.
    rows.push(pick({ symbol, trades: _n(s.trades), winRate: _n(s.winRate),
      profitFactor: _n(s.profitFactor), realized: _n(s.totalRealized) }, names));
  }
  rows.sort((a, b) => (b.trades || 0) - (a.trades || 0) || String(a.symbol).localeCompare(String(b.symbol)));
  return rows;
}

/**
 * One month, from the BOOKED ledger.
 *
 * Not the account-equity measure the page can also show: that one is a broker snapshot
 * we cannot reliably reproduce at share time, and a shared figure has to be one we can
 * still stand behind tomorrow. The card says which measure it is.
 */
function monthFromDays(days, month) {
  const rows = (days || []).filter((d) => String(d.date || '').slice(0, 7) === month);
  if (!rows.length) return null;
  let pnl = 0, up = 0, down = 0, best = null, worst = null;
  let grossWin = 0, grossLoss = 0, peak = 0, cum = 0, dd = 0;
  for (const d of rows) {
    const v = _n(d.pnl) || 0;
    pnl += v;
    if (v > 0) { up++; grossWin += v; } else if (v < 0) { down++; grossLoss += -v; }
    if (best == null || v > best) best = v;
    if (worst == null || v < worst) worst = v;
    cum += v;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  const counted = up + down;
  return {
    month,
    tradingDays: rows.length,
    // Of the days that MOVED. A flat day is not a losing day, and counting it as one
    // would quietly drag the figure down.
    dayWinRate: counted ? +((up / counted) * 100).toFixed(1) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    pnl: +pnl.toFixed(2),
    bestDay: best, worstDay: worst, drawdown: +dd.toFixed(2),
  };
}

/**
 * Build one shared card. `src` is what the ROUTE gathered from the reader's own ledger:
 *   { rdist, bySymbol, days, monthStats: { '2026-09': stats, ... } }
 * Returns null for a card the record cannot support, so a share is never created empty.
 */
function build(kind, src, opts) {
  const dollars = !!(opts && opts.dollars);
  if (!KINDS.includes(kind)) return null;

  if (kind === 'rmultiples') {
    const card = shareR(src && src.rdist);
    if (!card.n) return null;
    return { kind, label: SPEC.rmultiples.label, dollars: false, card };
  }

  if (kind === 'symbols') {
    const rows = shareSymbols(src && src.bySymbol, dollars);
    if (!rows.length) return null;
    return { kind, label: SPEC.symbols.label, dollars, card: { rows } };
  }

  const month = String((opts && opts.month) || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const m = monthFromDays(src && src.days, month);
  if (!m) return null;
  /* Keyed BY month, so a caller cannot hand over the whole book's figures for one
     month's card. It did exactly that on the first run: a September card claiming the
     43 trades and 55.8% of a book that starts in August. A shape that cannot express
     the mistake beats remembering not to make it. */
  const stats = ((src && src.monthStats) || {})[month] || {};
  const full = Object.assign({}, m, { trades: _n(stats.trades), winRate: _n(stats.winRate) });
  return { kind, label: SPEC.month.label, dollars,
    card: pick(full, fieldsFor(SPEC.month, dollars)) };
}

/**
 * What a shared card is allowed to say about itself, beyond its figures.
 *
 * Deliberately thin: a date, the measure, and the honesty split. No name, no account, no
 * id, no symbol the reader did not publish. The shared page cannot be walked back to
 * anything else of theirs because there is nothing here to walk back along.
 */
function envelope(built, extra) {
  return {
    v: 1,
    kind: built.kind,
    label: built.label,
    dollars: built.dollars,
    card: built.card,
    basis: built.kind === 'month' ? 'booked ledger, exchange days' : 'broker-accepted fills',
    sharedAt: (extra && extra.sharedAt) || new Date().toISOString(),
  };
}

module.exports = { KINDS, SPEC, build, envelope, shareR, shareSymbols, monthFromDays, pick, fieldsFor };
