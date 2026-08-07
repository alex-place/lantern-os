'use strict';

/**
 * fill-ledger.js — exits recorded from BROKER FILLS, not from the engine's intent.
 *
 * WHY THIS EXISTS. The ledger was written at order-PLACEMENT time, using the
 * position's last mark as the exit price. Across 2026-08-05..07 that was wrong
 * in both directions, every session:
 *
 *   UNDERSTATED LOSSES — a stop-out was reconstructed from a mark, not the fill.
 *     2026-08-07 XLK: ledger -$319.62 (mark 187.56), actual -$641.62 (fill
 *     186.65). Every stop that week was understated by 30-60%.
 *
 *   OVERSTATED GAINS — an exit ORDER that never filled was still logged as a
 *     completed exit. 2026-08-07 QQQ: two zone_r2 rows (+$183.00 and +$270.54)
 *     for ONE position; the second sell was cancelled unfilled. Real result
 *     +$217.42, ledger +$453.54.
 *
 *   DROPPED TRADES — a fast stop-out could vanish entirely if the position was
 *     never captured between scans (2026-08-06 SOXL, -$590, no row at all).
 *
 * The ledger is what the report, the scorecard and any future calibration read,
 * so a ledger that is wrong in both directions makes every downstream number
 * guesswork. This module makes the BROKER the source of truth: an exit row is
 * written when, and only when, a sell actually filled, priced at the fill.
 *
 * Pure functions + an explicit "already logged" set, so the decision logic is
 * testable without a broker.
 */

/** Is this order a real, filled reduction of a long? */
function isFilledSell(o) {
  if (!o) return false;
  const side = String(o.side || '').toUpperCase();
  if (side !== 'SELL') return false;
  return Number(o.filledQty) > 0;
}

/**
 * Broker orders -> exit rows that are NOT yet in the ledger.
 *
 * @param orders      broker order list (getIBKROpenOrders shape)
 * @param loggedIds   Set of order ids already written
 * @param entryFor    (symbol) -> { avg_entry_price, reason } best-known entry
 * @returns array of ledger rows (event:'exit', source:'fill')
 */
function newExitRows(orders, loggedIds, entryFor) {
  const out = [];
  for (const o of orders || []) {
    if (!isFilledSell(o)) continue;
    const id = String(o.orderId ?? o.order_id ?? '');
    if (!id || loggedIds.has(id)) continue;

    const qty = Number(o.filledQty);
    const exitPx = Number(o.avgPrice ?? o.avg_price);
    if (!(qty > 0) || !(exitPx > 0)) continue;      // no price -> cannot price the trade honestly

    const sym = String(o.symbol || o.ticker || '').toUpperCase();
    const info = (entryFor && entryFor(sym)) || {};
    const entryPx = Number(info.avg_entry_price);
    const havePnl = entryPx > 0;

    out.push({
      event: 'exit',
      symbol: sym,
      qty,
      entry: havePnl ? entryPx : null,
      exit: exitPx,
      // Priced from the FILL. Null (not zero, not a guess) when the entry price
      // is unknown — a wrong number is worse than an absent one.
      pnl: havePnl ? +((exitPx - entryPx) * qty).toFixed(2) : null,
      pnl_pct: havePnl ? +(((exitPx - entryPx) / entryPx) * 100).toFixed(6) : null,
      reason: info.reason || o.exitReason || 'broker fill',
      order_id: id,
      order_type: o.orderType || null,
      status: 'filled',
      source: 'fill',
    });
  }
  return out;
}

/**
 * Order ids that should be remembered as logged. Includes CANCELLED/inactive
 * sells so a never-filled order can never later be mistaken for an exit, and so
 * the set does not grow without bound across a session.
 */
function idsToRemember(orders) {
  const ids = [];
  for (const o of orders || []) {
    const id = String((o && (o.orderId ?? o.order_id)) ?? '');
    if (!id) continue;
    const side = String(o.side || '').toUpperCase();
    if (side !== 'SELL') continue;
    const st = String(o.status || '').toLowerCase();
    if (Number(o.filledQty) > 0 || st.includes('cancel') || st.includes('inactive')) ids.push(id);
  }
  return ids;
}

module.exports = { newExitRows, idsToRemember, isFilledSell };
