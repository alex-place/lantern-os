'use strict';
/**
 * routes/journal-replay.js — the bars one trade was taken on (#3561).
 *
 * Loop stage: Observe. The journal's other cards are aggregates; this is the one that
 * answers "what did it look like when I took it", which is the only question a
 * discretionary trader can act on. It is free — the autopilot is a $200 tier and the
 * coach is $20, but the readers who most need to see their own setups are the ones
 * placing their own orders.
 *
 *   GET /api/journal/replay?id=<trade id from the trade log>
 *
 * COSTS NOTHING UNTIL OPENED. Nothing here runs on a journal page load; the trade log
 * ships ids and this route is hit once, when a reader asks for one trade.
 *
 * TWO SOURCES, IN THIS ORDER. The bar archive first: it is our own record, it is on disk,
 * and it costs no request. A live windowed fetch second, because the archive only covers
 * the symbols this machine watches and a reader's own book will not be among them. If
 * neither has the window, the reply says which of those two it was — a blank chart and a
 * chart we could not fetch look identical, and only one of them means "try another
 * trade".
 */

const replay = require('../lib/trade-replay');
const barWindow = require('../lib/bar-window');
const { findTrade } = require('../lib/trade-log');
const { readExits, readEvents } = require('../lib/trader-scorecard');
const { getEffectiveUserId } = require('../lib/session-identity');
const { internalUserId } = require('../lib/request-auth');

const PATH = '/api/journal/replay';

function _json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// The same scoping as the trade log and the scorecard, so a replay is drawn from the
// same book as the row that opened it.
const scopeFor = (req) => getEffectiveUserId(req) || internalUserId(req) || 'local-owner';

/** Admin-only, and only when the read was empty — matched to routes/trading/trades.js. */
function operatorFallbackUid(req, hadRows) {
  if (hadRows) return null;
  let admin = false;
  try { admin = require('../lib/auth-middleware').isAdmin(req); } catch (_e) { admin = false; }
  if (!admin) return null;
  return process.env.TRADER_OPERATOR_UID || 'local-owner';
}

module.exports = async function journalReplayRoutes(req, res, url) {
  if (url.pathname !== PATH) return false;
  if (req.method !== 'GET') { _json(res, 405, { error: 'method_not_allowed' }); return true; }

  const id = url.searchParams.get('id');
  if (!id) { _json(res, 400, { error: 'missing_id' }); return true; }

  // The demo book is SIMULATED — invented fills at invented prices on real tickers.
  // Drawing SPY's real bars under them would be the one dishonesty this whole card is
  // built to avoid, so the demo says so instead.
  if (url.searchParams.get('demo') === 'champion') {
    _json(res, 200, {
      trade: null, bars: [], marks: {}, coverage: 'none', source: 'demo',
      why: 'These are simulated trades, so there is no chart behind them. Sign in and'
        + ' replay your own and the bars are real.',
    });
    return true;
  }

  try {
    let uid = scopeFor(req);
    let exits = readExits(undefined, uid);
    const alt = operatorFallbackUid(req, exits.length > 0);
    if (alt) { uid = alt; exits = readExits(undefined, uid); }

    const found = findTrade(exits, id);
    if (!found) { _json(res, 404, { error: 'no_such_trade' }); return true; }
    const { trade, row } = found;

    // The opening is recovered from the ledger's own entry events when the exit row does
    // not carry one. Reading them is a second pass over the same file and only happens
    // for the one trade being opened.
    const opening = trade.openedAt ? null : replay.openingFor(row, readEvents('entry', undefined, uid).concat(exits));
    const openedAt = trade.openedAt || (opening && opening.at) || null;
    const span = replay.spanFor({ ts: trade.ts, openedAt }, opening);
    if (!span) { _json(res, 422, { error: 'untimed_trade' }); return true; }

    const wantTf = replay.pickTf(Date.parse(openedAt || trade.ts), Date.parse(trade.ts)).tf;
    const forTrade = Object.assign({}, row, trade, { openedAt });

    // 1) Our own archive. Free, instant, and the bars this machine actually saw.
    const arch = barWindow.bestWindow(trade.symbol, wantTf, span.from, span.to);
    let out = replay.assemble({
      trade: forTrade, opening, bars: arch.bars, held: arch.held, barsTf: arch.tf, source: 'archive',
    });
    if (out.coverage === 'full') { _json(res, 200, out); return true; }

    // 2) Live, for the symbols we do not watch — which is most of a reader's own book.
    // Only ever reached on a miss, and only for the trade actually opened.
    if (process.env.JOURNAL_REPLAY_LIVE === '0') { _json(res, 200, out); return true; }
    let live = null;
    try {
      const yahoo = require('../lib/market-data-yahoo');
      live = await yahoo.getBarsWindow(trade.symbol, wantTf, span.from, span.to);
    } catch (_e) { live = null; }

    if (live && live.bars && live.bars.length) {
      const bars = live.bars.map((b) => ({
        t: Date.parse(b.timestamp), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
      })).filter((b) => Number.isFinite(b.t));
      const fromLive = replay.assemble({
        trade: forTrade, opening, bars,
        held: bars.length ? { count: bars.length, first: bars[0].t, last: bars[bars.length - 1].t } : null,
        barsTf: wantTf, source: 'live',
      });
      // Keep whichever actually covers the trade. A partial archive beats a partial live
      // window only when it holds more of the trade, so compare rather than prefer.
      const rank = { none: 0, partial: 1, full: 2 };
      if (rank[fromLive.coverage] > rank[out.coverage]) out = fromLive;
    } else if (out.coverage === 'none') {
      // We tried the network and it had nothing either. Re-derive the message so it says
      // that, rather than blaming an archive that was never going to hold this symbol.
      out = replay.assemble({
        trade: forTrade, opening, bars: [], held: null, barsTf: wantTf, source: 'live',
      });
    }

    _json(res, 200, out);
  } catch (e) {
    _json(res, 500, { error: 'replay_failed', message: e.message });
  }
  return true;
};
module.exports.PATH = PATH;
