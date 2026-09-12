'use strict';
/**
 * routes/trading/import.js — put the reader's own broker trades in their journal (#3557).
 *
 * Loop stage: Observe. The journal reads `event:'exit'` rows from the trades ledger, and
 * until now only the autopilot wrote them — which is `minPlan:"pilot"`. Everyone below
 * that trades by hand and saw an empty journal. This imports what their connected broker
 * already knows into the same ledger, so every card works unchanged.
 *
 *   GET  /api/trading/import  → { available, broker, imported, lastImportAt }
 *   POST /api/trading/import  → runs one import → { ok, fills, closedTrades, imported, ... }
 *
 * Signed-in only, and only ever the reader's own account: the user id is taken from the
 * session, never from the request body, so there is no shape of this call that imports
 * somebody else's trades.
 */

const fs = require('fs');
const brokerImport = require('../../lib/broker-import');
const alpaca = require('../../lib/alpaca-adapter');
const { getEffectiveUserId } = require('../../lib/session-identity');
const { internalUserId } = require('../../lib/request-auth');

const PATH = '/api/trading/import';

/* Same scoping rule as the scorecard and track-record routes, so an import lands in the
   same book the journal reads back. A box with the login gate off has one owner. */
function readerId(req) {
  const id = getEffectiveUserId(req) || internalUserId(req);
  if (id) return id;
  try { return require('../../lib/auth-middleware').loginGateEnabled() ? null : 'local-owner'; } catch (_e) { return null; }
}

/** What is already on record from an import, and when it last ran. */
function importStatus(userId, logPath = brokerImport.TRADES_LOG) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_e) { return { imported: 0, lastImportAt: null }; }
  let imported = 0, last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch (_e) { continue; }
    if (!row || row.event !== 'exit' || row.source !== 'broker-import') continue;
    if (userId != null && row.user != null && String(row.user) !== String(userId)) continue;
    imported += 1;
    if (row.ts && (!last || row.ts > last)) last = row.ts;
  }
  return { imported, lastImportAt: last };
}

module.exports = async function importRoutes(req, res, url, ctx) {
  if (url.pathname !== PATH) return false;
  const { sendJson } = ctx;
  const userId = readerId(req);

  if (req.method === 'GET') {
    if (!userId) { sendJson(res, { available: false, reason: 'not_signed_in' }, 200); return true; }
    let connected = false;
    try { connected = alpaca.available(userId); } catch (_e) { connected = false; }
    sendJson(res, {
      available: connected,
      broker: connected ? 'alpaca' : null,
      // IBKR has no execution-history call in its client yet, so say so rather than
      // letting a connected IBKR user press a button that quietly finds nothing.
      reason: connected ? null : 'no_broker_with_history',
      ...importStatus(userId),
    }, 200);
    return true;
  }

  if (req.method === 'POST') {
    if (!userId) { sendJson(res, { ok: false, error: 'not_signed_in' }, 401); return true; }
    let connected = false;
    try { connected = alpaca.available(userId); } catch (_e) { connected = false; }
    if (!connected) { sendJson(res, { ok: false, error: 'no_broker' }, 400); return true; }
    try {
      const result = await brokerImport.importForUser(userId, {
        fetchFills: brokerImport.alpacaFetcher(alpaca),
      });
      sendJson(res, result, result.ok ? 200 : 502);
    } catch (e) {
      sendJson(res, { ok: false, error: 'import_failed', message: e.message }, 500);
    }
    return true;
  }

  sendJson(res, { error: 'method_not_allowed' }, 405);
  return true;
};
module.exports.importStatus = importStatus;
