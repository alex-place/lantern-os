'use strict';
/**
 * routes/trading/options.js — options-chain DATA endpoint for the trader surfaces.
 *
 * Loop stage: Observe. Thin HTTP surface over lib/options-data.js (Alpha Vantage
 * HISTORICAL_OPTIONS, env-gated by ALPHAVANTAGE_API_KEY). Data only: no orders,
 * no scoring, no recommendations — Act stays behind the ADR-0020 trading gates.
 *
 *   GET /api/trading/options/chain?symbol=SPY&date=YYYY-MM-DD
 *
 * Responses are always 200. Keyless / rate-limited / upstream-error states come
 * back as { available: false, reason } — honest degradation, never fake rows.
 */

const optionsData = require('../../lib/options-data');

module.exports = async function optionsRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/options/chain' || req.method !== 'GET') return false;
  const { sendJson } = ctx;

  const symbol = url.searchParams.get('symbol') || '';
  const date = url.searchParams.get('date') || null;

  const out = await optionsData.getOptionsChain(symbol, date ? { date } : {});
  sendJson(res, out, 200);
  return true;
};
