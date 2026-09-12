'use strict';

/**
 * round-trips.js — fills in, trades out (#3557).
 *
 * A broker reports FILLS: "bought 10 AAPL at 150", "sold 4 at 153", "sold 6 at 155".
 * A journal needs TRADES: one row saying you were long AAPL and made $34 on it. Nothing
 * in the product turned one into the other, which is why a journal built on the
 * autopilot's own ledger shows a manual trader nothing at all.
 *
 * WHAT COUNTS AS ONE TRADE. Flat to flat. A trader who scales into a position over three
 * fills and out over two thinks of that as one trade, and says so when you ask them; FIFO
 * lot-matching would call it up to six. So the position is tracked from the fill that
 * takes it off zero to the fill that returns it to zero, and the entry and exit prices
 * are quantity-weighted averages of the fills on each side. That also matches the shape
 * the ledger already stores — one row per closed position.
 *
 * A fill that carries the position THROUGH zero (long 10, sell 15) is split: it closes
 * the long for 10 and opens a short for 5. Handling that is the difference between a
 * correct record and one that silently prices a reversal as a single impossible trade.
 *
 * Shorts are supported because a broker will report them whether or not our own strategy
 * takes them: a short's profit is entry minus exit.
 *
 * Deliberately NOT here: fees and commissions. Alpaca's FILL activities do not carry
 * them, so subtracting a guess would make the P&L look precise and be wrong. When a
 * broker gives them, they belong in this shape as their own field, not folded silently
 * into the price.
 */

const SIDES = { buy: 1, sell: -1 };

function _num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A fill we can actually price. Anything else is dropped rather than guessed at. */
function _clean(f) {
  if (!f) return null;
  const dir = SIDES[String(f.side || '').toLowerCase()];
  const qty = _num(f.qty);
  const price = _num(f.price != null ? f.price : f.filled_avg_price);
  const symbol = String(f.symbol || '').toUpperCase().trim();
  if (!dir || !symbol || !(qty > 0) || !(price > 0)) return null;
  const at = f.at || f.filled_at || f.transaction_time || null;
  const t = at ? Date.parse(at) : NaN;
  return {
    id: f.id != null ? String(f.id) : null,
    symbol,
    dir,
    qty,
    price,
    at: at || null,
    t: Number.isFinite(t) ? t : 0,
  };
}

/* Weighted mean price of one side of a position. The whole point of tracking legs. */
function _vwap(legs) {
  let q = 0, notional = 0;
  for (const l of legs) { q += l.qty; notional += l.qty * l.price; }
  return q > 0 ? notional / q : 0;
}

const _round = (n, p = 2) => Math.round(n * Math.pow(10, p)) / Math.pow(10, p);

function _close(open, symbol) {
  const qty = _round(open.closedQty, 6);
  const entry = _vwap(open.openLegs);
  const exit = _vwap(open.closeLegs);
  const long = open.dir === 1;
  const pnl = (long ? (exit - entry) : (entry - exit)) * qty;
  const cost = entry * qty;
  return {
    symbol,
    side: long ? 'long' : 'short',
    qty,
    entry: _round(entry, 4),
    exit: _round(exit, 4),
    pnl: _round(pnl),
    // Percent move on the capital at risk, signed by whether the trade made money —
    // a short that falls 2% is +2%, not -2%.
    pnl_pct: cost > 0 ? _round((pnl / cost) * 100, 6) : null,
    openedAt: open.openedAt,
    closedAt: open.closedAt,
    openFills: open.openLegs.length,
    closeFills: open.closeLegs.length,
    // The closing fill's id identifies the trade, because that is the one moment the
    // trade exists as a finished thing. Stable across re-imports, which is what makes
    // importing twice a no-op rather than a doubling.
    order_id: open.closeLegs.length ? open.closeLegs[open.closeLegs.length - 1].id : null,
    openOrderIds: open.openLegs.map((l) => l.id).filter(Boolean),
  };
}

/**
 * Fills → closed round trips, oldest close first.
 *
 * Returns `{ trades, open }` — `open` being the positions still running at the end of the
 * feed, which are NOT trades and must never be journaled as if they were. A journal that
 * counts an open position as a closed one reports profit that has not happened.
 */
function roundTrips(fills) {
  const clean = [];
  for (const f of fills || []) {
    const c = _clean(f);
    if (c) clean.push(c);
  }
  // A broker's history commonly arrives newest-first, and a page boundary can interleave
  // two symbols out of order. Matching depends entirely on sequence, so sort first.
  clean.sort((a, b) => (a.t - b.t) || String(a.id).localeCompare(String(b.id)));

  const bySymbol = new Map();
  const trades = [];

  for (const f of clean) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, null);
    let open = bySymbol.get(f.symbol);
    let remaining = f.qty;

    while (remaining > 0) {
      if (!open) {
        open = {
          dir: f.dir, qty: 0, closedQty: 0,
          openLegs: [], closeLegs: [],
          openedAt: f.at, closedAt: null,
        };
        bySymbol.set(f.symbol, open);
      }

      if (f.dir === open.dir) {
        // Adding to the position: all of it, always.
        open.openLegs.push({ id: f.id, qty: remaining, price: f.price, at: f.at });
        open.qty = _round(open.qty + remaining, 6);
        remaining = 0;
        break;
      }

      // Reducing it. Only as much as is actually open — the rest reverses.
      const used = Math.min(remaining, open.qty);
      open.closeLegs.push({ id: f.id, qty: used, price: f.price, at: f.at });
      open.qty = _round(open.qty - used, 6);
      open.closedQty = _round(open.closedQty + used, 6);
      open.closedAt = f.at;
      remaining = _round(remaining - used, 6);

      if (open.qty <= 0) {
        trades.push(_close(open, f.symbol));
        open = null;
        bySymbol.set(f.symbol, null);
        // `remaining > 0` here means this fill carried the position through zero; the
        // loop runs again and opens the other direction with what is left.
      }
    }
  }

  const stillOpen = [];
  for (const [symbol, open] of bySymbol) {
    if (open && open.qty > 0) {
      stillOpen.push({
        symbol,
        side: open.dir === 1 ? 'long' : 'short',
        qty: _round(open.qty, 6),
        entry: _round(_vwap(open.openLegs), 4),
        openedAt: open.openedAt,
      });
    }
  }

  return { trades, open: stillOpen };
}

/**
 * A round trip in the shape the journal already reads, so every card built on the
 * autopilot's ledger works on an imported trade without knowing the difference.
 *
 * `status: 'filled'` because these ARE broker fills — the most confirmed a row can be.
 * `source` says where it came from, so an imported trade is always distinguishable from
 * one the autopilot placed. No `stop_dist_pct`: a manual trade has no engine stop, so the
 * R-multiple card will honestly report it as unmeasurable rather than invent a denominator.
 */
function toLedgerRow(trip, userId, source = 'broker-import') {
  return {
    ts: trip.closedAt,
    user: userId,
    event: 'exit',
    symbol: trip.symbol,
    side: trip.side,
    qty: trip.qty,
    entry: trip.entry,
    exit: trip.exit,
    pnl: trip.pnl,
    pnl_pct: trip.pnl_pct,
    reason: 'broker fill',
    order_id: trip.order_id,
    order_type: null,
    status: 'filled',
    source,
    opened_at: trip.openedAt,
  };
}

module.exports = { roundTrips, toLedgerRow, _clean, _vwap };
