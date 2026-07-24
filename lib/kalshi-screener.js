"use strict";

/**
 * Kalshi screener — the power-user board, sorted by OUR edge (not just volume).
 *
 * Verso's screener sorts by what *moved* (price change / volume). Ours sorts by what's
 * *mispriced*: it attaches the grounded EDGE (lib/kalshi-edge) to every market and ranks
 * fee-adjusted edge first, so the top of the screen is where our web-grounded P(YES)
 * disagrees with the market past the fee hurdle. Markets we haven't grounded still list
 * (with price/volume) but carry no edge and sink below the grounded ones.
 *
 * buildRows() is pure over its inputs (markets + calibrator) — unit-testable, no I/O.
 */

const { edgeForMarket } = require("./kalshi-edge");

let _getCalibrator = null;
try { _getCalibrator = require("./kalshi-calibration").getCalibrator; } catch { /* optional */ }

// Fee-adjusted edge in cents for a row, or null when the market isn't grounded.
function _edgeCents(row) {
  const e = row.edge;
  return e && e.grounded && Number.isFinite(e.edgeCents) ? e.edgeCents : null;
}

/**
 * @param {object[]} markets  normalized Kalshi markets ({ticker,title,yes_ask,no_ask,volume,close_time,event_ticker})
 * @param {object} [opts]
 *   calibrator   shared calibrator (else built once from kalshi-calibration)
 *   groundedOnly {bool}   keep only markets with a grounded edge
 *   minEdge      {number} keep only grounded rows with edge ≥ this (cents)
 *   q            {string} substring match on title/ticker
 *   category     {string} substring match on event_ticker/category
 *   sort         'edge' (default) | 'volume' | 'close'
 *   limit        {number} max rows returned
 * @returns {object[]} screener rows
 */
function buildRows(markets, opts = {}) {
  const { groundedOnly, minEdge, q, category, sort = "edge", limit } = opts;
  let cal = opts.calibrator || null;
  if (!cal && _getCalibrator) { try { cal = _getCalibrator(); } catch { cal = null; } }

  let rows = (Array.isArray(markets) ? markets : []).filter(Boolean).map((m) => ({
    ticker: m.ticker,
    title: m.title || m.ticker || "",
    category: m.category || m.event_ticker || "",
    close_time: m.close_time || null,
    volume: Number(m.volume ?? m.volume_24h ?? 0) || 0,
    yes_ask: Number.isFinite(m.yes_ask) ? m.yes_ask : null,
    no_ask: Number.isFinite(m.no_ask) ? m.no_ask : null,
    edge: edgeForMarket(m, cal),
  }));

  if (groundedOnly) rows = rows.filter((r) => r.edge && r.edge.grounded);
  if (Number.isFinite(minEdge)) rows = rows.filter((r) => _edgeCents(r) != null && _edgeCents(r) >= minEdge);
  if (q) { const s = String(q).toLowerCase(); rows = rows.filter((r) => (r.title || "").toLowerCase().includes(s) || (r.ticker || "").toLowerCase().includes(s)); }
  if (category) { const c = String(category).toLowerCase(); rows = rows.filter((r) => (r.category || "").toLowerCase().includes(c)); }

  rows.sort((a, b) => {
    if (sort === "volume") return b.volume - a.volume;
    if (sort === "close") return new Date(a.close_time || 8.64e15) - new Date(b.close_time || 8.64e15);
    // default 'edge': grounded/mispriced first (desc), ungrounded sink to the bottom by volume
    const ae = _edgeCents(a), be = _edgeCents(b);
    if (ae == null && be == null) return b.volume - a.volume;
    if (ae == null) return 1;
    if (be == null) return -1;
    return be - ae;
  });

  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

module.exports = { buildRows, _edgeCents };
