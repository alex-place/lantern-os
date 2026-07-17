'use strict';
/**
 * routes/trading/brake.js — streaming brake-monitor status for the trader UI.
 *
 * Loop stage: Verify. Thin HTTP surface over lib/brake-monitor.js — the
 * ADR-0028 Phase-2 overlay's intraday risk monitor (vol targeting ×
 * 6-mo trend gate × drawdown taper, gross clamped [0, 2×]). ADVISORY/PAPER
 * ONLY: the monitor computes and streams brake state and marks a virtual
 * $25k book; NOTHING here places orders (Act stays behind the ADR-0020 gates).
 *
 *   GET /api/trading/brake/status
 *     → full monitor status + the last 50 gross-target changes (the "stream"
 *       the Advisor tab polls). Market math only — no account or auth-
 *       sensitive data — available to signed-in users like other trading GETs.
 */

const brakeMonitor = require('../../lib/brake-monitor');

module.exports = async function brakeRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/brake/status' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  sendJson(res, brakeMonitor.getStatus({ historyLimit: 50 }), 200);
  return true;
};
