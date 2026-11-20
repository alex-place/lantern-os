'use strict';
/**
 * routes/trading/chart-trades.js — where the trader got in and out, for the charts.
 *
 * Loop stage: Observe. The trader page draws these on each ticker's chart; the journal
 * is the only source, and this route only reads it (lib/chart-trade-marks).
 *
 *   GET /api/trading/chart-trades
 *     ?symbol=SPY     one symbol (default: every symbol with a trade)
 *     ?have=<version> answer { unchanged: true } when nothing a chart draws has changed
 *
 * PER-READER, like the trade log and the scorecard: the rows of the account asking, and
 * the operator's own book for an admin whose own read is empty. It sits behind the trade
 * entitlement with the rest of /api/trading/* — a signed-out visitor gets no trades.
 *
 * CHEAP TO POLL. The journal grows by a row every scan, almost none of them trades, so
 * the file is re-read at most every REFRESH_MS and the version names the trade rows
 * alone: a page that already has them gets a one-line answer.
 */

const fs = require('fs');
const scorecard = require('../../lib/trader-scorecard');
const { buildTradeMarks, wantRow } = require('../../lib/chart-trade-marks');
const { getEffectiveUserId } = require('../../lib/session-identity');
const { internalUserId } = require('../../lib/request-auth');

const PATH = '/api/trading/chart-trades';
const REFRESH_MS = 10 * 1000;

const scopeFor = (req) => getEffectiveUserId(req) || internalUserId(req) || 'local-owner';

/** Same operator fallback as the trade log: ADMIN ONLY, and only when the read was empty. */
function operatorFallbackUid(req, hadRows) {
  if (hadRows) return null;
  let admin = false;
  try { admin = require('../../lib/auth-middleware').isAdmin(req); } catch (_e) { admin = false; }
  if (!admin) return null;
  return process.env.TRADER_OPERATOR_UID || 'local-owner';
}

/* The trade rows of every ledger in the book, re-read when a file changed and the last
   read is older than REFRESH_MS. Built marks are kept per reader until the next read. */
let _cache = null;   // { sig, at, rows, ledgers, built: Map(uid -> { version, symbols }) }
function _sig(files) {
  return files.map((f) => { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch (_e) { return '-'; } }).join('|');
}
function _book() {
  const primary = scorecard.DEFAULT_LOG;
  const files = [primary, ...scorecard.extraLogsFor(primary)];
  const sig = _sig(files), now = Date.now();
  if (_cache && (_cache.sig === sig || now - _cache.at < REFRESH_MS)) return _cache;
  _cache = { sig, at: now, rows: scorecard.readRows(primary, wantRow), ledgers: files.length, built: new Map() };
  return _cache;
}
function _marksFor(uid) {
  const book = _book();
  let hit = book.built.get(uid);
  if (!hit) {
    const mine = scorecard.forUser(book.rows, uid);
    const last = mine.length ? mine[mine.length - 1] : null;
    hit = {
      rows: mine.length,
      // What a chart draws changes only when a trade row is added.
      version: mine.length + ':' + (last ? String(last.ts) : ''),
      symbols: buildTradeMarks(mine, { ledgers: book.ledgers }),
    };
    book.built.set(uid, hit);
  }
  return { ...hit, ledgers: book.ledgers };
}

module.exports = async function chartTradesRoutes(req, res, url, ctx) {
  if (url.pathname !== PATH || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    let marks = _marksFor(scopeFor(req));
    const alt = operatorFallbackUid(req, marks.rows > 0);
    if (alt) marks = _marksFor(alt);

    if (url.searchParams.get('have') === marks.version) {
      sendJson(res, { version: marks.version, unchanged: true }, 200);
      return true;
    }
    const want = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
    const symbols = want ? (marks.symbols[want] ? { [want]: marks.symbols[want] } : {}) : marks.symbols;
    sendJson(res, { version: marks.version, ledgers: marks.ledgers, symbols }, 200);
  } catch (e) {
    sendJson(res, { error: 'chart_trades_failed', message: e.message }, 500);
  }
  return true;
};
module.exports.PATH = PATH;
module.exports._resetForTests = () => { _cache = null; };
