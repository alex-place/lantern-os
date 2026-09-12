'use strict';

/**
 * broker-import.js — put a manual trader's own trades in their journal (#3557).
 *
 * The journal reads one thing: `event:'exit'` rows in the trades ledger. Until now only
 * the autopilot ever wrote them, and the autopilot is `minPlan:"pilot"` — so every user
 * below $200/mo, who trades through unisona by hand, opened the journal to an empty page.
 *
 * This fills the SAME ledger from the broker they have already connected, so every card
 * built on it works on an imported trade without knowing the difference.
 *
 * NOT written through auto-trader's logTrade, deliberately. That path stamps the acting
 * user, and hooks every row into the convergence store as a falsifiable claim the trader
 * made. An imported trade is history the user made; grading it as one of the engine's own
 * predictions would corrupt the record that store exists to keep.
 *
 * IDEMPOTENT ON order_id. A trade is identified by its closing fill, which is the broker's
 * own order id — the same id the autopilot writes when it closes a position. So importing
 * twice changes nothing, and a trade the autopilot already journaled is skipped rather
 * than double-counted.
 */

const fs = require('fs');
const path = require('path');
const { roundTrips, toLedgerRow } = require('./round-trips');

const TRADES_LOG = process.env.TRADER_TRADES_LOG
  ? path.resolve(process.env.TRADER_TRADES_LOG)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');

/** Every exit already on record for this user, by the id that identifies its close. */
function existingExitIds(userId, logPath = TRADES_LOG) {
  const ids = new Set();
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_e) { return ids; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch (_e) { continue; }
    if (!row || row.event !== 'exit' || !row.order_id) continue;
    // Another user's row is not this user's trade, even with the same broker order id.
    if (userId != null && row.user != null && String(row.user) !== String(userId)) continue;
    ids.add(String(row.order_id));
  }
  return ids;
}

/**
 * Pure: which of these round trips are new, and the rows to write for them.
 * Separated from the file so the decision is testable without a ledger or a broker.
 */
function planImport(trips, existingIds, userId, source = 'broker-import') {
  const rows = [];
  const skipped = [];
  const seen = new Set();
  for (const trip of trips || []) {
    const id = trip && trip.order_id != null ? String(trip.order_id) : null;
    // A trade whose close we cannot identify cannot be de-duplicated, and importing it
    // would add a copy on every run. Refusing it is the honest failure.
    if (!id) { skipped.push({ reason: 'no_id', trip }); continue; }
    if (existingIds.has(id) || seen.has(id)) { skipped.push({ reason: 'already_have', order_id: id }); continue; }
    seen.add(id);
    rows.push(toLedgerRow(trip, userId, source));
  }
  return { rows, skipped };
}

function appendRows(rows, logPath = TRADES_LOG) {
  if (!rows.length) return 0;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

/**
 * Import one user's fills.
 *
 * `fetchFills` is injected so this is exercised end to end in a test without a broker,
 * and so a second broker is a new fetcher rather than a second importer.
 */
async function importForUser(userId, { fetchFills, logPath = TRADES_LOG, source = 'broker-import' } = {}) {
  if (!userId) return { ok: false, error: 'no_user' };
  if (typeof fetchFills !== 'function') return { ok: false, error: 'no_source' };

  let fills = [];
  try {
    fills = await fetchFills(userId);
  } catch (e) {
    // A broker that is down must not look like a user with no trades.
    return { ok: false, error: 'fetch_failed', message: e && e.message };
  }
  if (!Array.isArray(fills)) return { ok: false, error: 'fetch_failed', message: 'not a list of fills' };

  const { trades, open } = roundTrips(fills);
  const existing = existingExitIds(userId, logPath);
  const { rows, skipped } = planImport(trades, existing, userId, source);
  const imported = appendRows(rows, logPath);

  return {
    ok: true,
    fills: fills.length,
    closedTrades: trades.length,
    imported,
    // Everything already on record — the number that should be equal to closedTrades on
    // a second run, and is how "importing twice is a no-op" is observable from outside.
    alreadyHad: skipped.filter((s) => s.reason === 'already_have').length,
    unidentifiable: skipped.filter((s) => s.reason === 'no_id').length,
    // Still-open positions are reported, never journaled: they have not made or lost
    // anything yet, and counting them books profit that has not happened.
    stillOpen: open,
  };
}

/**
 * Alpaca's fill history. Paged, because a single page is 100 fills and a backfill that
 * silently stops at the hundredth most recent one would look like a complete import.
 */
function alpacaFetcher(alpaca, { maxPages = 20 } = {}) {
  return async function fetchAlpacaFills(userId) {
    if (!alpaca || typeof alpaca.getFillActivities !== 'function') return [];
    const out = [];
    let pageToken = null;
    for (let page = 0; page < maxPages; page++) {
      const batch = await alpaca.getFillActivities(userId, 100, pageToken);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch.map((a) => ({
        id: a.id, symbol: a.symbol, side: a.side, qty: a.qty,
        price: a.filled_avg_price, at: a.filled_at || a.created_at,
      })));
      if (batch.length < 100) break;
      // Alpaca pages activities by the id of the last row seen.
      const last = batch[batch.length - 1];
      const next = last && (last.activityId || last.id);
      if (!next || next === pageToken) break;      // no cursor, or it stopped moving
      pageToken = next;
    }
    return out;
  };
}

module.exports = { importForUser, planImport, existingExitIds, appendRows, alpacaFetcher, TRADES_LOG };
