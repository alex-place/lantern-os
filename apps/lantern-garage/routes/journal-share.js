'use strict';
/**
 * routes/journal-share.js — the owner's side of sharing (#3562).
 *
 * Loop stage: Act. The only surface in this journal that publishes a reader's money to
 * the internet, so every route here is deliberate and narrow.
 *
 *   GET    /api/journal/share/options              what this record can support
 *   GET    /api/journal/share/preview?kind=…       exactly what would be public. Publishes nothing.
 *   POST   /api/journal/share  {kind, month, dollars}   publish, and return the link
 *   GET    /api/journal/shares                     the reader's own shares
 *   DELETE /api/journal/share?id=…                 take one down
 *
 * PREVIEW IS A GET AND PUBLISH IS A POST. Not decoration: the reader must be able to see
 * the real payload — the same function, the same figures — without that act putting
 * anything on the internet. A preview that went through the publish path "and then
 * deleted it" would have a window where it was live.
 *
 * THE SERVER COMPUTES THE CARD. The client names a kind and its options; it never posts
 * figures. A shared page therefore carries the reader's actual record rather than
 * whatever their browser claimed, which is the point when the page carries our name.
 *
 * NOTHING IS PUBLIC BY DEFAULT and every share is one explicit action. Dollars are opt-in
 * per share (lib/share-card.js), and notes and tags cannot be shared at all.
 */

const shareCard = require('../lib/share-card');
const store = require('../lib/share-store');
const { readExits, breakdown, computeScorecard, slimStats, etParts, CONFIRMED } = require('../lib/trader-scorecard');
const { buildTrackRecord } = require('../lib/track-record');
const { getEffectiveUserId } = require('../lib/session-identity');
const { internalUserId } = require('../lib/request-auth');

const PREFIX = '/api/journal/share';
const LIST = '/api/journal/shares';

function _json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readerId(req) {
  const id = getEffectiveUserId(req) || internalUserId(req);
  if (id) return id;
  try { return require('../lib/auth-middleware').loginGateEnabled() ? null : 'local-owner'; } catch (_e) { return null; }
}

/**
 * The same ADMIN-ONLY, only-when-empty operator fallback the scorecard and the trade log
 * use. It belongs here for consistency rather than convenience: the journal shows the
 * operator the house book, and a Share button that published a different (empty) book
 * from the one on screen would be the worst kind of surprise on this particular feature.
 * A reader who can see a card can share that card, and no one else's.
 */
function operatorFallbackUid(req, hadRows) {
  if (hadRows) return null;
  let admin = false;
  try { admin = require('../lib/auth-middleware').isAdmin(req); } catch (_e) { admin = false; }
  if (!admin) return null;
  return process.env.TRADER_OPERATOR_UID || 'local-owner';
}

/** Who this request's cards are drawn from — resolved once, and used for every branch. */
function bookFor(req, userId) {
  const mine = readExits(undefined, userId);
  const alt = operatorFallbackUid(req, mine.length > 0);
  return alt || userId;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n <= limit) parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (_e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/**
 * Everything a shared card can be built from, read from the reader's OWN ledger.
 *
 * Confirmed fills only — the same honesty split the journal's headline figures use. A
 * shared page is the one place a soft number would travel furthest, so it gets the
 * stricter of the two views and says so.
 */
function gather(userId) {
  const exits = readExits(undefined, userId).filter((r) => CONFIRMED.has(String(r.status || '').toLowerCase()));
  let days = [];
  try {
    const book = Object.values((buildTrackRecord(undefined, userId) || {}).books || {})[0];
    days = (book && book.daily) || [];
  } catch (_e) { days = []; }

  // ET months, because the day series is built on exchange days — a UTC month would put
  // a 16:30 ET exit on the last of the month into the next one.
  const byMonth = new Map();
  for (const e of exits) {
    const p = etParts(e.ts);
    if (!p) continue;
    const m = p.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(e);
  }
  const monthStats = {};
  for (const [m, rows] of byMonth) monthStats[m] = slimStats(computeScorecard(rows));

  return {
    rdist: breakdown('r', undefined, userId).confirmed,
    bySymbol: breakdown('symbol', undefined, userId).confirmed,
    days,
    monthStats,
  };
}

/** Which cards this record can actually support, so the UI offers real choices. */
function optionsFor(src) {
  const months = [...new Set((src.days || []).map((d) => String(d.date || '').slice(0, 7)))]
    .filter(Boolean).sort().reverse();
  return {
    months,
    kinds: shareCard.KINDS.filter((k) => {
      if (k === 'month') return months.length > 0;
      return !!shareCard.build(k, src, { dollars: false });
    }),
    // Stated so the UI does not have to know it: the R card has no money in it, so
    // there is nothing for its dollars switch to withhold.
    moneyless: ['rmultiples'],
    limit: store.MAX_PER_OWNER,
  };
}

function buildOne(src, opts) {
  const built = shareCard.build(String(opts.kind || ''), src, {
    month: opts.month, dollars: opts.dollars === true || opts.dollars === '1' || opts.dollars === 'true',
  });
  return built ? shareCard.envelope(built) : null;
}

module.exports = async function journalShareRoutes(req, res, url) {
  const p = url.pathname;
  if (p !== LIST && p !== PREFIX && p !== PREFIX + '/options' && p !== PREFIX + '/preview') return false;

  const userId = readerId(req);
  if (!userId) { _json(res, 401, { error: 'not_signed_in' }); return true; }

  try {
    // The book the cards are DRAWN from; `userId` stays the one who OWNS any share
    // made, so an operator's shares are still their own to list and revoke.
    const bookId = bookFor(req, userId);

    if (p === PREFIX + '/options' && req.method === 'GET') {
      _json(res, 200, optionsFor(gather(bookId)));
      return true;
    }

    if (p === PREFIX + '/preview' && req.method === 'GET') {
      const q = url.searchParams;
      const payload = buildOne(gather(bookId), {
        kind: q.get('kind'), month: q.get('month'), dollars: q.get('dollars'),
      });
      if (!payload) { _json(res, 422, { error: 'nothing_to_share' }); return true; }
      // Explicit, because the whole value of this endpoint is that it did not publish.
      _json(res, 200, { published: false, payload });
      return true;
    }

    if (p === LIST && req.method === 'GET') {
      _json(res, 200, { shares: store.listFor(userId), limit: store.MAX_PER_OWNER });
      return true;
    }

    if (p === PREFIX && req.method === 'POST') {
      const body = await readBody(req);
      const payload = buildOne(gather(bookId), body);
      if (!payload) { _json(res, 422, { error: 'nothing_to_share' }); return true; }
      let rec;
      try { rec = store.create(userId, payload); } catch (e) {
        if (e && e.code === 'share_limit') { _json(res, 429, { error: 'share_limit', limit: e.limit }); return true; }
        throw e;
      }
      _json(res, 201, { id: rec.id, url: '/s/' + rec.id, createdAt: rec.createdAt, payload });
      return true;
    }

    if (p === PREFIX && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      // Once. Called twice, the second attempt finds the file already gone and reports
      // 404 on a revoke that worked.
      const gone = store.revoke(userId, id);
      // A share that is not this reader's reports the same "not found" as one that does
      // not exist — anything else would confirm that somebody else's exists.
      _json(res, gone ? 200 : 404, gone ? { revoked: id } : { error: 'no_such_share' });
      return true;
    }

    _json(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    _json(res, 500, { error: 'share_failed', message: e.message });
  }
  return true;
};
module.exports.gather = gather;
module.exports.optionsFor = optionsFor;
