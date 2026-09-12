'use strict';

/**
 * trade-log.js — the trades themselves (#3558).
 *
 * The journal has had aggregates since #3543: a calendar, a breakdown, symbol statistics,
 * a monthly rollup, a weekday grid, an R distribution. It has never had the list. There
 * was nowhere to look up one trade you remember making, which is the first thing every
 * competitor's journal shows and the thing every one of those statistics is drawn from.
 *
 * RECONCILES WITH THE SCORECARD, BY CONSTRUCTION. It runs the same `preparedRows`
 * pipeline the headline figures use — the no-fill drop and the duplicate-collapse — so
 * the number of rows in this list is the number of trades the KPI tile claims. A trade
 * log that disagreed with the scorecard above it would make both untrustworthy, and the
 * only way to guarantee it does not is to share the pipeline rather than re-implement it.
 *
 * HONEST ABOUT WHAT IT DOES NOT HAVE. Most of these rows are the autopilot's, and most of
 * those predate the fields that would say how long a position was held or what risk it
 * was opened with. An imported manual trade has no engine exit reason and no excursions
 * at all. Every such field is null rather than zero or blank-as-though-zero, and the card
 * renders null as "not recorded" rather than as a value.
 */

const { readExits, preparedRows, rOf, CONFIRMED } = require('./trader-scorecard');

const SORTS = new Set(['ts', 'pnl', 'pnl_pct', 'r', 'symbol', 'qty']);
const RESULTS = new Set(['all', 'win', 'loss', 'flat']);
const MAX_LIMIT = 200;

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One ledger row as the list shows it. Everything absent is null, never 0. */
function toTrade(row) {
  const pnl = _num(row.pnl);
  const openedAt = row.opened_at || null;
  let heldMs = null;
  if (openedAt && row.ts) {
    const a = Date.parse(openedAt), b = Date.parse(row.ts);
    // A negative hold is a broken record, not a trade held backwards in time.
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) heldMs = b - a;
  }
  return {
    // The broker's order id where there is one. Older autopilot rows have none, so the
    // list falls back to a key built from the close — enough to expand a row and to tell
    // two trades apart, and never presented as if it came from the broker.
    id: row.order_id ? String(row.order_id) : [row.ts, row.symbol, row.qty].join('|'),
    ts: row.ts || null,
    openedAt,
    heldMs,
    symbol: String(row.symbol || '?').toUpperCase(),
    // The autopilot's book is long-only, so an absent side is a long — not unknown.
    side: row.side === 'short' ? 'short' : 'long',
    qty: _num(row.qty),
    entry: _num(row.entry),
    exit: _num(row.exit),
    pnl,
    pnl_pct: _num(row.pnl_pct),
    r: rOf(row),
    reason: row.reason || null,
    source: row.source || null,
    confirmed: CONFIRMED.has(String(row.status || '').toLowerCase()),
    // Priced off the last observed mark rather than a broker fill (an external close).
    estimated: row.estimated === true,
    mfe_pct: _num(row.mfe_pct),
    mae_pct: _num(row.mae_pct),
  };
}

function _matches(t, f) {
  if (f.symbol && t.symbol !== f.symbol) return false;
  if (f.from && (!t.ts || t.ts < f.from)) return false;
  // `to` is a date the reader named, so it includes that whole day rather than midnight.
  if (f.to && (!t.ts || t.ts > f.to + '￿')) return false;
  if (f.result === 'win' && !(t.pnl > 0)) return false;
  if (f.result === 'loss' && !(t.pnl < 0)) return false;
  if (f.result === 'flat' && t.pnl !== 0) return false;
  return true;
}

function _sorted(trades, sort, dir) {
  const key = SORTS.has(sort) ? sort : 'ts';
  const sign = dir === 'asc' ? 1 : -1;
  return trades.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    // A trade with no value for the column sorts last in BOTH directions, so an
    // unmeasurable one never heads the list just because it is empty.
    const xn = x == null, yn = y == null;
    if (xn && yn) return String(a.ts).localeCompare(String(b.ts));
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === 'string') return sign * x.localeCompare(y);
    if (x === y) return String(b.ts).localeCompare(String(a.ts));
    return sign * (x < y ? -1 : 1);
  });
}

/**
 * Pure: rows in, one page of trades out, plus what the whole filtered set looks like.
 *
 * The totals are of the FILTERED set, not the page — a reader who filters to one symbol
 * is asking what that symbol did, and answering with the page they happen to be on would
 * be a different and wrong number.
 */
function buildLog(rows, opts = {}) {
  const view = opts.view === 'all' ? 'all' : 'confirmed';
  const prepared = preparedRows(
    view === 'confirmed'
      ? (rows || []).filter((r) => CONFIRMED.has(String(r.status || '').toLowerCase()))
      : (rows || [])
  );
  const all = prepared.map(toTrade);

  const filter = {
    symbol: opts.symbol ? String(opts.symbol).toUpperCase().trim() : null,
    from: opts.from || null,
    to: opts.to || null,
    result: RESULTS.has(opts.result) ? opts.result : 'all',
  };
  const matched = all.filter((t) => _matches(t, filter));

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const sort = SORTS.has(opts.sort) ? opts.sort : 'ts';
  const dir = opts.dir === 'asc' ? 'asc' : 'desc';
  const page = _sorted(matched, sort, dir).slice(offset, offset + limit);

  let wins = 0, losses = 0, net = 0, withR = 0;
  for (const t of matched) {
    if (t.pnl > 0) wins++; else if (t.pnl < 0) losses++;
    if (t.pnl != null) net += t.pnl;
    if (t.r != null) withR++;
  }

  return {
    trades: page,
    total: matched.length,
    offset,
    limit,
    sort,
    dir,
    view,
    filter,
    // Of everything the filter matched, so a filtered list answers its own question.
    totals: {
      trades: matched.length,
      wins,
      losses,
      net: Math.round(net * 100) / 100,
      // How many of these can show an R at all — the same honesty the R card carries.
      withR,
    },
    // Every symbol in the unfiltered book, so the filter can offer real choices rather
    // than asking the reader to type a ticker exactly right.
    symbols: [...new Set(all.map((t) => t.symbol))].sort(),
  };
}

/** The same, read from a ledger for one user. */
function tradeLog(logPath, userId, opts = {}) {
  return buildLog(readExits(logPath, userId), opts);
}

module.exports = { tradeLog, buildLog, toTrade, SORTS, RESULTS, MAX_LIMIT };
